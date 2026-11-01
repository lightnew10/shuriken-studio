import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { multipartBody, type MultipartPart } from '../roblox/open-cloud-assets';
import { OPEN_CLOUD_KEY, type SecretProvider } from '../roblox/open-cloud-luau';
import type { StoreItem } from './storefront';

/**
 * Roblox's Open Cloud monetization APIs (beta since December 2025):
 * game passes (/game-passes/v1/universes/{universeId}/game-passes) and developer products
 * (/developer-products/v2/universes/{universeId}/developer-products), created with POST and changed with PATCH, as
 * multipart/form-data: name, description, price, isForSale, imageFile. The API key needs the Game Passes and
 * Developer Products systems (write) for the game's universe; the game must be published. Passes and products can't
 * be deleted: one that is no longer wanted is taken off sale.
 */

const BASE = 'https://apis.roblox.com';

export interface PushOutcome {
  key: string;
  ok: boolean;
  /** The pass's or product's id on Roblox. */
  id?: number;
  iconAssetId?: number | null;
  created?: boolean;
  error?: string;
  /** The key is missing, lacks a permission, or the game isn't published: the user has to act. */
  needsUser?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenCloudStore {
  constructor(
    private readonly secret: SecretProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async configured(): Promise<boolean> {
    return !!(await this.secret(OPEN_CLOUD_KEY).catch(() => null));
  }

  /**
   * Creates the item on Roblox (no id yet) or changes it (an id from an earlier push), with its icon when given.
   * `forSale` false takes it off sale. Errors are values.
   */
  async push(universeId: number, item: StoreItem, opts: { icon?: string | null; forSale?: boolean } = {}): Promise<PushOutcome> {
    const key = await this.secret(OPEN_CLOUD_KEY).catch(() => null);
    if (!key) return { key: item.key, ok: false, needsUser: true, error: 'No Open Cloud API key is set (Settings → Roblox & Studio → Uploads to Roblox).' };
    const pass = item.kind === 'pass';
    const id = item.roblox?.id;
    const path = pass ? `/game-passes/v1/universes/${universeId}/game-passes${id ? `/${id}` : ''}` : `/developer-products/v2/universes/${universeId}/developer-products${id ? `/${id}` : ''}`;
    const parts: MultipartPart[] = [
      { name: 'name', value: item.name },
      { name: 'description', value: item.description },
      { name: 'price', value: String(Math.round(item.price)) },
      { name: 'isForSale', value: String(opts.forSale !== false) },
    ];
    if (opts.icon) {
      // The icon may be being redrawn this moment (store_icons): an error as a value, never a throw mid-push.
      let data: Buffer;
      try {
        data = readFileSync(opts.icon);
      } catch (e) {
        return { key: item.key, ok: false, error: `Its icon could not be read (${(e as Error).message}); push again in a moment.` };
      }
      parts.push({ name: 'imageFile', filename: basename(opts.icon), type: 'image/png', data });
    }
    const form = multipartBody(parts);
    let res: Response | null = null;
    let text = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await this.fetchImpl(`${BASE}${path}`, { method: id ? 'PATCH' : 'POST', headers: { 'x-api-key': key, 'content-type': form.contentType }, body: form.body }).catch(() => null);
      if (!res) return { key: item.key, ok: false, error: 'Roblox could not be reached' };
      text = await res.text().catch(() => '');
      // Too many requests: wait as Roblox asks (or a little longer each time), then try again.
      if (res.status === 429 && attempt < 3) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(30, after) * 1000 : 2000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (!res) return { key: item.key, ok: false, error: 'Roblox could not be reached' };
    if (res.status === 401 || res.status === 403) {
      return {
        key: item.key,
        ok: false,
        needsUser: true,
        error: `Roblox refused the API key (${res.status}): it needs the ${pass ? 'Game Passes' : 'Developer Products'} API with write permission for this game (create.roblox.com → Open Cloud → API Keys → your key → Add API System). A game published under a community needs one of that community's keys (switch the creator at the top of create.roblox.com to the community first). ${detail(text)}`.trim(),
      };
    }
    if (!res.ok) return { key: item.key, ok: false, error: `Roblox answered ${res.status}: ${detail(text) || res.statusText}`.trim() };
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const newId = Number(pass ? body.gamePassId : body.productId) || id;
    if (!newId) return { key: item.key, ok: false, error: `Roblox answered without an id: ${text.slice(0, 200)}` };
    const icon = pass ? body.iconAssetId : body.iconImageAssetId;
    return { key: item.key, ok: true, id: newId, iconAssetId: typeof icon === 'number' ? icon : (item.roblox?.iconAssetId ?? null), created: !id };
  }
}

/** Roblox's error text, short. */
function detail(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string }>; title?: string };
    return (j.message ?? j.errors?.map((e) => e.message).join('; ') ?? j.title ?? '').slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
