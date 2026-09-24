import * as THREE from "three";
import { FirstPersonController } from "./first-person";
import { disposeMintGltfRuntime } from "./gltf-runtime";
import {
  bundledWorldConfig,
  isWorking,
  listPendingWorlds,
  listReadyWorlds,
  MAX_WORLD_PHOTOS,
  mergeWorlds,
  worldPhotoNames,
  type PendingWorld,
  type WorldConfigMap,
  type WorldEntry,
} from "./registry";
import {
  formatClock,
  hideExport,
  renderBatchBar,
  renderLists,
  setAuthoringAvailable,
  setHudCollapsed,
  setLookMode,
  setMoving,
  setRecording,
  setStatus,
  setUploadNote,
  showExport,
  showLobby,
  ui,
  type UploadRecord,
} from "./ui";
import { AdaptiveQuality } from "./quality";
import { CameraPath } from "./camera-path";
import { watchRemoteWorlds } from "./remote-worlds";
import {
  canExportVideo,
  EXPORT_FPS,
  exportVideo,
  isExportCancelled,
  outputSize,
  saveVideo,
  type ExportResult,
} from "./video-export";
import { MotionDetail } from "./motion-detail";
import { WorldSession } from "./world-session";

const LOOK_PROMPT_KEY = "photo-walkthrough:look-prompt";
const HUD_COLLAPSED_KEY = "photo-walkthrough:hud-collapsed";
// Render at the screen's own resolution, as Mint's viewer does. Capping this at
// one CSS pixel was the most visible part of the softness on a 1.25x laptop.
const MAX_PIXEL_RATIO = window.devicePixelRatio;
/**
 * Worlds render at Spark's defaults (full resolution, its platform splat
 * target) so they look the same here as on mint.gg. `?quality=auto` opts into
 * the frame-time controller instead, which holds 60 fps by cutting detail.
 */
const ADAPTIVE_QUALITY = new URLSearchParams(location.search).get("quality") === "auto";
/**
 * Splats to target while the camera is moving. A frame costs what it costs in
 * splats, so this is the only setting that buys frame rate worth having, and
 * it applies only in motion: stand still and the world is back at Spark's
 * default, pixel for pixel what mint.gg draws. `?detail=full` keeps the full
 * target in motion too, and `?detail=<number>` sets a different one.
 */
const DETAIL_PARAM = new URLSearchParams(location.search).get("detail");
const MOVING_SPLAT_BUDGET = (() => {
  if (DETAIL_PARAM === "full") return 0;
  const parsed = Number(DETAIL_PARAM);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900_000;
})();
/** `?stats=1` shows frame time, frame rate and the splats actually drawn. */
const SHOW_STATS = new URLSearchParams(location.search).get("stats") === "1";
const SPAWN_FACING_YAW = 0; // Looks down -Z, matching the production camera direction.
/** A longer flight would take too long to render frame by frame. */
const MAX_RECORDING_SECONDS = 120;
const MIN_RECORDING_SECONDS = 0.5;

/**
 * A small readout pinned to the corner, shown only with `?stats=1`. It is a
 * tuning instrument rather than a feature, so it is plain text and owns no
 * markup of its own beyond the one element.
 */
function createStatsReadout() {
  const element = document.createElement("div");
  element.style.cssText = [
    "position:fixed",
    "top:10px",
    "left:10px",
    "z-index:40",
    "padding:6px 10px",
    "border-radius:8px",
    "background:rgba(10,10,12,0.72)",
    "color:#e8e8ea",
    "font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
    "pointer-events:none",
    "white-space:nowrap",
  ].join(";");
  document.body.append(element);
  let shown = "";
  return {
    set(text: string) {
      if (text === shown) return;
      shown = text;
      element.textContent = text;
    },
    clear() {
      shown = "";
      element.textContent = "";
    },
  };
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(target.isContentEditable || target.closest("input, textarea, select"))
  );
}

interface Recording {
  path: CameraPath;
  startedAt: number;
  /** When the status line last showed the elapsed time. */
  shownAt: number;
}

/** Single owner of the renderer, scene, camera, frame loop, resize and world lifecycle. */
class App {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly timer = new THREE.Timer();
  private session: WorldSession | null = null;
  private controller: FirstPersonController | null = null;
  private quality: AdaptiveQuality | null = null;
  private motionDetail: MotionDetail | null = null;
  private readonly stats = SHOW_STATS ? createStatsReadout() : null;
  /** Smoothed frame time in milliseconds, for the stats readout. */
  private frameMs = 0;
  private currentWorld: WorldEntry | null = null;
  private loadAttempt = 0;
  private uploads: UploadRecord[] = [];
  private uploadsSupported = true;
  private worldConfig: WorldConfigMap = bundledWorldConfig;
  private lobbyPollTimer: number | undefined;
  private hudCollapsed = false;
  /** The published list, arriving live; empty until Convex answers or when unset. */
  private remoteWorlds: WorldEntry[] = [];
  private stopRemoteWorlds: () => void = () => {};
  /** A ?world=<key> link opens that world as soon as the list holds it. */
  private deepLinkKey: string | null = new URLSearchParams(location.search).get("world");
  /** Upload names in tick order; the first is the anchor. */
  private selection: string[] = [];
  private recording: Recording | null = null;
  /** Set while a video renders; the live loop stands aside until it is done. */
  private exportAbort: AbortController | null = null;
  private exportResult: ExportResult | null = null;

  constructor() {
    // The context is made here rather than left to three, because the flag that
    // matters for how quickly a drawn frame reaches the screen — desynchronized,
    // which lets the canvas skip waiting to be composited with the page — is not
    // in three's parameter type. A browser that refuses it leaves `context` null
    // and three makes its own, which is the behaviour this had before.
    const context = ui.canvas.getContext("webgl2", {
      antialias: false,
      powerPreference: "high-performance",
      desynchronized: true,
    });
    this.renderer = new THREE.WebGLRenderer({
      canvas: ui.canvas,
      context: context ?? undefined,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(MAX_PIXEL_RATIO);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0x0b0b0d);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.02, 2000);
    this.camera.position.set(0, 2.2, 6);
    this.resize();
    window.addEventListener("resize", () => this.resize());

    ui.canvas.addEventListener("click", () => {
      if (this.controller && !this.controller.isLocked) this.controller.lock();
    });
    ui.exit.addEventListener("click", () => this.exitWorld());
    ui.record.addEventListener("click", () => this.toggleRecording());
    // R works while the pointer is locked, when the button cannot be clicked.
    window.addEventListener("keydown", (event) => {
      if (event.code !== "KeyR" || event.repeat || isEditableTarget(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      this.toggleRecording();
    });
    ui.exportCancel.addEventListener("click", () => this.exportAbort?.abort());
    ui.exportSave.addEventListener("click", () => void this.saveExport());
    ui.exportClose.addEventListener("click", () => this.closeExport());
    ui.batchClear.addEventListener("click", () => {
      this.selection = [];
      this.renderLobby();
    });
    ui.batchGenerate.addEventListener("click", () => {
      void this.requestGeneration([...this.selection], "requested");
    });
    // Keep what the user typed across a refresh; it is easy to lose otherwise.
    try {
      ui.lookPrompt.value = localStorage.getItem(LOOK_PROMPT_KEY) ?? "";
    } catch {
      // Storage can be unavailable; the box simply starts empty.
    }
    ui.lookPrompt.addEventListener("input", () => {
      try {
        localStorage.setItem(LOOK_PROMPT_KEY, ui.lookPrompt.value);
      } catch {
        // Not being able to remember it is not worth interrupting anyone.
      }
    });
    // Someone who wants an unobstructed view usually wants it every time.
    try {
      this.hudCollapsed = localStorage.getItem(HUD_COLLAPSED_KEY) === "1";
    } catch {
      // Storage can be unavailable; the bar simply starts open.
    }
    setHudCollapsed(this.hudCollapsed);
    ui.hudToggle.addEventListener("click", () => this.toggleHud());
    ui.importAdd.addEventListener("click", () => void this.importWorld());
    ui.importInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.importWorld();
    });
    ui.retry.addEventListener("click", () => {
      if (this.currentWorld) void this.enterWorld(this.currentWorld);
    });

    this.bindUploads();
    this.renderer.setAnimationLoop(() => this.frame());
    void this.refreshLobby();
    this.renderLobby();
    this.stopRemoteWorlds = watchRemoteWorlds((worlds) => {
      this.remoteWorlds = worlds;
      this.renderLobby();
    });
  }

  /**
   * Enter the world a shared link names, once. The parameter is dropped from
   * the address so Exit lands in the lobby rather than back in the world.
   */
  private followDeepLink(readyWorlds: WorldEntry[]) {
    if (!this.deepLinkKey) return;
    const world = readyWorlds.find((entry) => entry.key === this.deepLinkKey);
    if (!world) return;
    this.deepLinkKey = null;
    const url = new URL(location.href);
    url.searchParams.delete("world");
    history.replaceState(null, "", url);
    void this.enterWorld(world);
  }

  private toggleHud() {
    this.hudCollapsed = !this.hudCollapsed;
    setHudCollapsed(this.hudCollapsed);
    try {
      localStorage.setItem(HUD_COLLAPSED_KEY, this.hudCollapsed ? "1" : "0");
    } catch {
      // Not remembering it is not worth interrupting anyone.
    }
  }

  private resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private frame() {
    this.timer.update();
    const delta = this.timer.getDelta();
    // The export draws its own frames, each once the world has settled.
    if (this.exportAbort) return;
    this.controller?.update(delta);
    if (this.session) {
      const now = performance.now();
      if (this.recording) this.sampleRecording(now);
      this.quality?.sample(delta, now);
      if (this.motionDetail && this.controller) {
        const turning = this.controller.sinceLastLook(now) < 90;
        this.motionDetail.update(now, turning || this.controller.isMoving);
      }
      this.renderer.render(this.scene, this.camera);
      if (this.stats) this.updateStats(delta);
    } else {
      this.renderer.clear();
    }
  }

  /** Frame time, frame rate and the splats behind them, for tuning by eye. */
  private updateStats(delta: number) {
    const ms = delta * 1000;
    // Smoothed, because a readout that flickers cannot be read at all.
    this.frameMs = this.frameMs === 0 ? ms : this.frameMs + (ms - this.frameMs) * 0.1;
    const splats = Math.round(this.renderer.info.render.triangles / 2);
    const detail = this.motionDetail?.isReduced ? "moving" : "full";
    this.stats?.set(
      `${this.frameMs.toFixed(1)} ms · ${Math.round(1000 / this.frameMs)} fps · ` +
        `${(splats / 1000).toFixed(0)}K splats · ${detail}`,
    );
  }

  private toggleRecording() {
    if (!this.session || this.exportAbort) return;
    if (this.recording) {
      void this.finishRecording();
      return;
    }
    if (!canExportVideo()) {
      setStatus("Recording needs a browser that can encode video, such as Chrome or Edge.", "error", 5000);
      return;
    }
    const now = performance.now();
    this.recording = { path: new CameraPath(), startedAt: now, shownAt: 0 };
    this.recording.path.add(0, this.camera);
    setRecording(true);
    this.sampleRecording(now);
  }

  private sampleRecording(now: number) {
    const recording = this.recording;
    if (!recording) return;
    const elapsed = (now - recording.startedAt) / 1000;
    recording.path.add(elapsed, this.camera);
    if (elapsed >= MAX_RECORDING_SECONDS) {
      void this.finishRecording();
      return;
    }
    if (now - recording.shownAt >= 250) {
      recording.shownAt = now;
      setStatus(`Recording ${formatClock(elapsed)} · press R or Done to render it`);
    }
  }

  private async finishRecording() {
    const recording = this.recording;
    const session = this.session;
    const world = this.currentWorld;
    if (!recording || !session || !world) return;
    this.recording = null;
    setRecording(false);
    if (recording.path.duration < MIN_RECORDING_SECONDS) {
      setStatus("That was too short to make a video. Fly for a moment, then press Done.", "error", 4000);
      return;
    }
    setStatus(null);
    this.controller?.unlock();

    const abort = new AbortController();
    this.exportAbort = abort;
    this.exportResult = null;
    const restore = {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
      pixelRatio: this.renderer.getPixelRatio(),
    };
    const size = outputSize(window.innerWidth, window.innerHeight);
    const total = Math.ceil(recording.path.duration * EXPORT_FPS) + 1;
    showExport({
      state: "rendering",
      title: "Rendering your video",
      detail: `Getting ready · ${total} frames at ${size.width}×${size.height}`,
      progress: 0,
    });
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(size.width, size.height, false);
      this.camera.aspect = size.width / size.height;
      this.camera.updateProjectionMatrix();
      const result = await exportVideo({
        renderer: this.renderer,
        scene: this.scene,
        camera: this.camera,
        spark: session.spark,
        path: recording.path,
        width: size.width,
        height: size.height,
        signal: abort.signal,
        onProgress: ({ frame, total: count, etaSeconds }) => {
          const eta = etaSeconds === null ? "" : ` · about ${formatClock(etaSeconds)} left`;
          showExport({
            state: "rendering",
            title: "Rendering your video",
            detail: `Frame ${frame} of ${count}${eta}`,
            progress: frame / count,
          });
        },
      });
      this.exportResult = result;
      const megabytes = (result.blob.size / (1024 * 1024)).toFixed(1);
      showExport({
        state: "done",
        title: "Your video is ready",
        detail: `${formatClock(result.seconds)} · ${result.width}×${result.height} · ${megabytes} MB`,
        progress: 1,
      });
    } catch (error) {
      if (isExportCancelled(error) || abort.signal.aborted) {
        hideExport();
      } else {
        showExport({
          state: "error",
          title: "The video could not be rendered",
          detail: error instanceof Error ? error.message : "Something went wrong.",
          progress: 0,
        });
      }
    } finally {
      if (this.exportAbort === abort) this.exportAbort = null;
      this.camera.position.copy(restore.position);
      this.camera.quaternion.copy(restore.quaternion);
      this.renderer.setPixelRatio(restore.pixelRatio);
      this.resize();
    }
  }

  private async saveExport() {
    const result = this.exportResult;
    const world = this.currentWorld;
    if (!result) return;
    ui.exportSave.disabled = true;
    try {
      const saved = await saveVideo(result.blob, `${world?.key ?? "world"}-flight.mp4`);
      if (saved) this.closeExport();
    } finally {
      ui.exportSave.disabled = false;
    }
  }

  private closeExport() {
    this.exportResult = null;
    hideExport();
  }

  private renderLobby() {
    const pendingWorlds = listPendingWorlds(this.worldConfig);
    const readyWorlds = mergeWorlds(listReadyWorlds(this.worldConfig), this.remoteWorlds);
    this.followDeepLink(readyWorlds);

    // One place handles photos deleted from disk or claimed while ticked.
    const claimed = new Set(
      [...readyWorlds, ...pendingWorlds].flatMap((world) => worldPhotoNames(world)),
    );
    this.selection = this.selection.filter(
      (name) => this.uploads.some((upload) => upload.name === name) && !claimed.has(name),
    );

    renderLists({
      uploads: this.uploads,
      readyWorlds,
      pendingWorlds,
      selection: this.selection,
      selectionFull: this.selection.length >= MAX_WORLD_PHOTOS,
      onEnter: (world) => void this.enterWorld(world),
      onStop: (world) => void this.stopGeneration(world),
      onRemove: (world) => void this.forgetWorld(world),
      onGenerateWorld: (world) =>
        void this.requestGeneration(worldPhotoNames(world), "requested"),
      onGenerate: (upload) => void this.requestGeneration([upload.name], "requested"),
      onToggleSelect: (name) => this.toggleSelection(name),
    });
    renderBatchBar({
      count: this.selection.length,
      max: MAX_WORLD_PHOTOS,
      anchor: this.selection[0],
    });
    this.scheduleLobbyPoll(pendingWorlds);
  }

  private toggleSelection(name: string) {
    const at = this.selection.indexOf(name);
    if (at !== -1) {
      this.selection.splice(at, 1);
    } else if (this.selection.length >= MAX_WORLD_PHOTOS) {
      setUploadNote(`A world can use at most ${MAX_WORLD_PHOTOS} photos.`, true);
      return;
    } else {
      this.selection.push(name);
    }
    this.renderLobby();
  }

  /** Keep watching while a world is still working, so rows update on their own. */
  private scheduleLobbyPoll(pendingWorlds: PendingWorld[]) {
    window.clearTimeout(this.lobbyPollTimer);
    const working = pendingWorlds.some((world) => isWorking(world.status));
    if (!working || ui.lobby.hidden || !this.uploadsSupported) return;
    this.lobbyPollTimer = window.setTimeout(() => void this.refreshLobby(), 5000);
  }

  private async refreshLobby() {
    await Promise.all([this.refreshUploads(), this.refreshWorldConfig()]);
    this.renderLobby();
  }

  /** The dev server serves the live config so agent edits and Stop both show up. */
  private async refreshWorldConfig() {
    try {
      const response = await fetch("/api/generation", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { worlds?: WorldConfigMap };
      if (body.worlds) this.worldConfig = body.worlds;
    } catch {
      this.worldConfig = bundledWorldConfig;
    }
  }

  /**
   * Group or queue a world. Mint has no HTTP API, so the page cannot start one
   * itself: a draft is only a grouping, a request is picked up by the agent.
   */
  private async requestGeneration(names: string[], status: "draft" | "requested") {
    if (names.length === 0) return;
    setUploadNote(
      status === "draft"
        ? `Grouping ${names.length} photos…`
        : `Requesting a world from ${names.length === 1 ? names[0] : `${names.length} photos`}…`,
    );
    try {
      const response = await fetch("/api/generation/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names, status, lookPrompt: ui.lookPrompt.value.trim() }),
      });
      const body = (await response.json()) as {
        worlds?: WorldConfigMap;
        alreadyQueued?: boolean;
        missing?: string[];
        conflicts?: { name: string }[];
        error?: string;
      };
      if (!response.ok || !body.worlds) {
        // Prune anything the server says is gone or already spoken for.
        const stale = [...(body.missing ?? []), ...(body.conflicts ?? []).map((c) => c.name)];
        if (stale.length > 0) {
          this.selection = this.selection.filter((name) => !stale.includes(name));
          await this.refreshLobby();
        }
        throw new Error(body.error ?? "Could not request it.");
      }
      this.worldConfig = body.worlds;
      this.selection = this.selection.filter((name) => !names.includes(name));
      const guided = ui.lookPrompt.value.trim().length > 0;
      setUploadNote(
        body.alreadyQueued
          ? "Those photos are already queued."
          : status === "draft"
            ? `Grouped ${names.length} photos into one world. Press Generate when you are ready.`
            : guided
              ? "Requested with your look. Send Claude any message and it will start this world."
              : "Requested. Send Claude any message and it will start this world.",
      );
      this.renderLobby();
    } catch (error) {
      setUploadNote(error instanceof Error ? error.message : "Could not request it.", true);
    }
  }

  /**
   * Add a world that already exists in the user's Mint account. The page cannot
   * fetch it, so this only records which world to register; the agent finishes it.
   */
  private async importWorld() {
    const link = ui.importInput.value.trim();
    if (!link) {
      setUploadNote("Paste a Mint link or asset id.", true);
      ui.importInput.focus();
      return;
    }
    if (!this.uploadsSupported) {
      setUploadNote("Importing needs the local dev server (npm run dev).", true);
      return;
    }
    ui.importAdd.disabled = true;
    setUploadNote("Looking up that world…");
    try {
      const response = await fetch("/api/generation/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link }),
      });
      const body = (await response.json()) as { worlds?: WorldConfigMap; error?: string };
      if (!response.ok || !body.worlds) throw new Error(body.error ?? "Could not import it.");
      this.worldConfig = body.worlds;
      ui.importInput.value = "";
      setUploadNote("Added to In progress. Send Claude any message and it will finish the import.");
      this.renderLobby();
    } catch (error) {
      setUploadNote(error instanceof Error ? error.message : "Could not import it.", true);
    } finally {
      ui.importAdd.disabled = false;
    }
  }

  /** Ungroup a draft, or remove a stopped or failed world, freeing its photos. */
  private async forgetWorld(world: PendingWorld) {
    try {
      const response = await fetch("/api/generation/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: world.key }),
      });
      const body = (await response.json()) as { worlds?: WorldConfigMap; error?: string };
      if (!response.ok || !body.worlds) throw new Error(body.error ?? "Could not remove it.");
      this.worldConfig = body.worlds;
      setUploadNote(
        world.sourceImages.length > 0
          ? `${world.title} removed. Its photos are free again.`
          : `${world.title} removed.`,
      );
      this.renderLobby();
    } catch (error) {
      setUploadNote(error instanceof Error ? error.message : "Could not remove it.", true);
    }
  }

  private async stopGeneration(world: PendingWorld) {
    setUploadNote(`Stopping ${world.title}…`);
    try {
      const response = await fetch("/api/generation/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: world.key }),
      });
      const body = (await response.json()) as { worlds?: WorldConfigMap; error?: string };
      if (!response.ok || !body.worlds) throw new Error(body.error ?? "Could not stop it.");
      this.worldConfig = body.worlds;
      setUploadNote(
        `Stopped ${world.title}. Mint may still finish it in the background, so the credits are already spent.`,
      );
      this.renderLobby();
    } catch (error) {
      setUploadNote(error instanceof Error ? error.message : "Could not stop it.", true);
    }
  }

  private async refreshUploads() {
    try {
      const response = await fetch("/api/uploads", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { uploads: UploadRecord[] };
      this.uploads = body.uploads;
      this.uploadsSupported = true;
    } catch {
      this.uploads = [];
      this.uploadsSupported = false;
      setUploadNote(
        "Read-only copy. Adding photos and building worlds happen in the local app. The finished worlds below work here.",
      );
    }
    setAuthoringAvailable(this.uploadsSupported);
  }

  private bindUploads() {
    const { drop, fileInput } = ui;
    const handleFiles = (files: FileList | null) => {
      const chosen = Array.from(files ?? []);
      if (chosen.length > 0) void this.uploadBatch(chosen);
    };

    fileInput.addEventListener("change", () => {
      handleFiles(fileInput.files);
      fileInput.value = "";
    });
    drop.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        fileInput.click();
      }
    });

    const stop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    ["dragenter", "dragover"].forEach((type) =>
      drop.addEventListener(type, (event) => {
        stop(event as DragEvent);
        drop.classList.add("over");
      }),
    );
    ["dragleave", "dragend"].forEach((type) =>
      drop.addEventListener(type, (event) => {
        stop(event as DragEvent);
        drop.classList.remove("over");
      }),
    );
    drop.addEventListener("drop", (event) => {
      stop(event);
      drop.classList.remove("over");
      handleFiles(event.dataTransfer?.files ?? null);
    });
    // Dropping anywhere else on the page should not navigate away.
    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => event.preventDefault());
  }

  /**
   * Upload a dropped set and group it into one draft world. Files go up one at
   * a time: the server renames on collision, and sequential order is what makes
   * "the first photo is the anchor" deterministic.
   */
  private async uploadBatch(files: File[]) {
    if (!this.uploadsSupported) {
      setUploadNote("Uploads need the local dev server (npm run dev).", true);
      return;
    }
    const images = files.filter((file) => /^image\/(jpeg|png|webp)$/.test(file.type));
    const rejected = files.length - images.length;
    if (images.length === 0) {
      setUploadNote("Only jpg, png or webp images are accepted.", true);
      return;
    }

    ui.drop.classList.add("busy");
    const saved: string[] = [];
    const failed: string[] = [];
    try {
      for (const [index, file] of images.entries()) {
        setUploadNote(
          images.length === 1
            ? `Uploading ${file.name}…`
            : `Uploading ${index + 1} of ${images.length}…`,
        );
        try {
          const response = await fetch("/api/uploads", {
            method: "POST",
            headers: {
              "Content-Type": file.type,
              "X-File-Name": encodeURIComponent(file.name),
            },
            body: file,
          });
          const body = (await response.json()) as { name?: string; error?: string };
          if (!response.ok || !body.name) throw new Error(body.error ?? "Upload failed.");
          saved.push(body.name);
        } catch {
          failed.push(file.name);
        }
      }
    } finally {
      ui.drop.classList.remove("busy");
    }

    await this.refreshLobby();
    if (saved.length === 0) {
      setUploadNote("Nothing uploaded. Try again.", true);
      return;
    }

    const notes: string[] = [];
    if (failed.length > 0) notes.push(`${failed.join(", ")} failed`);
    if (rejected > 0) notes.push(`${rejected} skipped, not jpg, png or webp`);

    if (saved.length === 1) {
      notes.unshift(`Saved ${saved[0]}. Press Generate to build a world from it.`);
      setUploadNote(notes.join(". "), failed.length > 0);
      return;
    }

    // Several photos of one place become a single world.
    const grouped = saved.slice(0, MAX_WORLD_PHOTOS);
    if (saved.length > MAX_WORLD_PHOTOS) {
      notes.unshift(
        `Saved ${saved.length} photos. A world can use ${MAX_WORLD_PHOTOS}, so the first ${MAX_WORLD_PHOTOS} were grouped and the rest are waiting.`,
      );
    }
    await this.requestGeneration(grouped, "draft");
    if (notes.length > 0) setUploadNote(notes.join(". "), failed.length > 0);
  }

  private async enterWorld(world: WorldEntry) {
    const attempt = ++this.loadAttempt;
    this.teardownWorld();
    this.currentWorld = world;
    showLobby(false);
    ui.retry.hidden = true;
    setLookMode("idle");
    setMoving(false);
    setStatus("Loading world…");

    try {
      const session = await WorldSession.create({
        scene: this.scene,
        renderer: this.renderer,
        world,
        onProgress: (message) => {
          if (attempt === this.loadAttempt) setStatus(`${message}…`);
        },
      });
      if (attempt !== this.loadAttempt) {
        session.dispose();
        return;
      }
      this.session = session;
      if (ADAPTIVE_QUALITY) {
        this.quality = new AdaptiveQuality({
          maxPixelRatio: MAX_PIXEL_RATIO,
          apply: ({ splatBudget, pixelRatio }) => {
            session.setSplatBudget(splatBudget);
            if (this.renderer.getPixelRatio() !== pixelRatio) {
              this.renderer.setPixelRatio(pixelRatio);
              this.resize();
            }
          },
        });
        this.quality.reset(performance.now());
      }
      if (MOVING_SPLAT_BUDGET > 0 && !ADAPTIVE_QUALITY) {
        this.motionDetail = new MotionDetail({
          restBudget: session.spark.defaultSplatTarget(),
          movingBudget: MOVING_SPLAT_BUDGET,
          apply: (splatBudget) => session.setSplatBudget(splatBudget),
        });
        this.motionDetail.reset();
      }
      this.controller = new FirstPersonController({
        camera: this.camera,
        domElement: ui.canvas,
        colliders: session.colliderMeshes,
        onLockChange: (locked) => setLookMode(locked ? "locked" : this.controller?.isLockUnavailable ? "drag" : "idle"),
        onLockUnavailable: () => setLookMode("drag"),
        onMovingChange: (moving) => setMoving(moving),
      });
      this.controller.setBounds(session.bounds);
      this.placePlayer(session);
      const sphere = session.bounds.getBoundingSphere(new THREE.Sphere());
      this.camera.far = Math.max(2000, sphere.radius * 8);
      this.camera.updateProjectionMatrix();
      setStatus("Ready. Click the world to look around.", "ok", 3500);
      ui.canvas.focus();
    } catch (error) {
      if (attempt !== this.loadAttempt) return;
      this.teardownWorld();
      setStatus(error instanceof Error ? error.message : "The world failed to load.", "error");
      ui.retry.hidden = false;
    }
  }

  /** Stand at the first floor found near the world origin, falling back to the collider centre. */
  private placePlayer(session: WorldSession) {
    if (!this.controller) return;
    const center = session.bounds.getCenter(new THREE.Vector3());
    const top = session.bounds.max.y + 0.5;
    const candidates = [
      new THREE.Vector3(0, 2.2, 0),
      new THREE.Vector3(0, 4, 0),
      new THREE.Vector3(0, 2.2, 3),
      new THREE.Vector3(0, 2.2, -3),
      new THREE.Vector3(center.x, Math.min(top, center.y + 2), center.z),
      new THREE.Vector3(center.x, top, center.z),
    ];
    // A world can name its opening view when the automatic sweep, which just
    // picks the longest clear line of sight, faces the wrong way in open ground.
    const facing = this.currentWorld?.spawnFacing;
    const floorY = this.controller.spawnAt(
      candidates,
      facing === undefined ? SPAWN_FACING_YAW : THREE.MathUtils.degToRad(facing),
    );
    const openDistance =
      facing === undefined ? this.controller.faceMostOpenDirection() : -1;
    const size = session.bounds.getSize(new THREE.Vector3());
    console.info(
      "[world] collider bounds %s×%s×%s, floor at %s, eye at %s, open view %sm | load splat %sms, collider %sms, boundsTree %sms, total %sms",
      size.x.toFixed(2),
      size.y.toFixed(2),
      size.z.toFixed(2),
      floorY === null ? "none" : floorY.toFixed(2),
      this.camera.position.y.toFixed(2),
      openDistance < 0 ? `fixed ${facing}deg` : openDistance.toFixed(1),
      session.timing.splatMs,
      session.timing.colliderMs,
      session.timing.boundsTreeMs,
      session.timing.totalMs,
    );
  }

  private teardownWorld() {
    // A recording or render belongs to the world being left.
    this.exportAbort?.abort();
    this.exportAbort = null;
    this.closeExport();
    this.recording = null;
    setRecording(false);
    this.controller?.dispose();
    this.controller = null;
    this.session?.dispose();
    this.session = null;
    this.quality = null;
    this.motionDetail = null;
    this.frameMs = 0;
    this.stats?.clear();
    // The next world starts sharp; only the opt-in controller ever lowers it.
    if (this.renderer.getPixelRatio() !== MAX_PIXEL_RATIO) {
      this.renderer.setPixelRatio(MAX_PIXEL_RATIO);
      this.resize();
    }
  }

  exitWorld() {
    this.loadAttempt += 1;
    this.teardownWorld();
    this.currentWorld = null;
    setStatus(null);
    ui.retry.hidden = true;
    setLookMode("idle");
    showLobby(true);
    void this.refreshLobby();
  }

  destroy() {
    this.stopRemoteWorlds();
    this.teardownWorld();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    disposeMintGltfRuntime();
  }

  /** Dev-only: advance the simulation without waiting for animation frames. */
  debugStep(seconds: number, steps = Math.max(1, Math.ceil(seconds * 60))) {
    const dt = seconds / steps;
    for (let index = 0; index < steps; index += 1) this.controller?.update(dt);
    if (this.session && !this.exportAbort) {
      if (this.recording) this.sampleRecording(performance.now());
      this.renderer.render(this.scene, this.camera);
    }
    return this.debug();
  }

  /** Dev-only snapshot used for manual and automated checks. */
  debug() {
    return {
      world: this.currentWorld?.key ?? null,
      loaded: this.session !== null,
      position: this.camera.position.toArray().map((v) => Number(v.toFixed(3))),
      locked: this.controller?.isLocked ?? false,
      keys: this.controller?.pressedKeys ?? [],
      look: this.controller?.lookAngles ?? null,
      moving: this.controller?.isMoving ?? false,
      quality: this.quality?.snapshot() ?? null,
      recording: this.recording
        ? { seconds: this.recording.path.duration, samples: this.recording.path.size }
        : null,
      exporting: this.exportAbort !== null,
      exportBytes: this.exportResult?.blob.size ?? null,
    };
  }

  /** Dev-only: start or stop a recording, as the R key would. */
  debugToggleRecording() {
    this.toggleRecording();
    return this.debug();
  }
}

const app = new App();
window.addEventListener("pagehide", () => app.destroy(), { once: true });
if (import.meta.env.DEV) {
  (window as unknown as { __photoWorld?: App }).__photoWorld = app;
}
