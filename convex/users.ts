import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/authz";

const MAX_NAME_LENGTH = 60;

/**
 * The signed-in user, or null. Returns null rather than throwing so that a
 * sign-out in flight degrades to the login screen instead of an error.
 */
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    return { _id: user._id, name: user.name ?? null, email: user.email ?? null, image: user.image ?? null };
  },
});

/**
 * Change the caller's OWN display name. There is no user argument, so it can
 * only ever touch the signed-in user. Email comes from Google and is not
 * editable.
 */
export const updateName = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const name = args.name.trim().replace(/\s+/g, " ");
    if (!name) throw new Error("Name is required.");
    if (name.length > MAX_NAME_LENGTH) throw new Error(`Name must be ${MAX_NAME_LENGTH} characters or fewer.`);
    await ctx.db.patch("users", userId, { name });
    return null;
  },
});
