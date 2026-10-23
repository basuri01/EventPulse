import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { requireMembership, requireRole, requireUser } from "./lib/authz";
import { assertEventTimes } from "./lib/time";

/** Crockford-ish: no 0/O/1/I/L, so a code read aloud or off a screen is unambiguous. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ATTENDEE_CODE_LENGTH = 6;
const STAFF_CODE_LENGTH = 8;
const MAX_MAP_BYTES = 5 * 1024 * 1024;
const MAX_DESCRIPTION_WORDS = 2000;
// ~2,000 typical words is ~12,000 characters; this leaves room for long words
// and URLs while keeping the field under ~80 KB even at 4 bytes per character.
const MAX_DESCRIPTION_CHARS = 20000;

/** Runs of non-whitespace -- the same count the create form shows. */
function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

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
  args: {
    name: v.string(),
    venue: v.string(),
    date: v.string(),
    // Optional so a client that predates multi-day events still creates
    // single-day ones. Absent or blank means the event ends on `date`.
    endDate: v.optional(v.string()),
    startTime: v.number(),
    endTime: v.number(),
    // IANA zone the organizer entered the times in, e.g. "Asia/Kolkata".
    timeZone: v.string(),
    // Optional so a client that predates descriptions still creates events.
    // Blank means none.
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const name = args.name.trim();
    const venue = args.venue.trim();
    const date = args.date.trim();
    const endDate = args.endDate?.trim() || undefined;
    const description = args.description?.trim() || undefined;
    if (!name) throw new Error("Event name is required.");
    if (!venue) throw new Error("Venue is required.");
    if (!date) throw new Error("Date is required.");
    if (description !== undefined) {
      if (description.length > MAX_DESCRIPTION_CHARS) {
        throw new Error("Description must be 20,000 characters or fewer.");
      }
      if (countWords(description) > MAX_DESCRIPTION_WORDS) {
        throw new Error("Description must be 2,000 words or fewer.");
      }
    }
    assertEventTimes({ date, endDate, startTime: args.startTime, endTime: args.endTime, timeZone: args.timeZone });

    const attendeeCode = await mintCode(ctx, ATTENDEE_CODE_LENGTH, []);
    const staffCode = await mintCode(ctx, STAFF_CODE_LENGTH, [attendeeCode]);

    const now = Date.now();
    const eventId = await ctx.db.insert("events", {
      name,
      venue,
      date,
      endDate,
      startTime: args.startTime,
      endTime: args.endTime,
      description,
      organizerId: userId,
      attendeeCode,
      staffCode,
      isActive: true,
      createdAt: now,
    });

    // The creator is the organizer. Role is written here, server-side, once.
    // Creating an event opens it, so it becomes the active event.
    await ctx.db.insert("memberships", {
      eventId,
      userId,
      role: "ORGANIZER",
      isBanned: false,
      trustScore: 100,
      joinedAt: now,
      lastOpenedAt: now,
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
      // Rejoin: hand back what they already have rather than duplicating it,
      // and make it the active event again.
      await ctx.db.patch("memberships", existing._id, { lastOpenedAt: Date.now() });
      return { eventId, role: existing.role, eventName: event.name, rejoined: true };
    }

    const now = Date.now();
    await ctx.db.insert("memberships", {
      eventId,
      userId,
      role,
      isBanned: false,
      trustScore: 60,
      joinedAt: now,
      // Joining opens the event, so it becomes the active one.
      lastOpenedAt: now,
    });

    return { eventId, role, eventName: event.name, rejoined: false };
  },
});

/**
 * Event detail for a member. Times and description go to every member. The
 * attendee code goes to organizers and staff (they share it); the staff code
 * never leaves the organizer.
 */
export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    const membership = await requireMembership(ctx, args.eventId);
    const event = await ctx.db.get("events", args.eventId);
    if (event === null) return null;
    const isOrganizer = membership.role === "ORGANIZER";
    const isModerator = isOrganizer || membership.role === "STAFF";
    return {
      _id: event._id,
      name: event.name,
      venue: event.venue,
      date: event.date,
      endDate: event.endDate ?? null,
      startTime: event.startTime ?? null,
      endTime: event.endTime ?? null,
      description: event.description ?? null,
      isActive: event.isActive,
      mapWidth: event.mapWidth ?? null,
      mapHeight: event.mapHeight ?? null,
      mapUrl: event.mapStorageId ? await ctx.storage.getUrl(event.mapStorageId) : null,
      // Staff share the attendee code too; the staff code stays organizer-only.
      attendeeCode: isModerator ? event.attendeeCode : null,
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

/** Same rules as `create`: trimmed, blank means none, 2,000 words / 20,000 chars. */
function normaliseDescription(raw: string | undefined): string | undefined {
  const description = raw?.trim() || undefined;
  if (description !== undefined) {
    if (description.length > MAX_DESCRIPTION_CHARS) throw new Error("Description must be 20,000 characters or fewer.");
    if (countWords(description) > MAX_DESCRIPTION_WORDS) throw new Error("Description must be 2,000 words or fewer.");
  }
  return description;
}

const MAX_MY_EVENTS = 50;
// Attendee counts are counted, not stored, so they are capped to keep the
// query bounded; the client shows "250+" when `attendeeCountCapped` is true.
const ATTENDEE_COUNT_CAP = 250;

/** The caller's organised events, newest first, with a bounded attendee count. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const events = await ctx.db
      .query("events")
      .withIndex("by_organizer", (q) => q.eq("organizerId", userId))
      .order("desc")
      .take(MAX_MY_EVENTS);
    const rows = [];
    for (const event of events) {
      const attendees = await ctx.db
        .query("memberships")
        .withIndex("by_event_role", (q) => q.eq("eventId", event._id).eq("role", "ATTENDEE"))
        .take(ATTENDEE_COUNT_CAP + 1);
      const active = attendees.filter((m) => !m.isBanned);
      rows.push({
        _id: event._id,
        name: event.name,
        venue: event.venue,
        date: event.date,
        endDate: event.endDate ?? null,
        startTime: event.startTime ?? null,
        endTime: event.endTime ?? null,
        isActive: event.isActive,
        attendeeCount: Math.min(active.length, ATTENDEE_COUNT_CAP),
        attendeeCountCapped: attendees.length > ATTENDEE_COUNT_CAP,
      });
    }
    return rows;
  },
});

/**
 * Edit an event's details. ORGANIZER only. Codes and the floor plan are not
 * editable here (the floor plan uses updateFloorMap). A blank endDate turns a
 * multi-day event back into a single-day one; a blank description removes it.
 */
export const update = mutation({
  args: {
    eventId: v.id("events"),
    name: v.string(),
    venue: v.string(),
    date: v.string(),
    endDate: v.optional(v.string()),
    startTime: v.number(),
    endTime: v.number(),
    timeZone: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.eventId, ["ORGANIZER"]);
    const event = await ctx.db.get("events", args.eventId);
    if (event === null) throw new Error("Event not found.");
    if (!event.isActive) throw new Error("This event has ended and can no longer be edited.");

    const name = args.name.trim();
    const venue = args.venue.trim();
    const date = args.date.trim();
    const endDate = args.endDate?.trim() || undefined;
    if (!name) throw new Error("Event name is required.");
    if (!venue) throw new Error("Venue is required.");
    if (!date) throw new Error("Date is required.");
    const description = normaliseDescription(args.description);
    assertEventTimes({ date, endDate, startTime: args.startTime, endTime: args.endTime, timeZone: args.timeZone });

    // `undefined` removes a field in a patch: that is how endDate and
    // description are cleared.
    await ctx.db.patch("events", args.eventId, {
      name, venue, date, endDate, startTime: args.startTime, endTime: args.endTime, description,
    });
    return null;
  },
});

/**
 * End an event for everyone. ORGANIZER only. Nothing is deleted: the event,
 * its members and its reports are kept; it just stops being active, so it
 * drops out of members' active events and its codes stop working.
 */
export const end = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.eventId, ["ORGANIZER"]);
    const event = await ctx.db.get("events", args.eventId);
    if (event === null) throw new Error("Event not found.");
    if (event.isActive) await ctx.db.patch("events", args.eventId, { isActive: false });
    return null;
  },
});
