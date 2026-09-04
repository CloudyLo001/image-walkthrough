import * as THREE from "three";
import { SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";
import { disposeObject3D, hasUsableBounds } from "./dispose";
import { createMintGltfLoader } from "./gltf-runtime";
import type { WorldEntry } from "./registry";

// Production calibration for Mint (World Labs) RAD output. Applied to the
// shared root only; the splat and collider must never be moved independently.
const WORLD_POSITION = new THREE.Vector3(0, 1.5, 0);
const WORLD_ROTATION = new THREE.Euler(Math.PI, Math.PI, 0);
const WORLD_SCALE = 2.5;

export interface LoadTiming {
  splatMs: number;
  colliderMs: number;
  boundsTreeMs: number;
  totalMs: number;
}

export interface WorldSessionInput {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  world: WorldEntry;
  onProgress?: (message: string) => void;
}

/** Owns the shared root, the streamed splat, the invisible collider and the Spark renderer. */
export class WorldSession {
  readonly root: THREE.Group;
  readonly splat: SplatMesh;
  readonly collider: THREE.Object3D;
  readonly colliderMeshes: THREE.Mesh[];
  readonly bounds: THREE.Box3;
  /** Milliseconds each load phase took, for tuning. */
  readonly timing: LoadTiming;
  private readonly spark: SparkRenderer;
  private disposed = false;

  private constructor(input: {
    root: THREE.Group;
    splat: SplatMesh;
    collider: THREE.Object3D;
    spark: SparkRenderer;
    bounds: THREE.Box3;
    timing: LoadTiming;
  }) {
    this.root = input.root;
    this.splat = input.splat;
    this.collider = input.collider;
    this.spark = input.spark;
    this.bounds = input.bounds;
    this.timing = input.timing;
    this.colliderMeshes = [];
    input.collider.traverse((object) => {
      if (object instanceof THREE.Mesh) this.colliderMeshes.push(object);
    });
  }

  static async create(input: WorldSessionInput) {
    const runtimeUrl = input.world.runtimeUrl.trim();
    const colliderUrl = input.world.colliderUrl.trim();
    if (!runtimeUrl || !colliderUrl) {
      throw new Error("This world is missing its runtime or collider URL.");
    }

    const spark = new SparkRenderer({ renderer: input.renderer, enableLod: true });
    input.scene.add(spark);

    const root = new THREE.Group();
    root.name = `mint-world:${input.world.key}`;
    root.position.copy(WORLD_POSITION);
    root.rotation.copy(WORLD_ROTATION);
    root.scale.setScalar(WORLD_SCALE);
    input.scene.add(root);

    const splat = new SplatMesh({
      url: runtimeUrl,
      fileType: SplatFileType.RAD,
      paged: true,
      raycastable: false,
      onFrame: () => {},
    });
    root.add(splat);

    let collider: THREE.Object3D | undefined;
    const startedAt = performance.now();
    const timing = { splatMs: 0, colliderMs: 0, boundsTreeMs: 0, totalMs: 0 };
    try {
      input.onProgress?.("Streaming world");
      const splatReady = splat.initialized.then((value) => {
        timing.splatMs = Math.round(performance.now() - startedAt);
        return value;
      });
      const colliderReady = createMintGltfLoader()
        .loadAsync(colliderUrl)
        .then((value) => {
          timing.colliderMs = Math.round(performance.now() - startedAt);
          return value;
        });
      const results = await Promise.allSettled([splatReady, colliderReady]);
      const [splatResult, colliderResult] = results;
      if (colliderResult.status === "fulfilled") collider = colliderResult.value.scene;
      if (splatResult.status === "rejected") {
        throw new Error(describeError(splatResult.reason, "The world stream failed to start."));
      }
      if (colliderResult.status === "rejected") {
        throw new Error(describeError(colliderResult.reason, "The world collider failed to load."));
      }
      if (!collider) throw new Error("The world collider did not load.");

      input.onProgress?.("Preparing collision");
      root.add(collider);
      root.updateMatrixWorld(true);

      let bounds = new THREE.Box3().setFromObject(collider);
      if (!hasUsableBounds(bounds)) {
        bounds = splat.getBoundingBox(false).clone().applyMatrix4(splat.matrixWorld);
      }
      if (!hasUsableBounds(bounds)) {
        throw new Error("The world collider has no usable geometry.");
      }

      const boundsTreeStart = performance.now();
      // No spatial index: free flight has no collision, so the collider is only
      // raycast about thirty times per entry for the spawn and opening sweep.
      // Building a BVH for that cost more than the rays it served.
      collider.traverse((object) => {
        object.visible = false;
        if (object instanceof THREE.Mesh) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => {
            material.side = THREE.DoubleSide;
          });
        }
      });

      timing.boundsTreeMs = Math.round(performance.now() - boundsTreeStart);
      timing.totalMs = Math.round(performance.now() - startedAt);
      return new WorldSession({ root, splat, collider, spark, bounds, timing });
    } catch (error) {
      if (collider) disposeObject3D(collider);
      root.removeFromParent();
      spark.removeFromParent();
      splat.dispose();
      spark.dispose();
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const release = swallowTeardownRejections();
    this.root.removeFromParent();
    this.spark.removeFromParent();
    this.splat.dispose();
    disposeObject3D(this.collider);
    this.spark.dispose();
    release();
  }
}

// Tearing down a SplatMesh rejects the worker and readback promises it still
// has in flight. Those rejections are expected and have no handler inside the
// library, so absorb exactly those two during teardown and let anything else
// surface normally.
const TEARDOWN_REJECTIONS = ["Worker terminate", "No target"];

function swallowTeardownRejections() {
  const onRejection = (event: PromiseRejectionEvent) => {
    const message =
      event.reason instanceof Error ? event.reason.message : String(event.reason ?? "");
    if (TEARDOWN_REJECTIONS.includes(message)) event.preventDefault();
  };
  window.addEventListener("unhandledrejection", onRejection);
  // Disposal finishes asynchronously, so stay attached for a moment after.
  return () => {
    window.setTimeout(() => window.removeEventListener("unhandledrejection", onRejection), 2000);
  };
}

function describeError(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  return fallback;
}
