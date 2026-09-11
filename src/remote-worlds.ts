import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { WorldEntry } from "./registry";

/** Set at build time; absent means the site runs on the bundled list alone. */
export const remoteWorldsUrl = import.meta.env.VITE_CONVEX_URL || undefined;

/** What convex/worlds.ts `list` returns per row. */
interface RemoteRow {
  key: string;
  title: string;
  thumbnailUrl: string | null;
  spawnFacing?: number;
  runtimeUrl: string;
  colliderUrl: string;
}

// A plain reference rather than the generated api: the client then has no
// build-time dependency on convex/_generated, and the row is checked below.
const listWorlds = makeFunctionReference<"query", Record<string, never>, RemoteRow[]>(
  "worlds:list",
);

function toWorldEntry(row: RemoteRow): WorldEntry | null {
  if (!row || typeof row.key !== "string" || !row.runtimeUrl || !row.colliderUrl) return null;
  return {
    key: row.key,
    title: row.title || row.key,
    thumbnailUrl: row.thumbnailUrl ?? undefined,
    sourceImage: undefined,
    sourceImages: [],
    spawnFacing: typeof row.spawnFacing === "number" ? row.spawnFacing : undefined,
    runtimeUrl: row.runtimeUrl,
    colliderUrl: row.colliderUrl,
  };
}

/**
 * Subscribe to the published world list. The callback runs on every change
 * for as long as the page is open; it never runs while the deployment is
 * unreachable, which is what makes the bundled list a silent fallback.
 * Returns a function that stops watching.
 */
export function watchRemoteWorlds(onWorlds: (worlds: WorldEntry[]) => void): () => void {
  if (!remoteWorldsUrl) return () => {};
  let client: ConvexClient;
  try {
    client = new ConvexClient(remoteWorldsUrl, { unsavedChangesWarning: false });
  } catch (error) {
    console.warn("[worlds] remote registry disabled:", error);
    return () => {};
  }
  const unsubscribe = client.onUpdate(
    listWorlds,
    {},
    (rows) => {
      const worlds = (Array.isArray(rows) ? rows : [])
        .map(toWorldEntry)
        .filter((world): world is WorldEntry => world !== null);
      onWorlds(worlds);
    },
    (error) => console.warn("[worlds] remote registry unavailable:", error),
  );
  return () => {
    unsubscribe();
    void client.close();
  };
}
