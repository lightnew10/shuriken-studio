import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { currentVersion, versionLabel, type Mockup, type MockVersion } from '@shared/ui-mockup';
import { ROLES } from '../agents/roles';
import { shrinkImage, type RgbaImage } from '../modeling/png';
import type { AgentRunner } from '../orchestrator/agent-runner';
import type { ProjectContext } from '../projects/project-service';
import { MockupStore } from '../ui/ui-mockups';
import { gameBackdrop, pngContent, projectImages } from '../ui/ui-pictures';
import { labDevice, type LabDevice } from '../ui/lab/devices';
import { labView, mockupSubject, wornSubject } from '../ui/lab/lab';
import { skinCacheDir, skinForgeFor, warmSkins } from '../ui/forge/resolve';
import { gameCore } from './ui-lab-tools';
import { errorOutput, type ToolContent, type ToolOutput, type ToolRegistry } from './tool-registry';

/**
 * ui_lab_review: a mockup version looked at on phones by a fast vision model that did not design it, for what the
 * Lab's rules pass and a player still notices. Blind judges named such defects on screens ui_lab_check passed:
 * secondary text that reads tiny and grey, item names dropped from phone tiles, swatches touching, frames jammed against
 * the screen's edges or the home indicator, two of six list items in view, a hero image cut by the edge, a title pressed
 * against its card's top, a badge over a word. One short run per version (remembered for the session); it writes
 * nothing, and without a model it says so instead of failing.
 */

export interface UiLabReviewDeps {
  project: () => ProjectContext | null;
  /** The agent runner (null in tests, smoke runs and safe mode: the review is unavailable). */
  runner: () => Pick<AgentRunner, 'run'> | null;
  resourcesDir?: string | null;
  /** Fetches Roblox images' thumbnails into the project's cache before the pictures draw them (the real app only). */
  fetchImages?: (root: string, refs: string[]) => Promise<void>;
}

export interface PhoneFinding {
  severity: 'problem' | 'warning';
  device: 'small phone' | 'notch phone';
  where: string;
  what: string;
  fix: string;
}

export interface PhoneReview {
  verdict: 'ready' | 'fix';
  findings: PhoneFinding[];
}

interface Reviewed {
  review: PhoneReview;
  /** The pictures it judged, as the tool returns them. */
  pictures: ToolContent[];
}

/** What the reviewer is shown: two phones at in-hand sharpness, and the desktop as a reference for the content. */
const VIEWS: Array<{ id: string; scale: number; caption: (d: LabDevice) => string }> = [
  { id: 'phone-small', scale: 2, caption: (d) => `Image 1, the small phone: ${d.label}, ${d.w}×${d.h} points at 2 px per point, Roblox's touch controls and top bar as in play.` },
  { id: 'phone-notch', scale: 2, caption: (d) => `Image 2, the notch phone: ${d.label}, ${d.w}×${d.h} points at 2 px per point; the notch and rounded corners take ${d.side ?? 0} points left and right, the home indicator ${d.bottom ?? 0} at the bottom.` },
  { id: 'desktop', scale: 0.5, caption: (d) => `Image 3, reference only (not judged): ${d.label}, ${d.w}×${d.h} points at half size, for what the screen holds.` },
];
/** The longest side of a picture the model is shown. */
const MAX_PX = 1800;
const MAX_FINDINGS = 8;
/** Reviews kept for the session (by the version's content). */
const KEEP = 40;

const UNAVAILABLE = 'The phone reviewer is unavailable';

/** The game's Luau (its sync folders), for what it turns off of Roblox's UI (as ui_lab_check reads it). */
function gameCode(p: ProjectContext): string[] {
  const out: string[] = [];
  const map = p.extras().syncMap ?? {};
  const roots = Object.keys(map).length ? Object.keys(map) : ['src'];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length > 3000 || !existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      const st = statSync(f);
      if (st.isDirectory()) walk(f, depth + 1);
      else if (/\.(luau|lua)$/.test(e) && st.size < 2_000_000) out.push(readFileSync(f, 'utf8'));
    }
  };
  for (const r of roots) walk(join(p.root, r), 0);
  return out;
}

const pick = (m: Mockup, v?: string): MockVersion | null => (v ? (m.versions.find((x) => x.id === v.trim().toUpperCase()) ?? null) : (currentVersion(m) ?? null));
const clip = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The model's answer as a review, or null when it isn't one. */
export function parseReview(out: unknown): PhoneReview | null {
  const o = out as { verdict?: unknown; findings?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.findings)) return null;
  const findings: PhoneFinding[] = [];
  for (const raw of o.findings as Array<Record<string, unknown> | null>) {
    if (!raw || typeof raw !== 'object') continue;
    const what = clip(raw.what, 300);
    if (!what) continue;
    findings.push({
      severity: raw.severity === 'problem' ? 'problem' : 'warning',
      device: /notch|14/i.test(String(raw.device ?? '')) ? 'notch phone' : 'small phone',
      where: clip(raw.where, 120) || 'the screen',
      what,
      fix: clip(raw.fix, 300),
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  // A problem is never "ready".
  const verdict = findings.some((f) => f.severity === 'problem') ? 'fix' : o.verdict === 'fix' ? 'fix' : 'ready';
  return { verdict, findings };
}

/** The review as lines an agent can act on. */
function reviewText(title: string, r: PhoneReview, cached: boolean): string {
  const problems = r.findings.filter((f) => f.severity === 'problem').length;
  const warnings = r.findings.length - problems;
  const head = `Phone review of ${title} (small phone and notch phone at 2 px per point, desktop as reference)${cached ? ', the same version as before: its review' : ''}: ${r.verdict === 'ready' ? 'READY' : 'FIX'}, ${problems} problem${problems === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`;
  const lines = r.findings.map((f) => `${f.severity === 'problem' ? 'PROBLEM' : 'warning'} [${f.device}] ${f.where}: ${f.what}${f.fix ? ` Fix: ${f.fix}` : ''}`);
  const tail = r.verdict === 'fix' ? 'Fix the problems in a new version, then ui_lab_check and ui_lab_review it again.' : r.findings.length ? 'Nothing blocks it; the warnings are worth a look.' : 'Nothing a player would notice on either phone.';
  return [head, ...lines, tail].join('\n');
}

export function registerUiLabReviewTool(reg: ToolRegistry, d: UiLabReviewDeps): void {
  /** Reviews by the version's content, and the ones under way (two calls for one version share one run). */
  const reviews = new Map<string, Reviewed>();
  const going = new Map<string, Promise<Reviewed | { failed: string; unavailable: boolean }>>();

  /** The version on the phones and the desktop, as the player sees them. */
  const draw = async (p: ProjectContext, m: Mockup, v: MockVersion): Promise<Array<{ caption: string; image: RgbaImage }>> => {
    if (d.fetchImages) {
      const refs = new Set<string>();
      const walk = (n: { image?: unknown; kids?: unknown[] }) => {
        if (typeof n.image === 'string' && /rbxassetid:\/\/\d+/.test(n.image)) refs.add(n.image);
        for (const c of (n.kids ?? []) as Array<{ image?: unknown; kids?: unknown[] }>) walk(c);
      };
      for (const s of v.screens) walk(s as { image?: unknown; kids?: unknown[] });
      if (refs.size) await d.fetchImages(p.root, [...refs].slice(0, 120)).catch(() => undefined);
    }
    const sf = skinForgeFor(skinCacheDir(p.root));
    const subject = { ...mockupSubject(m, v, gameCore(gameCode(p)).core), title: `${m.title} ${versionLabel(v)}` };
    const devices = VIEWS.map((x) => ({ ...x, dev: labDevice(x.id)! }));
    await warmSkins(devices.flatMap((x) => subject.screensOn(x.dev)), sf).catch(() => undefined);
    // Worn as they ship and as they start (the open tab selected, a button not usable yet disabled).
    const worn = wornSubject(subject, projectImages(p.root, d.resourcesDir ?? null), sf).subject;
    const backdrop = gameBackdrop(p.dir) ?? 'dark';
    return devices.map((x) => ({ caption: x.caption(x.dev), image: shrinkImage(labView(worn, x.dev, { images: worn.images, skins: sf, backdrop, scale: x.scale, caption: false, roblox: 'controls' }).image, MAX_PX) }));
  };

  const review = async (p: ProjectContext, runner: Pick<AgentRunner, 'run'>, m: Mockup, v: MockVersion, signal: AbortSignal): Promise<Reviewed | { failed: string; unavailable: boolean }> => {
    let shots: Array<{ caption: string; image: RgbaImage }>;
    try {
      shots = await draw(p, m, v);
    } catch (e) {
      return { failed: `Could not draw ${m.title} ${versionLabel(v)} on the phones: ${(e as Error).message}`, unavailable: false };
    }
    const pictures = shots.map((s) => pngContent(s.image));
    const images = pictures.map((c, i) => ({ mediaType: 'image/png' as const, data: (c as { data: string }).data, caption: shots[i]!.caption }));
    try {
      const outcome = await runner.run({
        project: p,
        role: ROLES['ui-phone-reviewer']!,
        task: null,
        signal,
        directive: `Review this game screen on the two phones and answer. ${shots.map((s) => s.caption).join(' ')}`,
        contextText: [`The screen: "${m.title}", version ${versionLabel(v)}${m.brief ? `. What it is for: ${clip(m.brief, 400)}` : ''}.`, v.note ? `The designer's note on this version: ${clip(v.note, 300)}` : ''].filter(Boolean).join('\n'),
        images,
      });
      const r = outcome.completion.ok ? parseReview(outcome.structured) : null;
      if (!r) return { failed: `${UNAVAILABLE}${outcome.completion.ok ? ' (it gave no review)' : outcome.completion.error ? ` (${clip(outcome.completion.error, 160)})` : ''}: rely on ui_lab_check.`, unavailable: true };
      return { review: r, pictures };
    } catch (e) {
      return { failed: `${UNAVAILABLE} (${clip((e as Error).message, 160)}): rely on ui_lab_check.`, unavailable: true };
    }
  };

  reg.register({
    name: 'ui_lab_review',
    title: 'Review a mockup on phones',
    description:
      "A second pair of eyes on a mockup version, on phones: a fast vision model that did not design it looks at the version on a small phone (iPhone SE) and a notch phone (iPhone 14), drawn at 2 px per point with Roblox's touch controls as in play, with the desktop beside them as a reference, the way a player holding the phone sideways sees it. It names what rule-based checks pass and a player still notices: secondary text that reads tiny or faint, names, prices or labels the phone dropped, buttons, swatches or rows crowded or touching, panels jammed against the screen's edges, the notch or the home indicator, a list showing too few items, an image or a title cut off or pressed against an edge, a badge over a word. Nothing about taste. Returns a verdict (ready or fix), at most 8 findings (problem or warning, which phone, where, what, fix) and the three pictures it judged. Run it once ui_lab_check is clean; a version is reviewed once per session (asking again returns the same review). Writes nothing.",
    capability: 'app.mockups',
    permission: 'read',
    strict: true,
    input: {
      mockup: z.string().describe('A mockup by name or title'),
      version: z.string().optional().describe("Default: the user's pick, else the newest"),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args, signal }): Promise<ToolOutput> => {
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const m = new MockupStore(p.root).find(args.mockup);
      if (!m) return errorOutput(`No mockup "${args.mockup}"`);
      const v = pick(m, args.version);
      if (!v) return errorOutput(`"${m.title}" has no version ${args.version} (versions: ${m.versions.map((x) => x.id).join(', ')})`);
      const title = `${m.title} ${versionLabel(v)}`;
      const key = createHash('sha1').update(p.root).update(JSON.stringify(v)).digest('hex');
      const known = reviews.get(key);
      const answer = (r: Reviewed, cached: boolean): ToolOutput => ({ content: [{ type: 'text', text: reviewText(title, r.review, cached) }, ...r.pictures], data: { verdict: r.review.verdict, findings: r.review.findings } });
      if (known) return answer(known, true);
      const runner = d.runner();
      if (!runner) return { content: [{ type: 'text', text: `${UNAVAILABLE} here (no model to ask): rely on ui_lab_check.` }], data: { verdict: null, findings: [], unavailable: true } };
      let run = going.get(key);
      if (!run) {
        run = review(p, runner, m, v, signal).finally(() => going.delete(key));
        going.set(key, run);
      }
      const r = await run;
      if ('failed' in r) return r.unavailable ? { content: [{ type: 'text', text: r.failed }], data: { verdict: null, findings: [], unavailable: true } } : errorOutput(r.failed);
      reviews.set(key, r);
      while (reviews.size > KEEP) reviews.delete(reviews.keys().next().value!);
      return answer(r, false);
    },
  });
}
