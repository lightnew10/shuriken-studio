import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';
import { COPILOT_ROLES } from '../src/core/copilots/copilot-roles';
import { KilnClient } from '../src/core/modeling/kiln-modeling';
import { ModelStore, type ModelMeta } from '../src/core/modeling/model-store';
import { moderationBlocker } from '../src/core/modeling/model-uploads';
import { encodePng, type RgbaImage } from '../src/core/modeling/png';
import { OFF_PLATFORM_RULE, findQrCode, kilnContentProblems, uploadBlocker } from '../src/core/roblox/content-rules';

/**
 * What Roblox's moderation removes. On 2026-10-01 a QR code Kiln's copilot painted on a vending machine's pay panel
 * (about 50 px wide in a 1024 px atlas, two pixels per module, stylized finder patterns) was removed a minute after
 * the upload, "Directing Users Off-Platform".
 */
const image = (w: number, h: number, rgb: [number, number, number] = [120, 120, 120]): RgbaImage => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { width: w, height: h, data };
};
const rect = (img: RgbaImage, x0: number, y0: number, w: number, h: number, v: number) => {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) img.data.set([v, v, v, 255], (y * img.width + x) * 4);
};
/** A matrix code of n×n modules, each `m` px, with a white quiet zone, at (x, y). Deterministic. */
const code = (img: RgbaImage, x: number, y: number, n: number, m: number) => {
  rect(img, x - 2 * m, y - 2 * m, (n + 4) * m, (n + 4) * m, 245);
  let seed = 12345;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if ((seed >> 16) & 1) rect(img, x + i * m, y + j * m, m, m, 12);
    }
};

describe('finding a QR code in a texture', () => {
  it('finds a small one (two pixels a module) in a big atlas, and a big one', () => {
    const atlas = image(1024, 1024, [30, 20, 60]);
    code(atlas, 40, 600, 25, 2);
    const small = findQrCode(atlas)!;
    expect(small).not.toBeNull();
    expect(Math.abs(small.x - 65)).toBeLessThan(30);
    expect(Math.abs(small.y - 625)).toBeLessThan(30);
    const sign = image(512, 512, [200, 40, 40]);
    code(sign, 120, 120, 29, 8);
    expect(findQrCode(sign)).not.toBeNull();
  });

  it('leaves ordinary textures alone: flat colour, a checkerboard, stripes, a grille, lettering, grey noise', () => {
    expect(findQrCode(image(256, 256))).toBeNull();
    const checker = image(256, 256);
    for (let y = 0; y < 256; y += 8) for (let x = 0; x < 256; x += 8) rect(checker, x, y, 8, 8, ((x + y) / 8) % 2 ? 10 : 245);
    expect(findQrCode(checker)).toBeNull();
    const stripes = image(256, 256);
    for (let x = 0; x < 256; x += 6) rect(stripes, x, 0, 3, 256, 10), rect(stripes, x + 3, 0, 3, 256, 245);
    expect(findQrCode(stripes)).toBeNull();
    const grille = image(256, 256, [245, 245, 245]);
    for (let i = 0; i < 256; i += 10) (rect(grille, i, 0, 3, 256, 10), rect(grille, 0, i, 256, 3, 10));
    expect(findQrCode(grille)).toBeNull();
    // White lettering on black, as a glowing sign's mask: strokes with gaps between characters and lines.
    const sign = image(512, 256, [5, 5, 5]);
    for (let line = 0; line < 4; line++)
      for (let ch = 0; ch < 14; ch++) {
        const x = 20 + ch * 34;
        const y = 20 + line * 58;
        rect(sign, x, y, 4, 36, 250);
        rect(sign, x, y, 22, 4, 250);
        rect(sign, x + 9, y + 16, 13, 4, 250);
        if (ch % 2) rect(sign, x + 18, y, 4, 36, 250);
      }
    expect(findQrCode(sign)).toBeNull();
    const noise = image(256, 256);
    let s = 7;
    for (let i = 0; i < 256 * 256; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = 60 + ((s >> 16) % 130);
      noise.data.set([v, v, v, 255], i * 4);
    }
    expect(findQrCode(noise)).toBeNull();
  });
});

describe('before an upload', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-moderation-'));
    dirs.push(root);
    mkdirSync(join(root, 'models'), { recursive: true });
    return root;
  };

  it('a part whose colour map has a QR code is refused with what to do; a clean one, an unreadable file and no texture pass', () => {
    const root = project();
    const store = new ModelStore(root);
    const bad = image(512, 512, [20, 20, 40]);
    code(bad, 60, 300, 25, 3);
    writeFileSync(join(root, 'models', 'Machine__Glow.color.png'), encodePng(bad));
    writeFileSync(join(root, 'models', 'Machine__Body.color.png'), encodePng(image(256, 256, [180, 30, 30])));
    writeFileSync(join(root, 'models', 'Broken.color.png'), 'not a png');
    const part = (name: string, color?: string) => ({ name, hash: 'h', textures: color ? { color } : undefined }) as unknown as ModelMeta;
    const why = moderationBlocker(store, part('Machine_Glow', 'Machine__Glow.color.png'))!;
    expect(why).toMatch(/Machine__Glow\.color\.png has a QR code/);
    expect(why).toMatch(/NOT uploaded/);
    expect(why).toMatch(/kiln_request kind "fix"/);
    expect(moderationBlocker(store, part('Machine_Body', 'Machine__Body.color.png'))).toBeNull();
    expect(moderationBlocker(store, part('Broken', 'Broken.color.png'))).toBeNull();
    expect(moderationBlocker(store, part('Missing', 'Nope.color.png'))).toBeNull();
    expect(moderationBlocker(store, part('Plain'))).toBeNull();
    expect(uploadBlocker(join(root, 'models', 'Machine__Glow.color.png'))).toMatch(/^a QR code at about/);
  });
});

describe('what Kiln flagged in a baked export', () => {
  it('becomes one line per finding for the agent; an older manifest has none', () => {
    expect(kilnContentProblems({ content_problems: [{ material: 'Glow_NeonSoda', map: 'color', problem: 'A QR code at (52, 640).' }, { map: 'emissive' }] })).toEqual([
      `Kiln flagged the color map of Glow_NeonSoda: A QR code at (52, 640). Roblox removes such images and it counts against the user's account: have it repainted (kiln_request kind "fix") before it is uploaded.`,
    ]);
    expect(kilnContentProblems({})).toEqual([]);
    expect(kilnContentProblems(null)).toEqual([]);
    expect(kilnContentProblems({ content_problems: 'none' })).toEqual([]);
  });
});

describe('the rule reaches whoever makes images', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Up to 1.12.1 every message ended with a 600-character moderation paragraph. Kiln has the rule itself.
  it('a message to Kiln goes out as it was written: no rule is added', async () => {
    const got: Array<{ path: string; text: unknown }> = [];
    const server = createServer((req, res) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => {
        got.push({ path: req.url ?? '', text: s ? (JSON.parse(s) as { text?: unknown }).text : undefined });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, turnId: 't1' }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-kiln-rule-'));
    dirs.push(dir);
    const runtime = join(dir, 'runtime.json');
    writeFileSync(runtime, JSON.stringify({ version: '0.8.2', port: (server.address() as AddressInfo).port, token: 'tok' }));
    try {
      const client = new KilnClient(() => runtime);
      await client.post('/api/v1/projects/p1/chat', { text: 'Rustier.', from: 'shuriken', mode: 'queue' });
      await client.post('/api/v1/projects/p1/lock', { by: 'Shuriken Studio', seconds: 5 });
      expect(got[0]).toEqual({ path: '/api/v1/projects/p1/chat', text: 'Rustier.' });
      expect(got[1]!.text).toBeUndefined();
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it('every worker and every copilot is told', () => {
    for (const id of ['modeler', 'environment-artist', 'ui-engineer', 'vfx-artist', 'level-designer', 'roblox-engineer']) expect(ROLES[id]!.instructions, id).toContain(OFF_PLATFORM_RULE);
    for (const [id, role] of Object.entries(COPILOT_ROLES)) expect(role.instructions, id).toContain(OFF_PLATFORM_RULE);
    for (const word of ['QR codes', 'web addresses', 'social handles', 'Discord', 'phone numbers', 'real brand logos']) expect(OFF_PLATFORM_RULE).toContain(word);
  });
});
