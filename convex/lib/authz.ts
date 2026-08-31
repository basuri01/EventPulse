import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type Role = Doc<"memberships">["role"];

type Ctx = QueryCtx | MutationCtx;

/** The signed-in user's id. Throws if the caller is not authenticated. */
export async function requireUser(ctx: Ctx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("You need to be signed in to do that.");
  return userId;
}

/**
 * The caller's membership in `eventId`. Throws if they are not a member or have
 * been banned. This — not anything the client sends — is the source of role.
 */
export async function requireMembership(
  ctx: Ctx,
  eventId: Id<"events">,
): Promise<Doc<"memberships">> {
  const userId = await requireUser(ctx);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_event_user", (q) => q.eq("eventId", eventId).eq("userId", userId))
    .unique();
  if (membership === null) throw new Error("You are not part of this event.");
  if (membership.isBanned) throw new Error("You have been removed from this event.");
  return membership;
}

/** As `requireMembership`, and additionally that the role is one of `roles`. */
export async function requireRole(
  ctx: Ctx,
  eventId: Id<"events">,
  roles: readonly Role[],
): Promise<Doc<"memberships">> {
  const membership = await requireMembership(ctx, eventId);
  if (!roles.includes(membership.role)) {
    throw new Error("You do not have permission to do that.");
  }
  return membership;
}
