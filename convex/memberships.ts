import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireRole, requireUser } from "./lib/authz";

/**
 * The caller's memberships, most recently OPENED first, so the first row is
 * the active event. Opening (memberships.open), creating an event and joining
 * by code all stamp lastOpenedAt to now, so whatever was just opened is first
 * whatever the page size. Memberships never opened since this field existed
 * have none and sort after every stamped one, newest-created first (the index
 * appends _creationTime), which is the old order. Returns `[]` (not an error)
 * when signed out so the client can treat "no membership" and "signed out"
 * the same.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user_lastOpenedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);

    const rows = [];
    for (const membership of memberships) {
      if (membership.isBanned) continue;
      const event = await ctx.db.get("events", membership.eventId);
      if (event === null || !event.isActive) continue;
      rows.push({
        _id: membership._id,
        eventId: membership.eventId,
        role: membership.role,
        trustScore: membership.trustScore,
        joinedAt: membership.joinedAt,
        eventName: event.name,
        eventVenue: event.venue,
        eventDate: event.date,
      });
    }
    return rows;
  },
});

export const leave = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_event_user", (q) => q.eq("eventId", args.eventId).eq("userId", userId))
      .unique();
    if (membership === null) return null;
    // An organizer leaving would orphan the event, its members and its reports.
    if (membership.role === "ORGANIZER") {
      throw new Error("An organizer cannot leave their own event.");
    }
    await ctx.db.delete("memberships", membership._id);
    return null;
  },
});

/**
 * Make `eventId` the caller's active event. Throws, rather than quietly
 * doing nothing, if the caller is not a member, has been removed, or the
 * event has ended -- none of those can become active.
 */
export const open = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_event_user", (q) => q.eq("eventId", args.eventId).eq("userId", userId))
      .unique();
    if (membership === null) throw new Error("You are not part of this event.");
    if (membership.isBanned) throw new Error("You have been removed from this event.");
    const event = await ctx.db.get("events", args.eventId);
    if (event === null) throw new Error("Event not found.");
    if (!event.isActive) throw new Error("This event has ended, so it can't be opened.");
    await ctx.db.patch("memberships", membership._id, { lastOpenedAt: Date.now() });
    return null;
  },
});

const MAX_MEMBER_ROWS = 250;

async function nameAndEmail(ctx: QueryCtx, userId: Id<"users">) {
  const user = await ctx.db.get("users", userId);
  return { name: user?.name ?? user?.email ?? "Unknown", email: user?.email ?? null };
}

/** Staff of an event with contact details. ORGANIZER only. */
export const listStaff = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.eventId, ["ORGANIZER"]);
    const staff = await ctx.db
      .query("memberships")
      .withIndex("by_event_role", (q) => q.eq("eventId", args.eventId).eq("role", "STAFF"))
      .take(MAX_MEMBER_ROWS);
    const rows = [];
    for (const m of staff) {
      if (m.isBanned) continue;
      rows.push({ membershipId: m._id, ...(await nameAndEmail(ctx, m.userId)), joinedAt: m.joinedAt });
    }
    return rows;
  },
});

/** Organizers and staff of an event, NAMES ONLY (no emails or ids). STAFF or ORGANIZER. */
export const listStaffNames = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.eventId, ["ORGANIZER", "STAFF"]);
    const rows: { name: string; role: "ORGANIZER" | "STAFF" }[] = [];
    for (const role of ["ORGANIZER", "STAFF"] as const) {
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_event_role", (q) => q.eq("eventId", args.eventId).eq("role", role))
        .take(MAX_MEMBER_ROWS);
      for (const m of members) {
        if (m.isBanned) continue;
        rows.push({ name: (await nameAndEmail(ctx, m.userId)).name, role });
      }
    }
    return rows;
  },
});

/** Remove a staff member from an event. ORGANIZER only; never an organizer. */
export const removeStaff = mutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get("memberships", args.membershipId);
    if (target === null) throw new Error("That member is no longer in this event.");
    await requireRole(ctx, target.eventId, ["ORGANIZER"]);
    if (target.role === "ORGANIZER") throw new Error("An organizer cannot be removed.");
    if (target.role !== "STAFF") throw new Error("That member is not staff.");
    await ctx.db.delete("memberships", target._id);
    return null;
  },
});

/** Attendees of an event with contact details. ORGANIZER only. Bounded. */
export const listAttendees = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.eventId, ["ORGANIZER"]);
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_event_role", (q) => q.eq("eventId", args.eventId).eq("role", "ATTENDEE"))
      .take(MAX_MEMBER_ROWS + 1);
    const rows = [];
    for (const m of members.slice(0, MAX_MEMBER_ROWS)) {
      if (m.isBanned) continue;
      rows.push({ membershipId: m._id, ...(await nameAndEmail(ctx, m.userId)), joinedAt: m.joinedAt, trustScore: m.trustScore });
    }
    return { attendees: rows, capped: members.length > MAX_MEMBER_ROWS };
  },
});

/**
 * Remove an attendee from an event. ORGANIZER only. The membership is marked
 * banned rather than deleted, so joinByCode refuses that user from then on
 * ("You have been removed from this event.") and their reports are hidden
 * from other attendees, exactly as a ban from the reports queue does.
 */
export const removeAttendee = mutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get("memberships", args.membershipId);
    if (target === null) throw new Error("That member is no longer in this event.");
    await requireRole(ctx, target.eventId, ["ORGANIZER"]);
    if (target.role !== "ATTENDEE") throw new Error("That member is not an attendee.");
    await ctx.db.patch("memberships", target._id, { isBanned: true });
    return null;
  },
});
