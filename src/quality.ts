/**
 * Holds the frame rate at a target by trading detail for speed, live.
 *
 * What a frame costs is set almost entirely by how many splats Spark draws,
 * and that number grows with the screen: on an Intel Iris Xe the same world
 * drew 534K splats at 1280×720 (11 ms) and 1.13M at 1920×1080 (30 ms, 33 fps).
 * Capping the count at 300K brought 1080p to 18 ms (56 fps) with no visible
 * difference. No fixed cap suits every screen and GPU, so this watches the
 * measured frame time and moves the cap — and, only once the cap is at its
 * floor, the render resolution — until the target holds.
 */

export interface QualitySettings {
  /** Target number of splats for Spark's LoD tree. */
  splatBudget: number;
  /** Renderer pixel ratio; 1 draws one pixel per CSS pixel. */
  pixelRatio: number;
}

const TARGET_FPS = 60;
/** Frames slower than this are over budget. Just under the 16.7 ms target. */
const OVER_MS = 17.5;
/** Frames faster than this leave clear headroom to spend on detail. */
const UNDER_MS = 12.5;
/**
 * A 60 Hz screen pins every frame near 16.7 ms however light the work is, so
 * headroom cannot be seen there. A window that holds the target with no slow
 * frames at all is treated as a hint of headroom and probed cautiously.
 */
const HELD_P75_MS = 16.9;
const HELD_MAX_MS = 20;

/** Where a world starts: fast enough on a laptop GPU, sharpened from here. */
const START_BUDGET = 500_000;
const MIN_BUDGET = 150_000;
/** Spark's own desktop default; there is nothing above it worth drawing. */
const MAX_BUDGET = 2_500_000;
const BUDGET_DOWN = 0.75;
const BUDGET_UP = 1.25;

const MIN_PIXEL_RATIO = 0.6;
const PIXEL_RATIO_STEP = 0.1;

/** Skip this long after entering: the world is still streaming and settling. */
const GRACE_MS = 2500;
const WINDOW = 45;
const MIN_SAMPLES = 20;
const DECIDE_EVERY_MS = 750;
/** After a change, wait for the LoD tree to settle before judging it. */
const COOLDOWN_MS = 1500;
/** Only spend headroom that has been there for a while. */
const STEADY_MS = 3000;
/** A step up undone within this long was a probe that failed. */
const PROBE_FAIL_MS = 4000;
/** Each failed probe waits twice as long before the next, up to a minute. */
const MAX_PROBE_WAIT_MS = 60_000;
/** A gap this long is a stall or a hidden tab, not a frame. */
const IGNORE_ABOVE_MS = 250;

export class AdaptiveQuality {
  splatBudget = START_BUDGET;
  pixelRatio: number;
  /** Frames per second over the current window; 0 until measured. */
  fps = 0;

  private readonly maxPixelRatio: number;
  private readonly apply: (settings: QualitySettings) => void;
  private samples: number[] = [];
  private startedAt = 0;
  private lastDecisionAt = 0;
  private headroomSince = 0;
  private lastStepUpAt = 0;
  private probeWaitMs = STEADY_MS;

  constructor(input: { maxPixelRatio: number; apply: (settings: QualitySettings) => void }) {
    this.maxPixelRatio = input.maxPixelRatio;
    this.pixelRatio = input.maxPixelRatio;
    this.apply = input.apply;
  }

  /** Begin again for a freshly entered world, from the starting settings. */
  reset(now: number) {
    this.samples = [];
    this.startedAt = now;
    this.lastDecisionAt = now;
    this.headroomSince = 0;
    this.lastStepUpAt = 0;
    this.probeWaitMs = STEADY_MS;
    this.fps = 0;
    this.splatBudget = START_BUDGET;
    this.pixelRatio = this.maxPixelRatio;
    this.apply(this.settings());
  }

  /** Record one rendered frame. `deltaSeconds` is the time since the last. */
  sample(deltaSeconds: number, now: number) {
    const ms = deltaSeconds * 1000;
    if (now - this.startedAt < GRACE_MS) return;
    if (ms <= 0 || ms > IGNORE_ABOVE_MS) return;
    this.samples.push(ms);
    if (this.samples.length > WINDOW) this.samples.shift();
    if (this.samples.length < MIN_SAMPLES) return;
    if (now - this.lastDecisionAt < DECIDE_EVERY_MS) return;
    this.lastDecisionAt = now;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    // The 75th percentile, so a run of slow frames counts and a lone hitch does not.
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const max = sorted[sorted.length - 1];
    this.fps = 1000 / mean;

    if (p75 > OVER_MS) {
      this.headroomSince = 0;
      if (this.lastStepUpAt && now - this.lastStepUpAt < PROBE_FAIL_MS) {
        this.probeWaitMs = Math.min(MAX_PROBE_WAIT_MS, this.probeWaitMs * 2);
      }
      this.lastStepUpAt = 0;
      if (this.stepDown()) this.settle(now);
      return;
    }

    const clearHeadroom = p75 < UNDER_MS;
    const holding = p75 <= HELD_P75_MS && max <= HELD_MAX_MS;
    if (!clearHeadroom && !holding) {
      this.headroomSince = 0;
      return;
    }
    if (this.headroomSince === 0) this.headroomSince = now;
    const wait = clearHeadroom ? STEADY_MS : this.probeWaitMs;
    if (now - this.headroomSince < wait) return;
    if (this.lastStepUpAt && now - this.lastStepUpAt >= PROBE_FAIL_MS) {
      // The previous step held, so probing can be brisk again.
      this.probeWaitMs = STEADY_MS;
    }
    if (this.stepUp()) {
      this.lastStepUpAt = now;
      this.settle(now);
    }
  }

  settings(): QualitySettings {
    return { splatBudget: this.splatBudget, pixelRatio: this.pixelRatio };
  }

  /** Dev-only snapshot for the console and tests. */
  snapshot() {
    return {
      targetFps: TARGET_FPS,
      fps: Math.round(this.fps),
      splatBudget: this.splatBudget,
      pixelRatio: Number(this.pixelRatio.toFixed(2)),
      samples: this.samples.length,
      probeWaitMs: this.probeWaitMs,
    };
  }

  /** Cheaper first: fewer splats is invisible long before a softer image is. */
  private stepDown() {
    if (this.splatBudget > MIN_BUDGET) {
      this.splatBudget = Math.max(MIN_BUDGET, Math.round(this.splatBudget * BUDGET_DOWN));
      return true;
    }
    if (this.pixelRatio > MIN_PIXEL_RATIO + 1e-6) {
      this.pixelRatio = Math.max(MIN_PIXEL_RATIO, this.pixelRatio - PIXEL_RATIO_STEP);
      return true;
    }
    return false;
  }

  /** Sharpness back first, then detail. */
  private stepUp() {
    if (this.pixelRatio < this.maxPixelRatio - 1e-6) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio + PIXEL_RATIO_STEP);
      return true;
    }
    if (this.splatBudget < MAX_BUDGET) {
      this.splatBudget = Math.min(MAX_BUDGET, Math.round(this.splatBudget * BUDGET_UP));
      return true;
    }
    return false;
  }

  private settle(now: number) {
    this.apply(this.settings());
    this.samples = [];
    this.headroomSince = 0;
    this.lastDecisionAt = now + COOLDOWN_MS - DECIDE_EVERY_MS;
  }
}
