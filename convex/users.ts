import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";

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
