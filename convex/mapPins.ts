import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMembership, requireRole } from "./lib/authz";
import { clampPercent } from "./lib/geo";

const MODERATORS = ["ORGANIZER", "STAFF"] as const;
const MAX_PINS = 200;

export const create = mutation({
  args: {
    eventId: v.id("events"),
    emoji: v.string(),
    label: v.string(),
    x: v.number(),
    y: v.number(),
  },
  handler: async (ctx, args) => {
    const membership = await requireRole(ctx, args.eventId, MODERATORS);
    const label = args.label.trim();
    const emoji = args.emoji.trim();
    if (!label) throw new Error("A point of interest needs a label.");
    if (label.length > 60) throw new Error("That label is too long.");
    if (!emoji) throw new Error("Pick an emoji for this point of interest.");

    return await ctx.db.insert("mapPins", {
      eventId: args.eventId,
      emoji,
      label,
      x: clampPercent(args.x, "x"),
      y: clampPercent(args.y, "y"),
      createdBy: membership.userId,
      createdAt: Date.now(),
    });
  },
});

export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.eventId);
    const pins = await ctx.db
      .query("mapPins")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .take(MAX_PINS);
    return pins.map((pin) => ({
      id: pin._id,
      emoji: pin.emoji,
      label: pin.label,
      x: pin.x,
      y: pin.y,
    }));
  },
});

export const remove = mutation({
  args: { pinId: v.id("mapPins") },
  handler: async (ctx, args) => {
    const pin = await ctx.db.get("mapPins", args.pinId);
    if (pin === null) return null;
    await requireRole(ctx, pin.eventId, MODERATORS);
    await ctx.db.delete("mapPins", pin._id);
    return null;
  },
});
