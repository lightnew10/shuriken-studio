import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTPUT_SCHEMAS, ROLES } from '../src/core/agents/roles';
import { Logger } from '../src/core/log';
import { ModelStore } from '../src/core/modeling/model-store';
import { ModelUploads } from '../src/core/modeling/model-uploads';
import { encodePng } from '../src/core/modeling/png';
import type { AgentRunner } from '../src/core/orchestrator/agent-runner';
import type { ProjectContext } from '../src/core/projects/project-service';
import { ImageScreen, LOOKS_AT_ONCE } from '../src/core/roblox/image-screen';

// What a scan can't measure: a web address, a handle or a real brand painted as lettering on a sign. One look by
// the fast model per image before it is uploaded, remembered by the image's content.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-screen-'));
  dirs.push(root);
  mkdirSync(join(root, 'models'), { recursive: true });
  return root;
};
const png = (seed: number) => {
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) data.set([(i * seed) % 255, 90, 40, 255], i * 4);
  return encodePng({ width: 64, height: 64, data });
};
const log = new Logger(null, null).scope('test');

function screenWith(root: string, answer: (n: number) => unknown, ok = true) {
  const seen: Array<{ role: string; images: number; type: string | undefined }> = [];
  const runner = {
    run: async (spec: { role: { id: string }; images?: Array<{ mediaType: string; data: string }> }) => {
      seen.push({ role: spec.role.id, images: spec.images?.length ?? 0, type: spec.images?.[0]?.mediaType });
      return { completion: { ok }, structured: answer(seen.length) };
    },
  } as unknown as AgentRunner;
  const screen = new ImageScreen({ runner: () => runner, project: () => ({ root }) as ProjectContext, log });
  return { screen, seen };
}

describe('a look at a texture before its upload', () => {
  it('asks the fast model once per image, says what it found, and remembers', async () => {
    const root = project();
    const sign = join(root, 'models', 'Shop__Signs.color.png');
    const wall = join(root, 'models', 'Shop__Wall.color.png');
    writeFileSync(sign, png(7));
    writeFileSync(wall, png(11));
    const { screen, seen } = screenWith(root, (n) => (n === 1 ? { flagged: true, what: "the text 'www.neon-soda.jp' on the side sign" } : { flagged: false, what: '' }));
    expect(await screen.check(root, sign)).toBe("the text 'www.neon-soda.jp' on the side sign");
    expect(await screen.check(root, wall)).toBeNull();
    expect(seen).toEqual([
      { role: 'image-checker', images: 1, type: 'image/png' },
      { role: 'image-checker', images: 1, type: 'image/png' },
    ]);
    // The same pictures again (another part of the same material, a later upload): nothing is asked.
    expect(await screen.check(root, sign)).toBe("the text 'www.neon-soda.jp' on the side sign");
    expect(await screen.check(root, wall)).toBeNull();
    expect(seen).toHaveLength(2);
    expect(Object.keys(JSON.parse(readFileSync(join(root, '.shuriken', 'moderation', 'images.json'), 'utf8')))).toHaveLength(2);
    // Two calls for one image at the same moment share one look.
    const other = join(root, 'models', 'Other.color.png');
    writeFileSync(other, png(13));
    await Promise.all([screen.check(root, other), screen.check(root, other)]);
    expect(seen).toHaveLength(3);
  });

  it('never blocks an upload by failing itself', async () => {
    const root = project();
    const file = join(root, 'models', 'A.color.png');
    writeFileSync(file, png(3));
    // No answer (a usage limit), a failed run, a file that isn't a picture, a missing file, switched off.
    expect(await screenWith(root, () => null).screen.check(root, file)).toBeNull();
    expect(await screenWith(root, () => ({ flagged: true, what: 'x' }), false).screen.check(root, file)).toBeNull();
    writeFileSync(join(root, 'models', 'B.color.png'), 'not a png');
    expect(await screenWith(root, () => ({ flagged: true, what: 'x' })).screen.check(root, join(root, 'models', 'B.color.png'))).toBeNull();
    expect(await screenWith(root, () => ({ flagged: true, what: 'x' })).screen.check(root, join(root, 'models', 'Nope.png'))).toBeNull();
    const off = new ImageScreen({ runner: () => null, project: () => ({ root }) as ProjectContext, log, enabled: () => false });
    expect(await off.check(root, file)).toBeNull();
    // Nothing was remembered from the looks that gave no answer: the next upload asks again.
    const again = screenWith(root, () => ({ flagged: false }));
    expect(await again.screen.check(root, file)).toBeNull();
    expect(again.seen).toHaveLength(1);
  });

  it('a part whose texture shows a link is not uploaded, and the agent is told what to have repainted', async () => {
    const root = project();
    const store = new ModelStore(root);
    writeFileSync(join(root, 'models', 'Shop__Signs.color.png'), png(5));
    const meta = store.save({ name: 'Shop_Signs', hash: 'h1', size: [4, 1, 2], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', textures: { color: 'Shop__Signs.color.png' } });
    let sent = 0;
    const uploads = new ModelUploads({
      cloud: { configured: async () => true, upload: async () => (sent++, { ok: true, assetId: '1' }), wait: async () => ({ ok: true, assetId: '1' }) } as never,
      uploads: () => ({ enabled: true, creatorId: '1' }),
      creator: async () => '1',
      screen: async () => 'a Discord logo on the door',
    });
    const r = await uploads.ensure(root, meta);
    expect(sent).toBe(0);
    expect(r.assetId).toBeNull();
    expect(r.why).toMatch(/Shop__Signs\.color\.png shows a Discord logo on the door, so it was NOT uploaded/);
    expect(r.why).toMatch(/kiln_request kind "fix"/);
  });

  // One look takes about 15 s with the real model: a map's textures are looked at together, a few at a time,
  // as soon as their uploads are asked for, not one per upload lane.
  it('looks at every new texture of a batch at once (a few at a time), ahead of the uploads', async () => {
    const root = project();
    const store = new ModelStore(root);
    const metas = Array.from({ length: 10 }, (_, i) => {
      writeFileSync(join(root, 'models', `Shop__M${i}.color.png`), png(17 + i * 2));
      return store.save({ name: `Shop_M${i}`, hash: `h${i}`, size: [4, 1, 2], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', textures: { color: `Shop__M${i}.color.png` } });
    });
    let now = 0;
    let most = 0;
    let looks = 0;
    const runner = {
      run: async () => {
        looks++;
        most = Math.max(most, ++now);
        await new Promise((ok) => setTimeout(ok, 20));
        now--;
        return { completion: { ok: true }, structured: { flagged: false, what: '' } };
      },
    } as unknown as AgentRunner;
    const screen = new ImageScreen({ runner: () => runner, project: () => ({ root }) as ProjectContext, log });
    let lookedBeforeFirstUpload = -1;
    const uploads = new ModelUploads({
      cloud: {
        // Asked once a part's own look is done, right before it is sent.
        configured: async () => {
          if (lookedBeforeFirstUpload < 0) lookedBeforeFirstUpload = looks;
          return true;
        },
        upload: async () => ({ ok: true, assetId: '1' }),
        wait: async () => ({ ok: true, assetId: '1' }),
      } as never,
      uploads: () => ({ enabled: true, creatorId: '1' }),
      creator: async () => '1',
      screen: (r, f) => screen.check(r, f),
      concurrency: 1,
    });
    const r = await uploads.ensureMany(root, metas);
    expect(r.results).toHaveLength(10);
    // One upload lane, yet the looks ran side by side: six were under way before the first upload went out.
    expect(looks).toBe(10);
    expect(most).toBe(LOOKS_AT_ONCE);
    expect(lookedBeforeFirstUpload).toBeGreaterThanOrEqual(LOOKS_AT_ONCE);
  });

  it('is a small role on the fast model with no tools', () => {
    const role = ROLES['image-checker']!;
    expect([role.model, role.builtinTools, role.appTools, role.output]).toEqual(['fast', [], [], 'image_check']);
    expect(role.instructions).toMatch(/When unsure, don't flag/);
    expect(OUTPUT_SCHEMAS.image_check).toMatchObject({ required: ['flagged'] });
  });
});
