import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { requireMembership, requireRole, requireUser } from "./lib/authz";

/** Crockford-ish: no 0/O/1/I/L, so a code read aloud or off a screen is unambiguous. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ATTENDEE_CODE_LENGTH = 6;
const STAFF_CODE_LENGTH = 8;
const MAX_MAP_BYTES = 5 * 1024 * 1024;

function randomCode(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

async function codeIsTaken(ctx: MutationCtx, code: string): Promise<boolean> {
  const asAttendee = await ctx.db
    .query("events")
    .withIndex("by_attendeeCode", (q) => q.eq("attendeeCode", code))
    .first();
  if (asAttendee !== null) return true;
  const asStaff = await ctx.db
    .query("events")
    .withIndex("by_staffCode", (q) => q.eq("staffCode", code))
    .first();
  return asStaff !== null;
}

/**
 * A code unique across BOTH columns, so `joinByCode` can never be ambiguous.
 * `taken` carries codes minted earlier in this same transaction, which are not
 * yet visible to the index.
 */
async function mintCode(ctx: MutationCtx, length: number, taken: string[]): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const code = randomCode(length);
    if (taken.includes(code)) continue;
    if (await codeIsTaken(ctx, code)) continue;
    return code;
  }
  throw new Error("Could not generate a unique code. Please try again.");
}

export const create = mutation({
  args: { name: v.string(), venue: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const name = args.name.trim();
    const venue = args.venue.trim();
    const date = args.date.trim();
    if (!name) throw new Error("Event name is required.");
    if (!venue) throw new Error("Venue is required.");
    if (!date) throw new Error("Date is required.");

    const attendeeCode = await mintCode(ctx, ATTENDEE_CODE_LENGTH, []);
    const staffCode = await mintCode(ctx, STAFF_CODE_LENGTH, [attendeeCode]);

    const now = Date.now();
    const eventId = await ctx.db.insert("events", {
      name,
      venue,
      date,
      organizerId: userId,
      attendeeCode,
      staffCode,
      isActive: true,
      createdAt: now,
    });

    // The creator is the organizer. Role is written here, server-side, once.
    await ctx.db.insert("memberships", {
      eventId,
      userId,
      role: "ORGANIZER",
      isBanned: false,
      trustScore: 100,
      joinedAt: now,
    });

    return { eventId, attendeeCode, staffCode };
  },
});

export const joinByCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const code = args.code.trim().toUpperCase();
    if (!code) throw new Error("Enter a code to join.");

    let event: Doc<"events"> | null = await ctx.db
      .query("events")
      .withIndex("by_attendeeCode", (q) => q.eq("attendeeCode", code))
      .unique();
    let role: "ATTENDEE" | "STAFF" = "ATTENDEE";

    if (event === null) {
      event = await ctx.db
        .query("events")
        .withIndex("by_staffCode", (q) => q.eq("staffCode", code))
        .unique();
      role = "STAFF";
    }

    // No membership is created on a bad code — we throw before any insert.
    if (event === null) throw new Error("That code doesn't match any event.");
    if (!event.isActive) throw new Error("That event is no longer active.");
    const eventId = event._id;

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_event_user", (q) => q.eq("eventId", eventId).eq("userId", userId))
      .unique();
    if (existing !== null) {
      if (existing.isBanned) throw new Error("You have been removed from this event.");
      // Rejoin: hand back what they already have rather than duplicating it.
      return { eventId, role: existing.role, eventName: event.name, rejoined: true };
    }

    await ctx.db.insert("memberships", {
      eventId,
      userId,
      role,
      isBanned: false,
      trustScore: 60,
      joinedAt: Date.now(),
    });

    return { eventId, role, eventName: event.name, rejoined: false };
  },
});

/**
 * Event detail for a member. The attendee code is organizer-visible (they share
 * it); the staff code never leaves the organizer.
 */
export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.eventId);
    const event = await ctx.db.get("events", args.eventId);
    if (event === null) return null;
    const isOrganizer = membership.role === "ORGANIZER";
    return {
      _id: event._id,
      name: event.name,
      venue: event.venue,
      date: event.date,
      isActive: event.isActive,
      mapWidth: event.mapWidth ?? null,
      mapHeight: event.mapHeight ?? null,
      mapUrl: event.mapStorageId ? await ctx.storage.getUrl(event.mapStorageId) : null,
      attendeeCode: isOrganizer ? event.attendeeCode : null,
      staffCode: isOrganizer ? event.staffCode : null,
      role: membership.role,
    };
  },
});

export const updateFloorMap = mutation({
  args: {
    eventId: v.id("events"),
    storageId: v.id("_storage"),
    width: v.number(),
    height: v.number(),
  },
  handler: async (ctx, args) => {
    // ORGANIZER only — enforced here, not by hiding a button.
    await requireRole(ctx, args.eventId, ["ORGANIZER"]);

    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (metadata === null) throw new Error("That upload could not be found.");
    if (!metadata.contentType?.startsWith("image/")) {
      await ctx.storage.delete(args.storageId);
      throw new Error("The floor plan must be an image.");
    }
    if (metadata.size > MAX_MAP_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new Error("The floor plan must be 5 MB or smaller.");
    }
    if (!Number.isFinite(args.width) || !Number.isFinite(args.height) || args.width <= 0 || args.height <= 0) {
      await ctx.storage.delete(args.storageId);
      throw new Error("Could not read the floor plan's dimensions.");
    }

    const event = await ctx.db.get("events", args.eventId);
    if (event === null) throw new Error("Event not found.");
    const previous: Id<"_storage"> | undefined = event.mapStorageId;

    // Point the event at the new file FIRST, so a failure here can never leave
    // the event referencing a file we already deleted.
    await ctx.db.patch("events", args.eventId, {
      mapStorageId: args.storageId,
      mapWidth: args.width,
      mapHeight: args.height,
    });

    if (previous !== undefined && previous !== args.storageId) {
      await ctx.storage.delete(previous);
    }
    return null;
  },
});
