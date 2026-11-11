import { CodexAppServer } from './app-server';
export interface CodexModelOption { id: string; name: string; isDefault: boolean }
export const isAllowedCodexModel = (id: string, name = id): boolean => /^[a-zA-Z0-9._:-]{1,128}$/.test(id) && id !== 'default' && !/astra/i.test(id) && !/astra/i.test(name);
type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type CatalogEntry = { id?: string; model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort: Effort }>; defaultReasoningEffort?: Effort };
export type ModelListResponse = { data?: CatalogEntry[]; nextCursor?: string | null };
const efforts: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function effectiveCodexEffort(entry: CatalogEntry | undefined, requested: Effort | undefined): Effort | undefined {
  const supported = entry?.supportedReasoningEfforts?.map((option) => option.reasoningEffort).filter((option) => efforts.includes(option));
  if (!requested) return entry?.defaultReasoningEffort;
  if (!supported?.length || supported.includes(requested)) return requested;
  return [...efforts.slice(0, efforts.indexOf(requested))].reverse().find((effort) => supported.includes(effort)) ?? entry?.defaultReasoningEffort ?? supported[0];
}
export function codexModelOptions(response: ModelListResponse): CodexModelOption[] {
  const seen = new Set<string>();
  return (response.data ?? []).flatMap((entry) => {
    const id = entry.model || entry.id || '', name = entry.displayName || id;
    if (entry.hidden || !isAllowedCodexModel(id, name) || seen.has(id)) return [];
    seen.add(id); return [{ id, name, isDefault: entry.isDefault === true }];
  });
}
export async function loadCodexModels(): Promise<CodexModelOption[]> {
  const server = new CodexAppServer();
  try {
    await server.initialize();
    const models: CodexModelOption[] = [], seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const result: ModelListResponse = await server.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const model of codexModelOptions(result)) if (!seen.has(model.id)) { models.push(model); seen.add(model.id); }
      if (!result.nextCursor) return models;
      if (result.nextCursor === cursor) throw new Error('Codex model catalog repeated its cursor');
      cursor = result.nextCursor;
    }
    throw new Error('Codex model catalog exceeded pagination limit');
  } finally { await server.close(); }
}
