// Shared by the browser (src/registry.ts) and the dev server (vite.config.ts),
// so this file must stay free of imports and of import.meta.env.

/** Mint accepts one anchor image plus five more references. */
export const MAX_WORLD_PHOTOS = 6;

export interface WorldPhotoSource {
  /** The anchor photo. Kept for entries written before multi-photo worlds. */
  sourceImage?: string;
  /** Every photo, anchor first. */
  sourceImages?: string[];
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").trim();
}

/**
 * The world's photos as ordered `uploads/...` paths, anchor first.
 * Callers never branch on which of the two fields an entry carries.
 */
export function worldPhotos(entry: WorldPhotoSource | undefined): string[] {
  if (!entry) return [];
  const raw = Array.isArray(entry.sourceImages)
    ? entry.sourceImages
    : entry.sourceImage
      ? [entry.sourceImage]
      : [];
  const seen = new Set<string>();
  const photos: string[] = [];
  raw.forEach((value) => {
    if (typeof value !== "string") return;
    const path = normalizePath(value);
    if (!path || seen.has(path)) return;
    seen.add(path);
    photos.push(path);
  });
  return photos;
}

/** Strip the uploads prefix so "uploads/a.jpg", "./uploads/a.jpg" and "a.jpg" compare equal. */
export function uploadNameOf(sourceImage?: string): string | undefined {
  if (!sourceImage) return undefined;
  const name = normalizePath(sourceImage).replace(/^\.?\/?uploads\//, "");
  return name || undefined;
}

/** The upload file names for a world, anchor first. */
export function worldPhotoNames(entry: WorldPhotoSource | undefined): string[] {
  return worldPhotos(entry)
    .map((photo) => uploadNameOf(photo))
    .filter((name): name is string => Boolean(name));
}
