import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeCategory, KnowledgeScope, KnowledgeSource } from '@shared/domain';
import type { KnowledgeService } from './knowledge-service';

interface SeedEntry {
  key: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags?: string[];
  confidence: number;
  versionApplicability?: string;
  sources: KnowledgeSource[];
}

/**
 * Loads bundled knowledge (resources/knowledge/*.json) into the global store once. Each entry
 * carries a stable `key`; it is stored as tag `seed:<key>` so re-seeding is idempotent and newer
 * app versions can add entries without duplicating old ones.
 */
export function seedKnowledge(knowledge: KnowledgeService, resourcesDir: string | null, subdir = 'knowledge'): number {
  if (!resourcesDir) return 0;
  const dir = join(resourcesDir, subdir);
  if (!existsSync(dir)) return 0;
  let added = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    let entries: SeedEntry[];
    try {
      entries = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SeedEntry[];
    } catch {
      continue;
    }
    for (const e of entries) {
      const tag = `seed:${e.key}`;
      if (knowledge.search({ tags: [tag], includeInactive: true, limit: 1 }).length) continue;
      try {
        knowledge.add({
          scope: e.scope,
          category: e.category,
          title: e.title,
          body: e.body,
          tags: [...(e.tags ?? []), tag],
          confidence: e.confidence,
          versionApplicability: e.versionApplicability ?? null,
          sources: e.sources,
          createdBy: 'seed',
        });
        added++;
      } catch {
        /* invalid seed entries are skipped */
      }
    }
  }
  return added;
}
