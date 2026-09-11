import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";

/**
 * The one public function. Anyone with the site open subscribes to this and
 * is pushed the new list the moment a row changes. Everything that writes is
 * internal: callable from the CLI as the owner, never from a browser.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("worlds").collect();
    rows.sort((a, b) => a.order - b.order);
    return Promise.all(
      rows.map(async (row) => ({
        key: row.key,
        title: row.title,
        thumbnailUrl: row.thumbnailStorageId
          ? await ctx.storage.getUrl(row.thumbnailStorageId)
          : null,
        spawnFacing: row.spawnFacing,
        runtimeUrl: row.runtimeUrl,
        colliderUrl: row.colliderUrl,
      })),
    );
  },
});

/** Every row as stored, so the publish script can diff before writing. */
export const snapshot = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("worlds").collect(),
});

export const generateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

const rowFields = {
  key: v.string(),
  title: v.string(),
  runtimeUrl: v.string(),
  colliderUrl: v.string(),
  spawnFacing: v.optional(v.number()),
  thumbnailStorageId: v.optional(v.id("_storage")),
  thumbnailHash: v.optional(v.string()),
  mintAssetId: v.string(),
  mintChatId: v.optional(v.string()),
  order: v.number(),
};

/** Insert or replace one world by key, dropping a superseded thumbnail file. */
export const upsert = internalMutation({
  args: rowFields,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("worlds")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const row = { ...args, publishedAt: Date.now() };
    if (!existing) {
      await ctx.db.insert("worlds", row);
      return "inserted";
    }
    if (
      existing.thumbnailStorageId &&
      existing.thumbnailStorageId !== args.thumbnailStorageId
    ) {
      await ctx.storage.delete(existing.thumbnailStorageId);
    }
    // replace() rather than patch(): a field the local files dropped must go too.
    await ctx.db.replace(existing._id, row);
    return "updated";
  },
});

/** Delete every world whose key is no longer in the local list. */
export const prune = internalMutation({
  args: { keep: v.array(v.string()) },
  handler: async (ctx, args) => {
    const keep = new Set(args.keep);
    const rows = await ctx.db.query("worlds").collect();
    const removed: string[] = [];
    for (const row of rows) {
      if (keep.has(row.key)) continue;
      if (row.thumbnailStorageId) await ctx.storage.delete(row.thumbnailStorageId);
      await ctx.db.delete(row._id);
      removed.push(row.key);
    }
    return removed;
  },
});
