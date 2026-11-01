import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import { errorOutput, jsonOutput, type ToolRegistry } from '../capabilities/tool-registry';
import type { LuauIndexer } from './luau-index';

/** Code-intelligence tools so agents stop re-grepping the repository. */
export function registerCodeTools(reg: ToolRegistry, d: { project: () => ProjectContext | null; indexer: LuauIndexer }): void {
  const idx = () => {
    const p = d.project();
    if (!p) throw new Error('No project is open');
    return { p, index: d.indexer.build(p.root, p.extras().syncMap) };
  };
  reg.register({
    name: 'code_query',
    title: 'Query Luau code index',
    description:
      'Ask the project code index instead of grepping. kinds: "summary" (files per client/server/shared, remotes with who defines/fires/handles them, DataStores, tags, attributes, non-strict files), "file" (requires, symbols, remotes of one file), "symbol" (where a function/type is defined), "references" (every line using a name), "dependents" (files that require a module, transitively = what could break if it changes).',
    capability: 'code.index',
    permission: 'read',
    input: {
      kind: z.enum(['summary', 'file', 'symbol', 'references', 'dependents']),
      name: z.string().optional().describe('symbol/identifier name for symbol/references'),
      file: z.string().optional().describe('project-relative file path for file/dependents'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const { p, index } = idx();
      switch (args.kind) {
        case 'summary':
          return jsonOutput(d.indexer.summary(index));
        case 'file': {
          const f = index.files.find((x) => x.file === args.file?.replaceAll('\\', '/'));
          return f ? jsonOutput({ ...f, dependents: d.indexer.dependents(index, f.file, false) }) : errorOutput(`Not an indexed Luau file: ${args.file}`);
        }
        case 'symbol':
          if (!args.name) return errorOutput('name is required');
          return jsonOutput(d.indexer.findSymbol(index, args.name));
        case 'references':
          if (!args.name) return errorOutput('name is required');
          return jsonOutput(d.indexer.references(p.root, index, args.name));
        case 'dependents':
          if (!args.file) return errorOutput('file is required');
          return jsonOutput({ file: args.file, dependents: d.indexer.dependents(index, args.file.replaceAll('\\', '/'), true) });
      }
    },
  });
}
