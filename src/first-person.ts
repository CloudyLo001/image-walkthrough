import * as THREE from "three";

export interface FirstPersonOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  colliders: THREE.Mesh[];
  onLockChange?: (locked: boolean) => void;
  /** Fired when the player starts or stops holding a movement key. */
  onMovingChange?: (moving: boolean) => void;
  /** Fired once when the browser refuses pointer lock; drag-to-look stays available. */
  onLockUnavailable?: () => void;
}

const EYE_HEIGHT = 1.6;
const BODY_RADIUS = 0.28;
// Tall enough for stairs and raked floors, low enough that seat cushions,
// tables and beds read as obstacles instead of steps.
const STEP_HEIGHT = 0.3;
// Minimum ground-normal Y (about 41 degrees) for a surface to count as floor.
// Steeper surfaces such as seat fronts, headboards or counters block movement.
const WALKABLE_NORMAL_Y = 0.75;
const WALK_SPEED = 1.8;
const RUN_SPEED = 4.5;
// Arrow keys: left/right turn in radians per second, up/down raise or lower the
// viewpoint in units per second.
const TURN_SPEED = 1.5;
const TURN_RUN_SPEED = 2.6;
const RISE_SPEED = 1.4;
const RISE_RUN_SPEED = 3;
const MIN_HEIGHT_OFFSET = -1.2;
const MAX_HEIGHT_OFFSET = 6;
const OPEN_SPACE_PROBE = 60;
const GRAVITY = 14;
const LOOK_SENSITIVITY = 0.0022;
const DRAG_SENSITIVITY = 0.004;
const MAX_PITCH = THREE.MathUtils.degToRad(85);
const MOVE_SMOOTHING = 9;
const LOOK_SMOOTHING = 22;
const STEP_SMOOTHING = 14;
const GROUND_PROBE = 8;
const MAX_FALL_BELOW_SPAWN = 25;
const MAX_DELTA = 1 / 20;

const DOWN = new THREE.Vector3(0, -1, 0);
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
 * Pointer-lock look (with drag-to-look fallback), WASD walking grounded on the
 * invisible world collider, left/right arrows to turn and up/down arrows to
 * raise or lower the viewpoint. Owns the camera pose while active. Movement and
 * look are damped so motion reads as a smooth glide rather than a stepped FPS
 * controller.
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
  private yaw = 0;
  private pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private heightOffset = 0;
  /** Height of the floor the body is standing on; the camera rides above it. */
  private feetY = 0;
  private verticalVelocity = 0;
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
    this.raycaster.firstHitOnly = true;
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

  get heightAboveFloor() {
    return this.heightOffset;
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

  /**
   * Try each candidate XZ position and stand on the first floor found below it.
   * Returns the floor height that was used, or null if no floor was hit.
   */
  spawnAt(candidates: THREE.Vector3[], facingYaw = 0): number | null {
    for (const candidate of candidates) {
      const hit = this.castDown(candidate, GROUND_PROBE * 2);
      if (!hit) continue;
      this.camera.position.set(candidate.x, hit.point.y + EYE_HEIGHT, candidate.z);
      this.feetY = hit.point.y;
      this.finishSpawn(facingYaw);
      return hit.point.y;
    }
    const fallback = candidates[0] ?? new THREE.Vector3(0, EYE_HEIGHT, 0);
    this.camera.position.copy(fallback);
    this.feetY = fallback.y - EYE_HEIGHT;
    this.finishSpawn(facingYaw);
    return null;
  }

  private finishSpawn(facingYaw: number) {
    this.spawn.copy(this.camera.position);
    this.yaw = this.targetYaw = facingYaw;
    this.pitch = this.targetPitch = 0;
    this.heightOffset = 0;
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
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

    // Arrow keys: left/right turn, up/down raise or lower the viewpoint.
    const turnRate = running ? TURN_RUN_SPEED : TURN_SPEED;
    if (this.keys.has("ArrowLeft")) this.targetYaw += turnRate * dt;
    if (this.keys.has("ArrowRight")) this.targetYaw -= turnRate * dt;
    const riseRate = running ? RISE_RUN_SPEED : RISE_SPEED;
    if (this.keys.has("ArrowUp")) this.heightOffset += riseRate * dt;
    if (this.keys.has("ArrowDown")) this.heightOffset -= riseRate * dt;
    this.heightOffset = THREE.MathUtils.clamp(
      this.heightOffset,
      MIN_HEIGHT_OFFSET,
      MAX_HEIGHT_OFFSET,
    );

    // Smoothed look.
    const lookBlend = 1 - Math.exp(-LOOK_SMOOTHING * dt);
    this.yaw += (this.targetYaw - this.yaw) * lookBlend;
    this.pitch += (this.targetPitch - this.pitch) * lookBlend;
    this.applyLook();

    // Desired horizontal velocity in the yaw frame (projected onto XZ).
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (this.keys.has("KeyW")) wish.add(forward);
    if (this.keys.has("KeyS")) wish.sub(forward);
    if (this.keys.has("KeyD")) wish.add(right);
    if (this.keys.has("KeyA")) wish.sub(right);
    if (wish.lengthSq() > 0) {
      wish.normalize().multiplyScalar(running ? RUN_SPEED : WALK_SPEED);
    }
    const moveBlend = 1 - Math.exp(-MOVE_SMOOTHING * dt);
    this.velocity.lerp(wish, moveBlend);

    const position = this.camera.position;
    const previous = position.clone();
    const delta = this.velocity.clone().multiplyScalar(dt);
    if (delta.lengthSq() > 1e-10) this.moveWithSliding(position, delta);

    // Grounding. The body follows the floor; the camera rides EYE_HEIGHT plus
    // the arrow-key offset above it, so raising the view never reads as a wall.
    const ground = this.castFromFeet();
    if (ground) {
      const floorY = ground.point.y;
      const climb = floorY - this.feetY;
      const walkable = worldNormal(ground).y >= WALKABLE_NORMAL_Y;
      if (climb > STEP_HEIGHT || (climb > 0.02 && !walkable)) {
        // Too tall or too steep to step onto: treat as a wall.
        position.x = previous.x;
        position.z = previous.z;
        this.velocity.set(0, 0, 0);
        const reverted = this.castFromFeet();
        if (reverted) this.settleFeet(reverted.point.y, dt);
      } else {
        this.settleFeet(floorY, dt);
      }
    } else {
      this.verticalVelocity -= GRAVITY * dt;
      this.feetY += this.verticalVelocity * dt;
      if (this.feetY < this.spawn.y - EYE_HEIGHT - MAX_FALL_BELOW_SPAWN) {
        position.copy(this.spawn);
        this.feetY = this.spawn.y - EYE_HEIGHT;
        this.heightOffset = 0;
        this.velocity.set(0, 0, 0);
        this.verticalVelocity = 0;
      }
    }
    position.y = this.feetY + EYE_HEIGHT + this.heightOffset;

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

  /** Probe the floor just above the body's feet, ignoring the camera height. */
  private castFromFeet() {
    const position = this.camera.position;
    return this.castDown(
      new THREE.Vector3(position.x, this.feetY + STEP_HEIGHT, position.z),
      GROUND_PROBE,
    );
  }

  /** Ease the body onto a floor, falling under gravity when it is below. */
  private settleFeet(floorY: number, dt: number) {
    const drop = this.feetY - floorY;
    if (drop <= 0.02) {
      this.verticalVelocity = 0;
      this.feetY += (floorY - this.feetY) * (1 - Math.exp(-STEP_SMOOTHING * dt));
    } else {
      this.verticalVelocity -= GRAVITY * dt;
      this.feetY = Math.max(this.feetY + this.verticalVelocity * dt, floorY);
      if (this.feetY === floorY) this.verticalVelocity = 0;
    }
  }

  /** Move horizontally, sliding along any collider surface within the body radius. */
  private moveWithSliding(position: THREE.Vector3, delta: THREE.Vector3) {
    const remaining = delta.clone();
    const bodyHeights = [1.4, 0.8, 0.3];
    for (let iteration = 0; iteration < 3 && remaining.lengthSq() > 1e-10; iteration += 1) {
      const distance = remaining.length();
      const direction = remaining.clone().divideScalar(distance);
      let nearest: THREE.Intersection | null = null;
      for (const bodyHeight of bodyHeights) {
        const origin = new THREE.Vector3(position.x, this.feetY + bodyHeight, position.z);
        this.raycaster.far = distance + BODY_RADIUS;
        this.raycaster.set(origin, direction);
        const hits = this.raycaster.intersectObjects(this.colliders, false);
        if (hits.length > 0 && (!nearest || hits[0].distance < nearest.distance)) {
          nearest = hits[0];
        }
      }
      if (!nearest) {
        position.add(remaining);
        return;
      }
      const normal = worldNormal(nearest);
      if (normal.dot(direction) > 0) normal.negate();
      if (normal.y >= WALKABLE_NORMAL_Y) {
        // Floor-like surface: let grounding handle it.
        position.add(remaining);
        return;
      }
      const allowed = Math.max(nearest.distance - BODY_RADIUS, 0);
      position.addScaledVector(direction, allowed);
      remaining.addScaledVector(direction, -allowed);
      remaining.addScaledVector(normal, -remaining.dot(normal));
      remaining.y = 0;
      this.velocity.addScaledVector(normal, -Math.min(this.velocity.dot(normal), 0));
    }
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

function worldNormal(hit: THREE.Intersection) {
  const normal = hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
  return normal.transformDirection(hit.object.matrixWorld).normalize();
}
