import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireMembership, requireRole } from "./lib/authz";
import { PRIORITY_ORDER, clampPercent, inferLocation } from "./lib/geo";
import { priorityValidator } from "./schema";

const MODERATORS = ["ORGANIZER", "STAFF"] as const;
const MAX_REPORTS = 200;
const MAX_DESCRIPTION = 1000;

/**
 * Stored as the location of a report on a custom uploaded floor plan, where we
 * have no zone names to give. Deliberately neutral: it says only what we know
 * for certain -- that the reporter dropped a pin -- and implies no real place.
 * Occupies the same slot as a zone name, so cards lay out identically.
 */
const NO_ZONE = "Pinned on map";

/** The state machine. `resolved` is a flag, so a resolved report reads as "resolved". */
type ReportState = "pending" | "approved" | "rejected" | "resolved";
const LEGAL_TRANSITIONS: Record<ReportState, ReportState[]> = {
  pending: ["approved", "rejected"],
  approved: ["resolved"],
  rejected: [],
  resolved: [],
};

function stateOf(report: Doc<"reports">): ReportState {
  return report.resolved ? "resolved" : report.status;
}

function assertTransition(report: Doc<"reports">, to: ReportState) {
  const from = stateOf(report);
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`A ${from} report cannot be moved to ${to}.`);
  }
}

/** Names and trust scores for the reporters in a page of reports. */
async function reporterIndex(ctx: QueryCtx, eventId: Id<"events">, reports: Doc<"reports">[]) {
  const index = new Map<
    Id<"users">,
    { name: string; trustScore: number; banned: boolean }
  >();
  for (const report of reports) {
    if (index.has(report.reporterId)) continue;
    const [user, membership] = await Promise.all([
      ctx.db.get("users", report.reporterId),
      ctx.db
        .query("memberships")
        .withIndex("by_event_user", (q) => q.eq("eventId", eventId).eq("userId", report.reporterId))
        .unique(),
    ]);
    index.set(report.reporterId, {
      name: user?.name ?? user?.email ?? "Unknown",
      trustScore: membership?.trustScore ?? 60,
      banned: membership?.isBanned ?? false,
    });
  }
  return index;
}

function shape(report: Doc<"reports">, who: { name: string; trustScore: number; banned: boolean }, callerId: Id<"users">) {
  return {
    id: report._id,
    author: who.name,
    authorTrustScore: who.trustScore,
    banned: who.banned,
    location: report.location,
    description: report.description,
    createdAt: report.createdAt,
    status: report.status,
    resolved: report.resolved,
    priority: report.priority,
    pinX: report.pinX,
    pinY: report.pinY,
    views: report.views,
    officialStatement: report.officialStatement,
    isMine: report.reporterId === callerId,
    reviewedByMe: report.reviewedBy === callerId,
    reviewedAt: report.reviewedAt,
  };
}

async function loadForModeration(ctx: MutationCtx, reportId: Id<"reports">) {
  const report = await ctx.db.get("reports", reportId);
  if (report === null) throw new Error("That report no longer exists.");
  const moderator = await requireRole(ctx, report.eventId, MODERATORS);
  return { report, moderator };
}

export const create = mutation({
  args: {
    eventId: v.id("events"),
    clientId: v.string(),
    description: v.string(),
    pinX: v.number(),
    pinY: v.number(),
  },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.eventId);

    // Idempotency: the client mints one UUID per submission and retries with it,
    // so a double-tap or a retried mutation returns the first report, not a copy.
    const existing = await ctx.db
      .query("reports")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (existing !== null) {
      if (existing.reporterId !== membership.userId || existing.eventId !== args.eventId) {
        throw new Error("That report id is already in use.");
      }
      return existing._id;
    }

    const description = args.description.trim();
    if (!description) throw new Error("Describe the issue before submitting.");
    if (description.length > MAX_DESCRIPTION) throw new Error("That description is too long.");

    const pinX = clampPercent(args.pinX, "pinX");
    const pinY = clampPercent(args.pinY, "pinY");

    // Zone names come from the bundled IIT Delhi campus map only. An event with
    // a custom uploaded floor plan has no zones we can name, so we name none --
    // a confident "IRD Hostel" on a shopping-mall plan is worse than no label.
    // pinX/pinY are exact either way, so the marker is unaffected.
    const event = await ctx.db.get("events", args.eventId);
    if (event === null) throw new Error("That event no longer exists.");
    const location = event.mapStorageId === undefined ? inferLocation(pinX, pinY) : NO_ZONE;

    // Trusted reporters and event staff skip the moderation queue.
    const autoApprove =
      membership.role === "STAFF" || membership.role === "ORGANIZER" || membership.trustScore > 90;

    return await ctx.db.insert("reports", {
      eventId: args.eventId,
      reporterId: membership.userId,
      description,
      location,
      pinX,
      pinY,
      status: autoApprove ? "approved" : "pending",
      views: 0,
      resolved: false,
      clientId: args.clientId,
      createdAt: Date.now(),
    });
  },
});

/**
 * Reports visible to the caller in this event. Rejected reports and reports by
 * banned reporters are hidden from attendees — but a reporter always sees their
 * own, so "My Reports" can show them their own rejection.
 */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.eventId);
    const isModerator = membership.role === "ORGANIZER" || membership.role === "STAFF";

    const reports = await ctx.db
      .query("reports")
      .withIndex("by_event_created", (q) => q.eq("eventId", args.eventId))
      .order("desc")
      .take(MAX_REPORTS);

    const index = await reporterIndex(ctx, args.eventId, reports);
    const visible = [];
    for (const report of reports) {
      const who = index.get(report.reporterId)!;
      const mine = report.reporterId === membership.userId;
      if (!isModerator && !mine && (report.status === "rejected" || who.banned)) continue;
      visible.push(shape(report, who, membership.userId));
    }
    return visible;
  },
});

/** Every report in the event, critical first. Moderators only. */
export const listForStaff = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    const membership = await requireRole(ctx, args.eventId, MODERATORS);

    const reports = await ctx.db
      .query("reports")
      .withIndex("by_event_created", (q) => q.eq("eventId", args.eventId))
      .order("desc")
      .take(MAX_REPORTS);

    const index = await reporterIndex(ctx, args.eventId, reports);
    // Already newest-first; a stable sort by priority keeps that as the tiebreak.
    return reports
      .map((report) => shape(report, index.get(report.reporterId)!, membership.userId))
      .sort((a, b) => (PRIORITY_ORDER[a.priority ?? "low"] ?? 3) - (PRIORITY_ORDER[b.priority ?? "low"] ?? 3));
  },
});

export const updateStatus = mutation({
  args: {
    reportId: v.id("reports"),
    status: v.union(v.literal("approved"), v.literal("rejected"), v.literal("resolved")),
  },
  handler: async (ctx, args) => {
    const { report, moderator } = await loadForModeration(ctx, args.reportId);
    assertTransition(report, args.status);

    if (args.status === "resolved") {
      await ctx.db.patch("reports", report._id, { resolved: true });
      return null;
    }

    await ctx.db.patch("reports", report._id, {
      status: args.status,
      reviewedBy: moderator.userId,
      reviewedAt: Date.now(),
    });

    if (args.status === "approved") {
      const reporter = await ctx.db
        .query("memberships")
        .withIndex("by_event_user", (q) =>
          q.eq("eventId", report.eventId).eq("userId", report.reporterId),
        )
        .unique();
      if (reporter !== null) {
        await ctx.db.patch("memberships", reporter._id, {
          trustScore: Math.min(100, reporter.trustScore + 5),
        });
      }
    }
    return null;
  },
});

export const setPriority = mutation({
  args: { reportId: v.id("reports"), priority: priorityValidator },
  handler: async (ctx, args) => {
    const { report } = await loadForModeration(ctx, args.reportId);
    await ctx.db.patch("reports", report._id, { priority: args.priority });
    return null;
  },
});

/**
 * Mark critical and attach the statement broadcast to attendees. A pending
 * report is approved in the same step — that is the legal pending -> approved
 * transition. A rejected report cannot be resurrected this way.
 */
export const setCritical = mutation({
  args: { reportId: v.id("reports"), statement: v.string() },
  handler: async (ctx, args) => {
    const { report, moderator } = await loadForModeration(ctx, args.reportId);
    const statement = args.statement.trim();
    if (!statement) throw new Error("An official statement is required.");
    if (statement.length > MAX_DESCRIPTION) throw new Error("That statement is too long.");

    const state = stateOf(report);
    if (state === "rejected" || state === "resolved") {
      throw new Error(`A ${state} report cannot be marked critical.`);
    }

    await ctx.db.patch("reports", report._id, {
      priority: "critical",
      officialStatement: statement,
      status: "approved",
      reviewedBy: moderator.userId,
      reviewedAt: Date.now(),
    });
    return null;
  },
});

/** One view per member per report — the client keeps the "Seen" state. */
export const markViewed = mutation({
  args: { reportId: v.id("reports") },
  handler: async (ctx, args) => {
    const report = await ctx.db.get("reports", args.reportId);
    if (report === null) throw new Error("That report no longer exists.");
    await requireMembership(ctx, report.eventId);
    await ctx.db.patch("reports", report._id, { views: report.views + 1 });
    return null;
  },
});

/** Ban the reporter from the event and reject the report that prompted it. */
export const banReporter = mutation({
  args: { reportId: v.id("reports") },
  handler: async (ctx, args) => {
    const { report, moderator } = await loadForModeration(ctx, args.reportId);
    if (report.reporterId === moderator.userId) throw new Error("You cannot ban yourself.");

    const reporter = await ctx.db
      .query("memberships")
      .withIndex("by_event_user", (q) =>
        q.eq("eventId", report.eventId).eq("userId", report.reporterId),
      )
      .unique();
    if (reporter === null) throw new Error("That reporter is no longer in this event.");
    if (reporter.role === "ORGANIZER") throw new Error("The organizer cannot be banned.");

    await ctx.db.patch("memberships", reporter._id, { isBanned: true });
    if (stateOf(report) === "pending") {
      await ctx.db.patch("reports", report._id, {
        status: "rejected",
        reviewedBy: moderator.userId,
        reviewedAt: Date.now(),
      });
    }
    return null;
  },
});
