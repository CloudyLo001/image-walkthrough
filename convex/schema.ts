import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The published world list. Each row mirrors one ready world from the local
 * mint-assets.json + worlds.config.json pair; `npm run worlds:publish` keeps
 * them in step. Photos and look prompts stay local on purpose: a viewer needs
 * neither to walk the world.
 */
export default defineSchema({
  worlds: defineTable({
    key: v.string(),
    title: v.string(),
    runtimeUrl: v.string(),
    colliderUrl: v.string(),
    spawnFacing: v.optional(v.number()),
    thumbnailStorageId: v.optional(v.id("_storage")),
    /** sha256 of the webp bytes, so an unchanged thumbnail is not re-uploaded. */
    thumbnailHash: v.optional(v.string()),
    mintAssetId: v.string(),
    mintChatId: v.optional(v.string()),
    /** Position in the local list, so the public order matches the lobby. */
    order: v.number(),
    publishedAt: v.number(),
  }).index("by_key", ["key"]),
});
