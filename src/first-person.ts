import * as THREE from "three";

export interface FirstPersonOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  /** Used to place the spawn and to bound how far you can drift from the world. */
  colliders: THREE.Mesh[];
  onLockChange?: (locked: boolean) => void;
  /** Fired when the player starts or stops holding a movement key. */
  onMovingChange?: (moving: boolean) => void;
  /** Fired once when the browser refuses pointer lock; drag-to-look stays available. */
  onLockUnavailable?: () => void;
}

const EYE_HEIGHT = 1.6;
const FLY_SPEED = 1.8;
const FLY_RUN_SPEED = 4.5;
// Arrow keys: left/right turn in radians per second, up/down climb or descend
// in world units per second.
const TURN_SPEED = 1.5;
const TURN_RUN_SPEED = 2.6;
const RISE_SPEED = 1.4;
const RISE_RUN_SPEED = 3;
const OPEN_SPACE_PROBE = 60;
const GROUND_PROBE = 16;
const LOOK_SENSITIVITY = 0.0022;
const DRAG_SENSITIVITY = 0.004;
const MAX_PITCH = THREE.MathUtils.degToRad(89);
const MOVE_SMOOTHING = 9;
const LOOK_SMOOTHING = 22;
const MAX_DELTA = 1 / 20;
// How far past the world you may drift before being held, so flying through a
// wall leaves you near the building rather than lost in empty space.
const DRIFT_MARGIN_RATIO = 0.35;
const MIN_DRIFT_MARGIN = 12;

const DOWN = new THREE.Vector3(0, -1, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ACTION_KEYS = [
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.isContentEditable ||
        target.closest("input, textarea, select, [contenteditable='true']"),
    )
  );
}

/**
 * Free-flight camera. The mouse aims, and W/S move along exactly where you are
 * aiming, so looking up and holding W climbs. Nothing blocks you: there is no
 * gravity and no collision, only a generous bound that stops you drifting out
 * of sight of the world. Owns the camera pose while active.
 */
export class FirstPersonController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly colliders: THREE.Mesh[];
  private readonly onLockChange?: (locked: boolean) => void;
  private readonly onMovingChange?: (moving: boolean) => void;
  private readonly onLockUnavailable?: () => void;
  private readonly raycaster = new THREE.Raycaster();
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private readonly spawn = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private bounds: THREE.Box3 | null = null;
  private yaw = 0;
  private pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private moving = false;
  private locked = false;
  private lockUnavailable = false;
  private dragPointerId: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private disposed = false;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) return;
    // Stop the arrows from scrolling the page behind the canvas.
    if (ACTION_KEYS.includes(event.code)) event.preventDefault();
    this.keys.add(event.code);
  };
  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };
  private readonly onBlur = () => {
    this.keys.clear();
    this.dragPointerId = null;
  };
  private readonly onMouseMove = (event: MouseEvent) => {
    if (!this.locked) return;
    this.applyLookDelta(event.movementX * LOOK_SENSITIVITY, event.movementY * LOOK_SENSITIVITY);
  };
  private readonly onPointerDown = (event: PointerEvent) => {
    if (this.locked || event.button !== 0) return;
    this.dragPointerId = event.pointerId;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.domElement.setPointerCapture?.(event.pointerId);
  };
  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.locked || this.dragPointerId !== event.pointerId) return;
    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.applyLookDelta(dx * DRAG_SENSITIVITY, dy * DRAG_SENSITIVITY);
  };
  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.dragPointerId !== event.pointerId) return;
    this.dragPointerId = null;
    if (this.domElement.hasPointerCapture?.(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }
  };
  private readonly onPointerLockChange = () => {
    this.locked = document.pointerLockElement === this.domElement;
    if (!this.locked) this.keys.clear();
    this.dragPointerId = null;
    this.onLockChange?.(this.locked);
  };
  private readonly onPointerLockError = () => {
    this.markLockUnavailable();
  };

  constructor(options: FirstPersonOptions) {
    this.camera = options.camera;
    this.domElement = options.domElement;
    this.colliders = options.colliders;
    this.onLockChange = options.onLockChange;
    this.onMovingChange = options.onMovingChange;
    this.onLockUnavailable = options.onLockUnavailable;
    this.raycaster.far = GROUND_PROBE;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("pointerlockerror", this.onPointerLockError);
    this.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.domElement.addEventListener("pointermove", this.onPointerMove);
    this.domElement.addEventListener("pointerup", this.onPointerUp);
    this.domElement.addEventListener("pointercancel", this.onPointerUp);
  }

  get isLocked() {
    return this.locked;
  }

  get isLockUnavailable() {
    return this.lockUnavailable;
  }

  get isMoving() {
    return this.moving;
  }

  get pressedKeys() {
    return [...this.keys];
  }

  get lookAngles() {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  lock() {
    if (this.disposed || this.locked || this.lockUnavailable) return;
    const request = this.domElement.requestPointerLock as (
      options?: { unadjustedMovement?: boolean },
    ) => Promise<void> | void;
    const fallback = () => {
      try {
        const plain = this.domElement.requestPointerLock() as unknown;
        if (plain instanceof Promise) plain.catch(() => this.markLockUnavailable());
      } catch {
        this.markLockUnavailable();
      }
    };
    try {
      const result = request.call(this.domElement, { unadjustedMovement: true });
      if (result instanceof Promise) result.catch(fallback);
    } catch {
      fallback();
    }
  }

  unlock() {
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
  }

  private markLockUnavailable() {
    this.locked = false;
    if (this.lockUnavailable) return;
    this.lockUnavailable = true;
    this.onLockUnavailable?.();
  }

  private applyLookDelta(yawDelta: number, pitchDelta: number) {
    this.targetYaw -= yawDelta;
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch - pitchDelta, -MAX_PITCH, MAX_PITCH);
  }

  /** Keep the camera within a generous box around the world so it cannot get lost. */
  setBounds(bounds: THREE.Box3) {
    const size = bounds.getSize(new THREE.Vector3());
    const margin = Math.max(size.length() * DRIFT_MARGIN_RATIO, MIN_DRIFT_MARGIN);
    this.bounds = bounds.clone().expandByScalar(margin);
  }

  /**
   * Start standing on the first floor found below one of the candidates, so a
   * world opens at human height rather than in mid air.
   */
  spawnAt(candidates: THREE.Vector3[], facingYaw = 0): number | null {
    for (const candidate of candidates) {
      const hit = this.castDown(candidate, GROUND_PROBE * 2);
      if (!hit) continue;
      this.camera.position.set(candidate.x, hit.point.y + EYE_HEIGHT, candidate.z);
      this.finishSpawn(facingYaw);
      return hit.point.y;
    }
    const fallback = candidates[0] ?? new THREE.Vector3(0, EYE_HEIGHT, 0);
    this.camera.position.copy(fallback);
    this.finishSpawn(facingYaw);
    return null;
  }

  private finishSpawn(facingYaw: number) {
    this.spawn.copy(this.camera.position);
    this.yaw = this.targetYaw = facingYaw;
    this.pitch = this.targetPitch = 0;
    this.velocity.set(0, 0, 0);
    this.applyLook();
  }

  private applyLook() {
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
  }

  /**
   * Turn toward the direction with the most open space at eye height, so a
   * spawn next to a window or wall starts by looking into the room.
   */
  faceMostOpenDirection() {
    const origin = this.camera.position.clone();
    let bestYaw = this.yaw;
    let bestDistance = -1;
    const samples = 24;
    for (let index = 0; index < samples; index += 1) {
      const yaw = (index / samples) * Math.PI * 2;
      const direction = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      this.raycaster.far = OPEN_SPACE_PROBE;
      this.raycaster.set(origin, direction);
      const hits = this.raycaster.intersectObjects(this.colliders, false);
      const distance = hits.length > 0 ? hits[0].distance : OPEN_SPACE_PROBE;
      if (distance > bestDistance) {
        bestDistance = distance;
        bestYaw = yaw;
      }
    }
    this.yaw = this.targetYaw = bestYaw;
    this.applyLook();
    return bestDistance;
  }

  update(rawDelta: number) {
    if (this.disposed) return;
    const dt = Math.min(rawDelta, MAX_DELTA);
    const running = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");

    // Arrow keys: left/right turn, up/down climb and descend.
    const turnRate = running ? TURN_RUN_SPEED : TURN_SPEED;
    if (this.keys.has("ArrowLeft")) this.targetYaw += turnRate * dt;
    if (this.keys.has("ArrowRight")) this.targetYaw -= turnRate * dt;

    // Smoothed look.
    const lookBlend = 1 - Math.exp(-LOOK_SMOOTHING * dt);
    this.yaw += (this.targetYaw - this.yaw) * lookBlend;
    this.pitch += (this.targetPitch - this.pitch) * lookBlend;
    this.applyLook();

    // W and S follow exactly where the camera is aiming, pitch included.
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(forward, WORLD_UP);
    if (right.lengthSq() < 1e-6) right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    right.normalize();

    const wish = new THREE.Vector3();
    if (this.keys.has("KeyW")) wish.add(forward);
    if (this.keys.has("KeyS")) wish.sub(forward);
    if (this.keys.has("KeyD")) wish.add(right);
    if (this.keys.has("KeyA")) wish.sub(right);
    const riseRate = (running ? RISE_RUN_SPEED : RISE_SPEED) / (running ? FLY_RUN_SPEED : FLY_SPEED);
    if (this.keys.has("ArrowUp")) wish.addScaledVector(WORLD_UP, riseRate);
    if (this.keys.has("ArrowDown")) wish.addScaledVector(WORLD_UP, -riseRate);
    if (wish.lengthSq() > 0) {
      wish.normalize().multiplyScalar(running ? FLY_RUN_SPEED : FLY_SPEED);
    }

    this.velocity.lerp(wish, 1 - Math.exp(-MOVE_SMOOTHING * dt));
    this.camera.position.addScaledVector(this.velocity, dt);

    if (this.bounds && !this.bounds.containsPoint(this.camera.position)) {
      this.bounds.clampPoint(this.camera.position, this.camera.position);
      this.velocity.multiplyScalar(0.2);
    }

    const moving = ACTION_KEYS.some((code) => this.keys.has(code));
    if (moving !== this.moving) {
      this.moving = moving;
      this.onMovingChange?.(moving);
    }
  }

  private castDown(from: THREE.Vector3, far: number) {
    this.raycaster.far = far;
    this.raycaster.set(new THREE.Vector3(from.x, from.y + 0.1, from.z), DOWN);
    const hits = this.raycaster.intersectObjects(this.colliders, false);
    return hits.length > 0 ? hits[0] : null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unlock();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("pointerlockerror", this.onPointerLockError);
    this.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.domElement.removeEventListener("pointercancel", this.onPointerUp);
    this.keys.clear();
  }
}
