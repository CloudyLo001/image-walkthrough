import * as THREE from "three";

interface PoseSample {
  /** Seconds since the recording started. */
  t: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/**
 * The camera's pose over time while the player records a flight. Samples land
 * at whatever rate the live loop ran; the export asks for poses on its own
 * fixed clock and gets them interpolated, so a stuttering recording still
 * replays smoothly.
 */
export class CameraPath {
  private readonly samples: PoseSample[] = [];

  get duration() {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1].t : 0;
  }

  get size() {
    return this.samples.length;
  }

  add(t: number, camera: THREE.Camera) {
    const last = this.samples[this.samples.length - 1];
    if (last && t <= last.t) return;
    this.samples.push({
      t,
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
    });
  }

  /** The pose at `t`, blended between the two nearest samples. */
  poseAt(t: number, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion) {
    const samples = this.samples;
    if (samples.length === 0) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (t <= first.t) {
      outPosition.copy(first.position);
      outQuaternion.copy(first.quaternion);
      return;
    }
    if (t >= last.t) {
      outPosition.copy(last.position);
      outQuaternion.copy(last.quaternion);
      return;
    }
    let low = 0;
    let high = samples.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (samples[mid].t <= t) low = mid;
      else high = mid;
    }
    const a = samples[low];
    const b = samples[high];
    const span = b.t - a.t;
    const k = span > 0 ? (t - a.t) / span : 0;
    outPosition.lerpVectors(a.position, b.position, k);
    outQuaternion.slerpQuaternions(a.quaternion, b.quaternion, k);
  }
}
