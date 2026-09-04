import * as THREE from "three";
import { FirstPersonController } from "./first-person";
import { disposeMintGltfRuntime } from "./gltf-runtime";
import {
  bundledWorldConfig,
  listPendingWorlds,
  listReadyWorlds,
  MAX_WORLD_PHOTOS,
  worldPhotoNames,
  type PendingWorld,
  type WorldConfigMap,
  type WorldEntry,
} from "./registry";
import {
  renderBatchBar,
  renderLists,
  setAuthoringAvailable,
  setLookMode,
  setMoving,
  setStatus,
  setUploadNote,
  showLobby,
  ui,
  type UploadRecord,
} from "./ui";
import { WorldSession } from "./world-session";

const LOOK_PROMPT_KEY = "photo-walkthrough:look-prompt";
const SPAWN_FACING_YAW = 0; // Looks down -Z, matching the production camera direction.

/** Single owner of the renderer, scene, camera, frame loop, resize and world lifecycle. */
class App {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly timer = new THREE.Timer();
  private session: WorldSession | null = null;
  private controller: FirstPersonController | null = null;
  private currentWorld: WorldEntry | null = null;
  private loadAttempt = 0;
  private uploads: UploadRecord[] = [];
  private uploadsSupported = true;
  private worldConfig: WorldConfigMap = bundledWorldConfig;
  private lobbyPollTimer: number | undefined;
  /** Upload names in tick order; the first is the anchor. */
  private selection: string[] = [];

  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: ui.canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
    ui.retry.addEventListener("click", () => {
      if (this.currentWorld) void this.enterWorld(this.currentWorld);
    });

    this.bindUploads();
    this.renderer.setAnimationLoop(() => this.frame());
    void this.refreshLobby();
    this.renderLobby();
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
    this.controller?.update(delta);
    if (this.session) this.renderer.render(this.scene, this.camera);
    else this.renderer.clear();
  }

  private renderLobby() {
    const pendingWorlds = listPendingWorlds(this.worldConfig);
    const readyWorlds = listReadyWorlds(this.worldConfig);

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
    const working = pendingWorlds.some(
      (world) => world.status === "generating" || world.status === "queued",
    );
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
      setUploadNote(`${world.title} removed. Its photos are free again.`);
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
    this.controller?.dispose();
    this.controller = null;
    this.session?.dispose();
    this.session = null;
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
    this.teardownWorld();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    disposeMintGltfRuntime();
  }

  /** Dev-only: advance the simulation without waiting for animation frames. */
  debugStep(seconds: number, steps = Math.max(1, Math.ceil(seconds * 60))) {
    const dt = seconds / steps;
    for (let index = 0; index < steps; index += 1) this.controller?.update(dt);
    if (this.session) this.renderer.render(this.scene, this.camera);
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
    };
  }
}

const app = new App();
window.addEventListener("pagehide", () => app.destroy(), { once: true });
if (import.meta.env.DEV) {
  (window as unknown as { __photoWorld?: App }).__photoWorld = app;
}
