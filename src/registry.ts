import registry from "../mint-assets.json";
import staticConfig from "../worlds.config.json";
import { uploadNameOf, worldPhotos, type WorldPhotoSource } from "./world-photos";

export { MAX_WORLD_PHOTOS, worldPhotoNames } from "./world-photos";

/** Strip the uploads prefix so "uploads/a.jpg" and "a.jpg" compare equal. */
export const uploadName = uploadNameOf;

export interface WorldEntry {
  key: string;
  title: string;
  thumbnailUrl?: string;
  /** The anchor photo. */
  sourceImage?: string;
  /** Every photo, anchor first. */
  sourceImages: string[];
  /** The user's own guidance on how the world should look. */
  lookPrompt?: string;
  /** Opening view in degrees, when the automatic sweep faces the wrong way. */
  spawnFacing?: number;
  runtimeUrl: string;
  colliderUrl: string;
}

export type PendingStatus =
  | "draft"
  | "requested"
  | "queued"
  | "generating"
  /** Pasted from Mint, waiting for the agent to fetch and register it. */
  | "importing"
  | "failed"
  | "cancelled";

export interface PendingWorld {
  key: string;
  title: string;
  sourceImage?: string;
  sourceImages: string[];
  lookPrompt?: string;
  status: PendingStatus;
  note?: string;
}

export interface WorldConfig extends WorldPhotoSource {
  title?: string;
  lookPrompt?: string;
  spawnFacing?: number;
  status?: PendingStatus;
  note?: string;
  /** Set on a world imported from Mint rather than built from photos here. */
  mintAssetId?: string;
  mintChatId?: string;
}

export type WorldConfigMap = Record<string, WorldConfig>;

interface RegistryAsset {
  mode?: string;
  source?: { assetId?: string };
  name?: string;
  displayName?: string;
  thumbnailUrl?: string;
  runtime?: {
    runtimeUrl?: string;
    collider?: { runtimeUrl?: string };
  };
}

const assets = (registry as { assets?: Record<string, RegistryAsset> }).assets ?? {};

/** Config bundled at build time; the dev server serves a live copy at runtime. */
export const bundledWorldConfig: WorldConfigMap =
  (staticConfig as unknown as { worlds?: WorldConfigMap }).worlds ?? {};

function humanize(key: string) {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/** Convert a project-local public path (public/assets/...) into a browser URL. */
function toBrowserUrl(localPath?: string) {
  if (!localPath) return undefined;
  const normalized = localPath.replace(/\\/g, "/");
  if (/^https?:\/\//.test(normalized)) return normalized;
  const stripped = normalized.replace(/^\.?\/?public\//, "");
  return `${import.meta.env.BASE_URL}${stripped}`.replace(/\/{2,}/g, "/");
}

/** Worlds that are fully generated and registered in mint-assets.json. */
export function listReadyWorlds(config: WorldConfigMap = bundledWorldConfig): WorldEntry[] {
  return Object.entries(assets)
    .filter(([, asset]) => asset.mode === "remote_stream")
    .map(([key, asset]) => {
      const extra = config[key] ?? {};
      const photos = worldPhotos(extra);
      return {
        key,
        title: extra.title ?? asset.displayName ?? asset.name ?? humanize(key),
        thumbnailUrl: toBrowserUrl(asset.thumbnailUrl),
        sourceImage: photos[0],
        sourceImages: photos,
        lookPrompt: extra.lookPrompt,
        spawnFacing: extra.spawnFacing,
        runtimeUrl: asset.runtime?.runtimeUrl?.trim() ?? "",
        colliderUrl: asset.runtime?.collider?.runtimeUrl?.trim() ?? "",
      };
    })
    .filter((world) => world.runtimeUrl && world.colliderUrl);
}

/** Asset ids already streaming, so an import row can retire itself. */
const registeredAssetIds = new Set(
  Object.values(assets)
    .filter((asset) => asset.mode === "remote_stream")
    .map((asset) => asset.source?.assetId)
    .filter((id): id is string => Boolean(id)),
);

/** Worlds declared in the config that are not registered yet. */
export function listPendingWorlds(config: WorldConfigMap = bundledWorldConfig): PendingWorld[] {
  return Object.entries(config)
    .filter(([key]) => assets[key]?.mode !== "remote_stream")
    // An import registered under its final key leaves the provisional row behind.
    .filter(([, extra]) => !extra.mintAssetId || !registeredAssetIds.has(extra.mintAssetId))
    .map(([key, extra]) => {
      const photos = worldPhotos(extra);
      return {
        key,
        title: extra.title ?? humanize(key),
        sourceImage: photos[0],
        sourceImages: photos,
        lookPrompt: extra.lookPrompt,
        status: extra.status ?? "queued",
        note: extra.note,
      };
    });
}

/** True while a world is queued or working, so Stop still means something. */
export function isStoppable(status: PendingStatus) {
  return status === "requested" || status === "queued" || status === "generating";
}

/** A draft is grouped but not started, so it can be broken up again. */
export function isDraft(status: PendingStatus) {
  return status === "draft";
}

/**
 * Nothing is running and nothing will be, so the entry can be deleted. An
 * import belongs here too: nothing is running on Mint, so Stop would be a lie.
 */
export function isRemovable(status: PendingStatus) {
  return (
    status === "draft" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "importing"
  );
}

/** Something outside the page will change this row, so the lobby keeps watching. */
export function isWorking(status: PendingStatus) {
  return status === "queued" || status === "generating" || status === "importing";
}
