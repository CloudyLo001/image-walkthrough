import * as THREE from "three";
import type { SparkRenderer } from "@sparkjsdev/spark";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { CameraPath } from "./camera-path";

/**
 * Replays a recorded camera path one frame at a time and encodes the result.
 *
 * Live, a splat world never quite catches up with the camera: each move
 * starts a new level-of-detail selection, a page fetch and a depth sort, and
 * the screen shows whatever was ready. Here every frame waits for all three to
 * finish before it is captured, at a fixed size and frame rate, so the video
 * is sharper and smoother than the flight that produced it.
 */

export const EXPORT_FPS = 30;
const KEYFRAME_EVERY = 60;
const BITRATE = 16_000_000;
/** How long one frame may wait for detail to finish streaming and sorting. */
const SETTLE_MS = 5000;
/** The first frame pays for everything the new size and viewpoint need. */
const FIRST_SETTLE_MS = 20_000;
/** Idle checks in a row before a frame counts as settled. */
const CALM_CHECKS = 3;
const POLL_MS = 10;
/** H.264 High then Main, level 4.0: 1080p30 plays everywhere an MP4 does. */
const CODECS = ["avc1.640028", "avc1.4d0028"];
const ENCODE_QUEUE_LIMIT = 4;

export interface ExportProgress {
  frame: number;
  total: number;
  /** Null until enough frames have gone by to estimate. */
  etaSeconds: number | null;
}

export interface ExportInput {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  spark: SparkRenderer;
  path: CameraPath;
  width: number;
  height: number;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
}

export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  frames: number;
  seconds: number;
}

/** 1080p in whichever orientation the screen has. */
export function outputSize(viewportWidth: number, viewportHeight: number) {
  return viewportWidth >= viewportHeight
    ? { width: 1920, height: 1080 }
    : { width: 1080, height: 1920 };
}

export function canExportVideo() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/**
 * The parts of Spark's state that say whether a viewpoint is still settling.
 * They are private fields, so each is read defensively: one that is missing
 * in a future version reads as idle rather than stalling the export.
 */
interface SparkWork {
  /** Set when a finished traversal or new pages need baking into the next frame. */
  dirty?: boolean;
  lodDirty?: boolean;
  sorting?: boolean;
  sortDirty?: boolean;
  lodUpdates?: unknown[];
  /** `queue` is null while the level-of-detail worker is idle. */
  lodWorker?: { queue?: unknown } | null;
  pager?: {
    fetchers?: unknown[];
    newUploads?: unknown[];
    readyUploads?: unknown[];
    lodTreeUpdates?: unknown[];
  } | null;
}

const count = (list?: unknown[]) => list?.length ?? 0;

/** Something is still running: a sort, a tree traversal or a page download. */
function isWorking(spark: SparkRenderer) {
  const work = spark as unknown as SparkWork;
  return (
    Boolean(work.sorting || work.sortDirty) ||
    (work.lodWorker?.queue ?? null) !== null ||
    count(work.pager?.fetchers) > 0
  );
}

/** Pages arrived, or a traversal is owed, that the selection does not yet include. */
function hasPendingPages(spark: SparkRenderer) {
  const work = spark as unknown as SparkWork;
  return (
    Boolean(work.lodDirty) ||
    count(work.lodUpdates) > 0 ||
    count(work.pager?.newUploads) > 0 ||
    count(work.pager?.readyUploads) > 0 ||
    count(work.pager?.lodTreeUpdates) > 0
  );
}

function pause(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelled";
  }
}

export function isExportCancelled(error: unknown) {
  return error instanceof ExportCancelled;
}

async function pickCodec(width: number, height: number) {
  for (const codec of CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: BITRATE,
      framerate: EXPORT_FPS,
      avc: { format: "avc" },
      latencyMode: "quality",
    };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch {
      // Not this one; try the next.
    }
  }
  throw new Error("This browser cannot encode H.264 video. Chrome or Edge can.");
}

/** Wait until no sort, traversal or download is running. */
async function waitIdle(input: ExportInput, deadline: number) {
  let calm = 0;
  while (calm < CALM_CHECKS && performance.now() < deadline) {
    if (input.signal.aborted) throw new ExportCancelled();
    await pause(POLL_MS);
    calm = isWorking(input.spark) ? 0 : calm + 1;
  }
}

/**
 * Bring the world fully up to date for the camera's current pose, then draw it.
 *
 * One update starts everything the new view needs: a detail-tree traversal on
 * the worker, downloads for pages not yet resident, and a depth sort. The
 * traversal hands its result back for the *next* update to bake in, but every
 * update also bumps the mesh version, which Spark reads as a change and
 * answers with yet another traversal. Left alone that never converges, so the
 * final bake runs with traversal driving switched off: it folds in the last
 * selection, sorts it, and starts nothing new.
 */
async function settle(input: ExportInput, maxMs: number) {
  const { spark, scene, camera, renderer, signal } = input;
  const deadline = performance.now() + maxMs;
  // Traverse and fetch until a pass brings in nothing new.
  for (;;) {
    if (signal.aborted) throw new ExportCancelled();
    spark.enableDriveLod = true;
    await spark.update({ scene, camera });
    await waitIdle(input, deadline);
    if (!hasPendingPages(spark) || performance.now() >= deadline) break;
  }
  // Bake that selection without asking for another.
  spark.enableDriveLod = false;
  await spark.update({ scene, camera });
  await waitIdle(input, deadline);
  spark.enableDriveLod = true;
  renderer.render(scene, camera);
}

export async function exportVideo(input: ExportInput): Promise<ExportResult> {
  if (!canExportVideo()) {
    throw new Error("This browser cannot encode video. Chrome or Edge can.");
  }
  const { renderer, camera, spark, path, width, height, signal, onProgress } = input;
  const config = await pickCodec(width, height);
  const total = Math.max(1, Math.ceil(path.duration * EXPORT_FPS) + 1);
  const frameMicros = Math.round(1_000_000 / EXPORT_FPS);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height, frameRate: EXPORT_FPS },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      encodeError = error;
    },
  });
  encoder.configure(config);

  // Spark normally updates itself from inside render; drive it by hand so a
  // frame is only captured once its work for this exact viewpoint is done.
  // Nothing raycasts during a render, so skip that second traversal too.
  const hadAutoUpdate = spark.autoUpdate;
  const hadDriveLod = spark.enableDriveLod;
  const hadRaycast = spark.lodRaycast;
  spark.autoUpdate = false;
  spark.lodRaycast = 0;
  const startedAt = performance.now();
  try {
    for (let frame = 0; frame < total; frame += 1) {
      if (signal.aborted) throw new ExportCancelled();
      if (encodeError) throw encodeError;
      // Let the encoder catch up first: the canvas must be read in the same
      // task that drew it, before the browser hands the buffer to the screen.
      while (encoder.encodeQueueSize > ENCODE_QUEUE_LIMIT) await pause(POLL_MS);
      path.poseAt(frame / EXPORT_FPS, camera.position, camera.quaternion);
      camera.updateMatrixWorld(true);
      await settle(input, frame === 0 ? FIRST_SETTLE_MS : SETTLE_MS);

      const videoFrame = new VideoFrame(renderer.domElement, {
        timestamp: frame * frameMicros,
        duration: frameMicros,
      });
      encoder.encode(videoFrame, { keyFrame: frame % KEYFRAME_EVERY === 0 });
      videoFrame.close();

      const done = frame + 1;
      const perFrame = (performance.now() - startedAt) / done;
      onProgress({
        frame: done,
        total,
        etaSeconds: done >= 3 ? ((total - done) * perFrame) / 1000 : null,
      });
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    const buffer = muxer.target.buffer;
    return {
      blob: new Blob([buffer], { type: "video/mp4" }),
      width,
      height,
      frames: total,
      seconds: total / EXPORT_FPS,
    };
  } finally {
    if (encoder.state !== "closed") encoder.close();
    spark.enableDriveLod = hadDriveLod;
    spark.lodRaycast = hadRaycast;
    spark.autoUpdate = hadAutoUpdate;
  }
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
}

/**
 * Hand the file to the user. Chrome offers a real save dialog; elsewhere it
 * lands in the downloads folder. Returns false if they closed the dialog.
 */
export async function saveVideo(blob: Blob, filename: string) {
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName: filename,
        types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      // Anything else: fall back to a plain download.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
