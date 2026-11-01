import { clipDuration, sampleClip, type AnimationClip } from '@shared/animation';
import { forwardKinematics, type RigSpec } from '@shared/rig';
import { ModelView, type ModelPart } from '../models/model-view';

/**
 * A custom rig's clip played on the rigged model itself (the Models page's view, each part moved by its
 * segment's joints, the same kinematics as its Motor6Ds in Studio), with the mannequin's controls:
 * play/pause, seek, speed, stills.
 */
export class RigPlayer {
  time = 0;
  playing = true;
  speed = 1;
  onTime: ((t: number) => void) | null = null;
  private readonly view: ModelView;
  private readonly ready: Promise<unknown>;
  private clip: AnimationClip | null = null;
  private duration = 0;
  /** A one-shot holds its last pose a moment before playing again. */
  private hold = 0;

  constructor(host: HTMLElement, private readonly rig: RigSpec, parts: ModelPart[], opts: { interactive?: boolean } = {}) {
    this.view = new ModelView(host, { interactive: opts.interactive !== false });
    this.view.onFrame = (dt) => this.tick(dt);
    this.ready = this.view.loadParts(parts).then(() => {
      this.view.setView(0.9, 0.3);
      this.pose(this.time);
    });
  }

  /** Resolves once the model's parts are loaded (stills before that would be empty). */
  whenReady(): Promise<unknown> {
    return this.ready;
  }

  setClip(clip: AnimationClip | null): void {
    this.clip = clip;
    this.duration = clip ? clipDuration(clip) : 0;
    this.time = 0;
    this.hold = 0;
    this.pose(0);
  }

  /** Holds the clip at `at` of its length (the calm dashboard), or plays again. */
  setStill(on: boolean, at = 0.4): void {
    this.playing = !on;
    if (on) this.seek(this.duration * at);
  }

  seek(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.hold = 0;
    this.pose(this.time);
    this.onTime?.(this.time);
  }

  /** Stills at the given times (data URLs, w×h, cropped from the middle of the view); the live pose comes back after. */
  snapshots(times: number[], w = 160, h = 200): string[] {
    if (!this.clip) return [];
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d')!;
    const out: string[] = [];
    for (const t of times) {
      this.pose(t);
      const src = this.view.renderNow();
      const sh = src.height;
      const sw = Math.min(src.width, (sh * w) / h);
      g.clearRect(0, 0, w, h);
      g.drawImage(src, (src.width - sw) / 2, 0, sw, sh, 0, 0, w, h);
      out.push(off.toDataURL('image/png'));
    }
    this.pose(this.time);
    return out;
  }

  dispose(): void {
    this.view.onFrame = null;
    this.view.dispose();
  }

  private tick(dt: number): void {
    if (!this.clip || !this.playing || this.duration <= 0) return;
    if (this.hold > 0) {
      this.hold -= dt;
      if (this.hold <= 0) this.time = 0;
      else return;
    } else {
      this.time += dt * this.speed;
      if (this.time >= this.duration) {
        if (this.clip.loop) this.time %= this.duration;
        else {
          this.time = this.duration;
          this.hold = 0.6;
        }
      }
    }
    this.pose(this.time);
    this.onTime?.(this.time);
  }

  private pose(t: number): void {
    this.view.pose(this.clip ? forwardKinematics(this.rig, sampleClip({ ...this.clip, loop: false }, t)) : null);
  }
}
