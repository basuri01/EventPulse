import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Role lives on the membership document — never on the client, never on the user. */
export const roleValidator = v.union(
  v.literal("ORGANIZER"),
  v.literal("STAFF"),
  v.literal("ATTENDEE"),
);

export const reportStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);

export const priorityValidator = v.union(
  v.literal("critical"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
);

export default defineSchema({
  // Convex Auth owns `users`, `authAccounts`, `authSessions`, … — extend, never duplicate.
  ...authTables,

  events: defineTable({
    name: v.string(),
    venue: v.string(),
    date: v.string(),
    organizerId: v.id("users"),
    attendeeCode: v.string(),
    staffCode: v.string(),
    mapStorageId: v.optional(v.id("_storage")),
    mapWidth: v.optional(v.number()),
    mapHeight: v.optional(v.number()),
    isActive: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_attendeeCode", ["attendeeCode"])
    .index("by_staffCode", ["staffCode"])
    .index("by_organizer", ["organizerId"]),

  memberships: defineTable({
    eventId: v.id("events"),
    userId: v.id("users"),
    role: roleValidator,
    isBanned: v.boolean(),
    trustScore: v.number(),
    joinedAt: v.number(),
  })
    .index("by_event_user", ["eventId", "userId"])
    .index("by_user", ["userId"]),

  reports: defineTable({
    eventId: v.id("events"),
    reporterId: v.id("users"),
    description: v.string(),
    location: v.string(),
    // Percentages 0-100 of the floor-map extent. Never 0-1.
    pinX: v.number(),
    pinY: v.number(),
    status: reportStatusValidator,
    // Absent until a moderator sets one — a brand-new report shows no chip,
    // exactly as the reference UI renders it.
    priority: v.optional(priorityValidator),
    views: v.number(),
    resolved: v.boolean(),
    officialStatement: v.optional(v.string()),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    clientId: v.string(),
    createdAt: v.number(),
  })
    .index("by_event_created", ["eventId", "createdAt"])
    .index("by_clientId", ["clientId"]),

  mapPins: defineTable({
    eventId: v.id("events"),
    emoji: v.string(),
    label: v.string(),
    // Percentages 0-100, same convention as reports.
    x: v.number(),
    y: v.number(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_event", ["eventId"]),
});
