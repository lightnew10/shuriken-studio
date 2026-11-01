/**
 * Finding and fetching tracks that already exist, so the audio workshop can procure a real song or
 * recording instead of synthesizing a poor one. Openverse (https://api.openverse.org, keyless; it
 * indexes Freesound, Jamendo and Wikimedia) is searched for commercial-use licenses only, and a
 * download is checked before anything is saved: https only, no private hosts, at most 20 MB, a real
 * mp3/ogg/wav/flac, at most 7 minutes. Everything takes the fetch to use, so tests need no network.
 */
import { AUDIO_FORMATS, probeAudio, type AudioFormat } from './probe';

export type Fetch = typeof fetch;

/** Licenses a Roblox game may use: CC0, public domain, CC BY and CC BY-SA. Never nc (non-commercial) or nd (no derivatives). */
export const COMMERCIAL_LICENSES = ['cc0', 'pdm', 'by', 'by-sa'] as const;
export type CommercialLicense = (typeof COMMERCIAL_LICENSES)[number];
export const isCommercialLicense = (l: unknown): l is CommercialLicense => typeof l === 'string' && (COMMERCIAL_LICENSES as readonly string[]).includes(l);

/** Roblox's own limits on an uploaded sound. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_SECONDS = 7 * 60;
/** A download may take this long in all, and may not go quiet for longer than the stall limit (a slow CDN is fine, a dead one is not). */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const DOWNLOAD_STALL_MS = 30_000;

export const OPENVERSE_API = 'https://api.openverse.org/v1/audio/';
const USER_AGENT = 'ShurikenStudio/1 (audio search and import)';

const LICENSE_NAMES: Record<CommercialLicense, string> = { cc0: 'CC0', pdm: 'Public Domain Mark', by: 'CC BY', 'by-sa': 'CC BY-SA' };

export const licenseName = (license: CommercialLicense, version?: string | null): string => `${LICENSE_NAMES[license]}${version ? ` ${version}` : ''}`;
/** CC BY and CC BY-SA ask for a credit; CC0 and the public domain do not. */
export const needsCredit = (license: CommercialLicense): boolean => license === 'by' || license === 'by-sa';

/** A track found on the web that may be used in a game. */
export interface FoundTrack {
  /** Openverse's id: what audio_import takes. */
  id: string;
  title: string;
  creator: string;
  creatorUrl?: string;
  license: CommercialLicense;
  /** "CC BY 4.0" */
  licenseName: string;
  licenseUrl: string;
  /** The page the track is on (its author, its license text). */
  sourceUrl: string;
  /** The file itself (https). */
  downloadUrl: string;
  format: AudioFormat;
  durationSec: number | null;
  sizeBytes: number | null;
  /** The site it comes from: freesound, jamendo, wikimedia_audio... */
  origin: string;
  category?: string;
  /** The words the site files it under (Freesound's tags). */
  tags?: string[];
  /** A ready credit line. */
  attribution: string;
}

export interface Dropped {
  /** Records left out, by why (license, mature, url, format, size, duration). */
  [reason: string]: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The container a URL's path or the record's file type names (the file's bytes decide at import). */
export function formatOf(url: string, filetype?: string): AudioFormat | null {
  let ext = '';
  try {
    ext = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? '';
  } catch {
    return null;
  }
  const alias: Record<string, AudioFormat> = { mp3: 'mp3', ogg: 'ogg', oga: 'ogg', ogx: 'ogg', wav: 'wav', wave: 'wav', flac: 'flac' };
  return alias[ext] ?? alias[(filetype ?? '').toLowerCase()] ?? null;
}

/** A track from Openverse's wire format, or why it is left out. */
export function trackFromRecord(r: unknown): { track: FoundTrack } | { dropped: string } {
  if (!r || typeof r !== 'object') return { dropped: 'unreadable' };
  const o = r as Record<string, unknown>;
  const license = str(o.license).toLowerCase();
  // Defence in depth: the query asks for these licenses, the answer is checked again.
  if (!isCommercialLicense(license)) return { dropped: 'license' };
  if (o.mature === true) return { dropped: 'mature' };
  const id = str(o.id);
  const downloadUrl = str(o.url);
  if (!id || !checkUrl(downloadUrl).ok) return { dropped: 'url' };
  const format = formatOf(downloadUrl, str(o.filetype));
  if (!format) return { dropped: 'format' };
  const sizeBytes = num(o.filesize);
  if (sizeBytes !== null && sizeBytes > MAX_IMPORT_BYTES) return { dropped: 'size' };
  const ms = num(o.duration);
  const durationSec = ms === null ? null : Math.round(ms) / 1000;
  if (durationSec !== null && durationSec > MAX_IMPORT_SECONDS) return { dropped: 'duration' };
  const title = str(o.title).replace(/\s+/g, ' ').slice(0, 120) || 'Untitled';
  const origin = str(o.source) || str(o.provider) || 'openverse';
  const creator = str(o.creator).replace(/\s+/g, ' ').slice(0, 120) || `unknown (${origin})`;
  const sourceUrl = str(o.foreign_landing_url);
  const licenseUrl = str(o.license_url);
  const lname = licenseName(license, str(o.license_version) || null);
  const page = /^https:\/\//.test(sourceUrl) ? sourceUrl : downloadUrl;
  const tags = Array.isArray(o.tags)
    ? (o.tags as unknown[])
        .map((t) => str((t as { name?: unknown })?.name).toLowerCase())
        .filter(Boolean)
        .slice(0, 12)
    : [];
  return {
    track: {
      id,
      title,
      creator,
      ...(str(o.creator_url) ? { creatorUrl: str(o.creator_url) } : {}),
      license,
      licenseName: lname,
      licenseUrl,
      sourceUrl: page,
      downloadUrl,
      format,
      durationSec,
      sizeBytes,
      origin,
      ...(str(o.category) ? { category: str(o.category) } : {}),
      ...(tags.length ? { tags } : {}),
      attribution: `"${title}" by ${creator}, ${needsCredit(license) ? 'licensed under' : 'marked'} ${lname}${licenseUrl ? ` (${licenseUrl})` : ''}. Source: ${page}`,
    },
  };
}

/** The usable tracks of an Openverse search response (license, size, length and file type checked), and what was left out. */
export function parseOpenverse(body: unknown): { tracks: FoundTrack[]; dropped: Dropped; total: number } {
  const results = body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results) ? ((body as { results: unknown[] }).results) : [];
  const tracks: FoundTrack[] = [];
  const dropped: Dropped = {};
  const seen = new Set<string>();
  for (const r of results) {
    const t = trackFromRecord(r);
    if ('dropped' in t) dropped[t.dropped] = (dropped[t.dropped] ?? 0) + 1;
    else if (!seen.has(t.track.id)) {
      seen.add(t.track.id);
      tracks.push(t.track);
    }
  }
  const total = body && typeof body === 'object' ? num((body as { result_count?: unknown }).result_count) ?? results.length : results.length;
  return { tracks, dropped, total };
}

export interface NetOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const withTimeout = (o: NetOptions, ms: number): AbortSignal => (o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** Why an Openverse request failed: its firewall refused the query, the quota is used up, the site is unreachable, or anything else. */
type Refusal = 'firewall' | 'rate' | 'down' | 'other';

export interface OpenverseSearch {
  tracks: FoundTrack[];
  dropped: Dropped;
  total: number;
  /** Set when the search that answered is not the one asked for (a word the firewall refuses was replaced, or fewer words matched). */
  note?: string;
}

/**
 * Words Openverse's firewall (Cloudflare, in front of the API) answers with a 403 challenge page, whoever asks
 * and however slowly: measured 2026-10-01, any query containing "outdoor" or "outdoors" ("indoor", "out door",
 * "outside" and "exterior" pass). It is the query's text, not the app, its headers or its rate. The first
 * full build lost its Openverse search to "distant machinery outdoor ambience loop".
 */
const FIREWALL_WORDS: Record<string, string> = { outdoor: 'outside', outdoors: 'outside' };

/** The one place the Openverse API is spoken to; a short memory keeps repeat searches off its small anonymous quota. */
export class OpenverseClient {
  private readonly cache = new Map<string, { at: number; value: OpenverseSearch }>();
  constructor(
    private readonly fetchImpl: Fetch,
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private async get(url: string, o: NetOptions): Promise<{ ok: true; body: unknown } | { ok: false; error: string; why: Refusal }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: withTimeout(o, o.timeoutMs ?? 20_000) });
    } catch (e) {
      return { ok: false, why: 'down', error: `Openverse could not be reached (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message.slice(0, 120)})` };
    }
    if (res.status === 429) return { ok: false, why: 'rate', error: 'Openverse is rate-limiting this app (anonymous use allows 20 searches a minute and 200 a day); try again later, or use the Creator Store' };
    // A 403 with a challenge page is the firewall refusing the request's text (see FIREWALL_WORDS), not the API.
    if (res.status === 403 && (res.headers.get('cf-mitigated') || /html/i.test(res.headers.get('content-type') ?? '')))
      return { ok: false, why: 'firewall', error: "Openverse's firewall refused this search (HTTP 403, a Cloudflare challenge page: it objects to a word in the query, such as \"outdoor\", not to the app). Search again in other words, or use the Creator Store" };
    if (!res.ok) return { ok: false, why: 'other', error: `Openverse answered HTTP ${res.status}` };
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, why: 'other', error: 'Openverse sent an unreadable answer' };
    }
  }

  /**
   * Commercial-use tracks matching `query`, best match first. Openverse matches every word, so a descriptive
   * query ("rain on tin roof loop") often finds nothing: when it does, the search is made again with its
   * first three words, then its first two. A word its firewall refuses is replaced first, and after a refusal
   * the last word is dropped (twice at most). `fatal` on an error means asking again now will not help.
   */
  async search(query: string, limit: number, o: NetOptions & { licenses?: readonly CommercialLicense[] } = {}): Promise<OpenverseSearch | { error: string; fatal?: boolean }> {
    const asked = query.trim().replace(/\s+/g, ' ');
    const licenses = o.licenses ?? COMMERCIAL_LICENSES;
    const key = `${asked.toLowerCase()}|${limit}|${licenses.join(',')}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const one = async (q: string) => {
      const r = await this.get(`${OPENVERSE_API}?${new URLSearchParams({ q, license_type: 'commercial', license: licenses.join(','), page_size: String(Math.min(20, Math.max(8, limit * 2))) })}`, o);
      // Only the licenses asked for, whatever the answer holds.
      if (r.ok && o.licenses && r.body && typeof r.body === 'object' && Array.isArray((r.body as { results?: unknown }).results))
        (r.body as { results: Array<{ license?: unknown }> }).results = (r.body as { results: Array<{ license?: unknown }> }).results.filter((x) => licenses.includes(String(x?.license ?? '').toLowerCase() as CommercialLicense));
      return r;
    };
    const refused = asked.split(' ').filter((w) => FIREWALL_WORDS[w.toLowerCase()]);
    let q = refused.length ? asked.split(' ').map((w) => FIREWALL_WORDS[w.toLowerCase()] ?? w).join(' ') : asked;
    let note = refused.length ? `Openverse's firewall refuses the word "${refused[0]}": searched "${q}" instead.` : undefined;
    let r = await one(q);
    for (let tries = 0; !r.ok && r.why === 'firewall' && tries < 2 && q.includes(' '); tries++) {
      q = q.slice(0, q.lastIndexOf(' '));
      note = `Openverse's firewall refused "${asked}" (a word in it): searched "${q}" instead.`;
      r = await one(q);
    }
    if (!r.ok) return { error: r.error, ...(r.why === 'rate' || r.why === 'down' ? { fatal: true } : {}) };
    let value: OpenverseSearch = parseOpenverse(r.body);
    for (const words of [3, 2]) {
      if (value.total > 0 || q.split(' ').length <= words) continue;
      const shorter = q.split(' ').slice(0, words).join(' ');
      const again = await one(shorter);
      if (!again.ok) break;
      value = parseOpenverse(again.body);
      q = shorter;
      if (value.total > 0) note = `Nothing on Openverse matches every word of "${asked}": these match "${shorter}".`;
    }
    if (note) value = { ...value, note };
    if (this.cache.size > 60) this.cache.clear();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  /** One track by its Openverse id, with its license checked again (what audio_import records comes from here, not from the agent). */
  async lookup(id: string, o: NetOptions = {}): Promise<{ track: FoundTrack } | { error: string }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { error: `"${id}" is not an Openverse id (audio_find lists them; a Creator Store asset goes in with audio_add)` };
    const r = await this.get(`${OPENVERSE_API}${id.toLowerCase()}/`, o);
    if (!r.ok) return { error: r.error };
    const t = trackFromRecord(r.body);
    if ('dropped' in t) {
      const why: Record<string, string> = {
        license: 'its license is not one a game may use (only CC0, public domain, CC BY and CC BY-SA are)',
        mature: 'it is marked mature',
        url: 'it has no https download',
        format: 'it is not an mp3, ogg, wav or flac file',
        size: `it is over ${MAX_IMPORT_BYTES / 1024 / 1024} MB`,
        duration: `it is longer than ${MAX_IMPORT_SECONDS / 60} minutes`,
        unreadable: 'Openverse sent nothing readable for it',
      };
      return { error: `Not importing ${id}: ${why[t.dropped] ?? t.dropped}` };
    }
    return t;
  }
}

// ─── Downloading ────────────────────────────────────────────────────────────

/** Whether a URL may be fetched: https, no credentials, a public host (no localhost, private or link-local address). */
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'not a valid URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'only https downloads are allowed' };
  if (u.username || u.password) return { ok: false, error: 'a URL with a login in it is not allowed' };
  if (u.port && u.port !== '443') return { ok: false, error: 'only the standard https port is allowed' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return { ok: false, error: 'the host is not a public name' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return { ok: false, error: 'a local host is not allowed' };
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return { ok: false, error: 'a private or reserved address is not allowed' };
  }
  if (host.includes(':') && (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))) return { ok: false, error: 'a private or reserved address is not allowed' };
  return { ok: true, url: u };
}

export interface Downloaded {
  ok: true;
  bytes: Buffer;
  format: AudioFormat;
  durationSec: number;
  sampleRate: number;
  channels: number;
  finalUrl: string;
}

export interface DownloadOptions extends NetOptions {
  /** Longest silence (no bytes) tolerated, ms. */
  stallMs?: number;
  /** Called with the bytes received so far (for progress messages). */
  onProgress?: (bytes: number) => void;
  maxBytes?: number;
  maxSeconds?: number;
  maxRedirects?: number;
}

/**
 * Downloads an audio file and checks what came: https only (redirects included, each re-checked), at most
 * `maxBytes` (the body is cut off as soon as it goes over), really mp3/ogg/wav/flac by its bytes, and at
 * most `maxSeconds` long.
 */
export async function downloadTrack(url: string, fetchImpl: Fetch, o: DownloadOptions = {}): Promise<Downloaded | { ok: false; error: string }> {
  const maxBytes = o.maxBytes ?? MAX_IMPORT_BYTES;
  const maxSeconds = o.maxSeconds ?? MAX_IMPORT_SECONDS;
  const stallMs = o.stallMs ?? DOWNLOAD_STALL_MS;
  const stall = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      stall.abort(new DOMException('The download stalled', 'TimeoutError'));
    }, stallMs);
  };
  const signal = AbortSignal.any([stall.signal, withTimeout(o, o.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)]);
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  let current = url;
  alive();
  try {
    for (let hop = 0; ; hop++) {
      const ok = checkUrl(current);
      if (!ok.ok) return { ok: false, error: `${hop ? 'A redirect went to a URL' : 'The URL is'} refused: ${ok.error} (${current.slice(0, 120)})` };
      const res = await fetchImpl(current, { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: 'audio/*,*/*;q=0.5' }, signal });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!next) return { ok: false, error: `The server redirected without saying where (HTTP ${res.status})` };
        if (hop >= (o.maxRedirects ?? 4)) return { ok: false, error: 'Too many redirects' };
        current = new URL(next, current).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: `The download failed: HTTP ${res.status}` };
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type.startsWith('text/') || type.includes('html') || type.includes('json')) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: `That URL is a web page (${type.split(';')[0]}), not an audio file; use the file's own download link` };
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: `Too large: ${mb(declared)} (the limit is ${mb(maxBytes)})` };
      }
      if (!res.body) return { ok: false, error: 'The download had no content' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw signal.reason;
        alive();
        size += value.byteLength;
        o.onProgress?.(size);
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, error: `Too large: over ${mb(maxBytes)}` };
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      const probe = probeAudio(bytes);
      if (!probe.ok) return { ok: false, error: `The download is ${probe.error}` };
      if (!AUDIO_FORMATS.includes(probe.format)) return { ok: false, error: `Format ${probe.format} is not accepted` };
      if (probe.durationSec > maxSeconds) {
        const m = Math.floor(probe.durationSec / 60);
        return { ok: false, error: `Too long: ${m}:${String(Math.round(probe.durationSec % 60)).padStart(2, '0')} (Roblox takes at most ${maxSeconds / 60} minutes)` };
      }
      return { ok: true, bytes, format: probe.format, durationSec: probe.durationSec, sampleRate: probe.sampleRate, channels: probe.channels, finalUrl: current };
    }
  } catch (e) {
    const err = e as Error;
    if (stalled) return { ok: false, error: `The download stalled: no data for ${Math.round(stallMs / 1000)} s` };
    if (err.name === 'TimeoutError') return { ok: false, error: `The download timed out after ${Math.round((o.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) / 1000)} s` };
    if (err.name === 'AbortError') return { ok: false, error: 'The download was cancelled' };
    return { ok: false, error: `The download failed: ${err.message.slice(0, 160)}` };
  } finally {
    clearTimeout(timer);
  }
}
