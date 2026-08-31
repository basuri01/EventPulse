import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/authz";

/** Short-lived URL the browser POSTs the file to. Signed-in callers only. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const getFileUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.storage.getUrl(args.storageId);
  },
});
