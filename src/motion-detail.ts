/**
 * Spends detail where it can be seen: full quality while you stand still, a
 * smaller splat target while the view is actually moving.
 *
 * What a frame costs on this kind of GPU is set by how many splats are drawn,
 * and almost nothing else. Measured on an Intel Iris Xe at 1157×872, one world
 * drew 1.67M splats in 38.5 ms (26 fps) and 567K in 15.8 ms (63 fps), while
 * dropping the render resolution by 40% saved under 8%. So resolution is the
 * wrong thing to cut — it costs sharpness and buys nothing — and the splat
 * target is the only lever worth pulling.
 *
 * Cutting it permanently is what made worlds look soft next to mint.gg before.
 * Cutting it only while the camera moves keeps the still image identical, which
 * is the image anyone compares, and spends the saving on the moment when the
 * frame rate is felt as lag between the mouse and the screen.
 */

export interface MotionDetailInput {
  /** Splat target while the camera is still: Spark's own platform default. */
  restBudget: number;
  /** Splat target while moving. */
  movingBudget: number;
  /** Called only when the target changes. */
  apply: (splatBudget: number) => void;
}

/**
 * Stay reduced for this long after the last movement. Long enough that the
 * gaps between mouse events during one continuous turn do not flip the target
 * back and forth, short enough that letting go of the mouse sharpens the view
 * about as fast as the eye settles on it.
 */
const RESTORE_DELAY_MS = 250;

export class MotionDetail {
  private readonly restBudget: number;
  private readonly movingBudget: number;
  private readonly apply: (splatBudget: number) => void;
  private lastMotionAt = 0;
  private reduced = false;

  constructor(input: MotionDetailInput) {
    this.restBudget = input.restBudget;
    // Never ask for more detail in motion than the world would show at rest.
    this.movingBudget = Math.min(input.movingBudget, input.restBudget);
    this.apply = input.apply;
  }

  /**
   * Begin a freshly entered world at full detail. The resting target is set
   * explicitly rather than left unset: leaving it unset means "no target", and
   * Spark then holds whatever the last target produced instead of returning to
   * its default, which would strand the world at the moving detail level.
   */
  reset() {
    this.lastMotionAt = 0;
    this.reduced = false;
    this.apply(this.restBudget);
  }

  /** Call once per frame with whether the camera is moving or turning right now. */
  update(now: number, inMotion: boolean) {
    if (inMotion) this.lastMotionAt = now;
    const reduce = this.lastMotionAt > 0 && now - this.lastMotionAt < RESTORE_DELAY_MS;
    if (reduce === this.reduced) return;
    this.reduced = reduce;
    this.apply(reduce ? this.movingBudget : this.restBudget);
  }

  get isReduced() {
    return this.reduced;
  }
}
