import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/authz";

/**
 * The caller's memberships, newest first. Returns `[]` (not an error) when
 * signed out so the client can treat "no membership" and "signed out" the same.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
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
