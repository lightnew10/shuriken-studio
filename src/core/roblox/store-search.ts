/** Studio MCP `search_asset` result, as far as store_search uses it. */
interface StoreResult {
  assetId?: string;
  name?: string;
  creatorName?: string;
  description?: string;
  isFree?: boolean;
}

/** One free asset of a `search_asset` response. */
export interface StoreAsset {
  assetId: string;
  name: string;
  creator: string;
  /** Whitespace-collapsed, or '' when the store's description is only the asset type. */
  description: string;
}

/** The new free assets of a raw `search_asset` response (null when it is not JSON). `seen` dedupes across queries. */
export function parseStoreResults(raw: string, assetType: string, seen: Set<string>): StoreAsset[] | null {
  let parsed: { results?: StoreResult[] };
  try {
    parsed = JSON.parse(raw) as { results?: StoreResult[] };
  } catch {
    return null;
  }
  const out: StoreAsset[] = [];
  for (const a of parsed.results ?? []) {
    if (!a.assetId || a.isFree === false || seen.has(a.assetId)) continue;
    seen.add(a.assetId);
    const desc = (a.description ?? '').replace(/\s+/g, ' ').trim();
    out.push({ assetId: a.assetId, name: (a.name ?? '').replace(/\s+/g, ' '), creator: a.creatorName ?? '?', description: desc && desc.toLowerCase() !== assetType.toLowerCase() ? desc : '' });
  }
  return out;
}

/**
 * One compact line per new free asset from a raw `search_asset` response ("id | name | creator |
 * description"): about a fifth of the raw JSON, which matters because agents search a lot and every
 * tool result stays in their context. `seen` dedupes across the queries of one call.
 */
export function compactStoreResults(raw: string, assetType: string, seen: Set<string>): string[] | null {
  const found = parseStoreResults(raw, assetType, seen);
  if (!found) return null;
  return found.map((a) => `${a.assetId} | ${a.name.slice(0, 70)} | ${a.creator}${a.description ? ` | ${a.description.slice(0, 90)}` : ''}`);
}
