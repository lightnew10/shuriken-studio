import { createHash } from 'node:crypto';
import { R15_PARENT, anglesXYZ, type AnimationClip, type Joint } from '@shared/animation';
import type { RigSpec } from '@shared/rig';

/** Hip height of the default R15 rig the clips are authored against (measured in Studio). */
export const AUTHORED_HIP_HEIGHT = 2.1924;

// Enum values as Studio serializes them (measured: Enum.PoseEasingStyle etc.).
const STYLE: Record<string, number> = { Linear: 0, Constant: 1, Elastic: 2, Cubic: 5, Bounce: 4, CubicV2: 5 };
const DIRECTION: Record<string, number> = { In: 0, Out: 1, InOut: 2 };
const PRIORITY: Record<string, number> = { Idle: 0, Movement: 1, Action: 2, Action2: 3, Action3: 4, Action4: 5, Core: 1000 };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

/**
 * A clip as a Roblox XML model (.rbxmx) holding one KeyframeSequence — the file format the Open Cloud
 * Assets API takes for assetType "Animation". Same structure the world builder creates in Studio:
 * poses nested along the R15 hierarchy (pass-through parents at weight 0), easing on each pose
 * (Cubic written as CubicV2), markers as KeyframeMarkers (with their own keyframe when needed).
 */
export function clipToRbxmx(clip: AnimationClip, rig?: RigSpec | null): string {
  // R15, or a custom rig's joints (its root joint under the rig's HumanoidRootPart).
  const parentMap: Record<string, string> = rig ? Object.fromEntries(rig.joints.map((j) => [j.name, j.parent ?? 'HumanoidRootPart'])) : (R15_PARENT as Record<string, string>);
  let n = 0;
  const seed = createHash('sha1').update(clip.name).digest('hex').slice(0, 24);
  const ref = () => `RBX${seed}${(n++).toString(16).padStart(8, '0')}`;
  const lines: string[] = [];
  const cframe = (rot?: [number, number, number], pos?: [number, number, number]) => {
    const r = anglesXYZ(rot ?? [0, 0, 0]);
    const p = pos ?? [0, 0, 0];
    return `<CoordinateFrame name="CFrame"><X>${num(p[0])}</X><Y>${num(p[1])}</Y><Z>${num(p[2])}</Z><R00>${num(r[0])}</R00><R01>${num(r[1])}</R01><R02>${num(r[2])}</R02><R10>${num(r[3])}</R10><R11>${num(r[4])}</R11><R12>${num(r[5])}</R12><R20>${num(r[6])}</R20><R21>${num(r[7])}</R21><R22>${num(r[8])}</R22></CoordinateFrame>`;
  };

  const keyTimes = new Set(clip.keys.map((k) => k.t));
  const frames: Array<{ t: number; poses: AnimationClip['keys'][number]['poses']; markers: Array<{ name: string; value: string }> }> = clip.keys.map((k) => ({ t: k.t, poses: k.poses, markers: [] }));
  for (const m of clip.markers ?? []) {
    const host = frames.find((f) => Math.abs(f.t - m.t) < 0.001);
    if (host) host.markers.push({ name: m.name, value: m.value ?? '' });
    else if (!keyTimes.has(m.t)) frames.push({ t: m.t, poses: {}, markers: [{ name: m.name, value: m.value ?? '' }] });
  }
  frames.sort((a, b) => a.t - b.t);

  lines.push(
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
    '<External>null</External>',
    '<External>nil</External>',
    `<Item class="KeyframeSequence" referent="${ref()}">`,
    '<Properties>',
    ...(rig ? [] : [`<float name="AuthoredHipHeight">${num(AUTHORED_HIP_HEIGHT)}</float>`]),
    `<bool name="Loop">${clip.loop}</bool>`,
    `<string name="Name">${esc(clip.name)}</string>`,
    `<token name="Priority">${PRIORITY[clip.priority] ?? 2}</token>`,
    '</Properties>',
  );
  for (const f of frames) {
    lines.push(`<Item class="Keyframe" referent="${ref()}">`, '<Properties>', '<string name="Name">Keyframe</string>', `<float name="Time">${num(f.t)}</float>`, '</Properties>');
    // Which poses exist: every keyed joint and its ancestors (pass-through at weight 0).
    const present = new Set<string>();
    for (const j of Object.keys(f.poses)) {
      let cur: string | undefined = j;
      while (cur) {
        present.add(cur);
        cur = cur === 'HumanoidRootPart' ? undefined : (parentMap[cur] ?? undefined);
      }
    }
    const children = (parent: string): string[] => Object.keys(parentMap).filter((j) => parentMap[j] === parent && present.has(j));
    const writePose = (name: string) => {
      const p = name === 'HumanoidRootPart' ? undefined : f.poses[name as Joint];
      const style = p?.ease ?? 'Linear';
      lines.push(
        `<Item class="Pose" referent="${ref()}">`,
        '<Properties>',
        cframe(p?.rot, p?.pos),
        `<token name="EasingDirection">${DIRECTION[p?.dir ?? 'InOut'] ?? 2}</token>`,
        `<token name="EasingStyle">${STYLE[style] ?? 0}</token>`,
        `<string name="Name">${esc(name)}</string>`,
        `<float name="Weight">${p ? 1 : 0}</float>`,
        '</Properties>',
      );
      for (const c of children(name)) writePose(c);
      lines.push('</Item>');
    };
    if (present.size) writePose('HumanoidRootPart');
    for (const m of f.markers) {
      lines.push(`<Item class="KeyframeMarker" referent="${ref()}">`, '<Properties>', `<string name="Name">${esc(m.name)}</string>`, `<string name="Value">${esc(m.value)}</string>`, '</Properties>', '</Item>');
    }
    lines.push('</Item>');
  }
  lines.push('</Item>', '</roblox>');
  return `${lines.join('\n')}\n`;
}
