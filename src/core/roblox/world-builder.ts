import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LUAU_PARSE_FAILED, withErrorLines, type RobloxStudioAdapter } from './studio-adapter';

export interface WorldBuildResult {
  file: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

/**
 * Builder scripts under world/, in the order they must run. world/world.json may pin the order
 * ({"order": ["Arena.luau", "GatheringZone.luau"]}); builders it does not list run afterwards,
 * alphabetically. Without a manifest the order is alphabetical.
 */
export function listWorldBuilders(root: string): { files: string[]; manifest: boolean; problems: string[] } {
  const dir = join(root, 'world');
  if (!existsSync(dir)) return { files: [], manifest: false, problems: [] };
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.luau'))
    .sort((a, b) => a.localeCompare(b));
  const manifestPath = join(dir, 'world.json');
  if (!existsSync(manifestPath)) return { files: all, manifest: false, problems: [] };
  const problems: string[] = [];
  let order: string[] = [];
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { order?: unknown };
    if (Array.isArray(m.order)) order = m.order.filter((x): x is string => typeof x === 'string').map((f) => f.replace(/^world\//, ''));
    else problems.push('world/world.json has no "order" array');
  } catch (e) {
    problems.push(`world/world.json is not valid JSON: ${(e as Error).message}`);
  }
  for (const f of order) if (!all.includes(f)) problems.push(`world/world.json lists ${f}, which does not exist`);
  const listed = order.filter((f) => all.includes(f));
  return { files: [...listed, ...all.filter((f) => !listed.includes(f))], manifest: true, problems };
}

/**
 * Builders Shuriken writes that place things other builders then finish (world/Models.luau places the Kiln models; a
 * builder ordered after it may group, rename, recolour or turn their parts). Run alone, it hands them back unfinished:
 * in one build the unit templates lost their team colour that way. So whoever runs it also runs the builders ordered
 * after it.
 */
const PLACES_FOR_OTHERS = new Set(['Models.luau']);

/**
 * Read-only Luau (Edit): models and mesh parts of the same name standing at the same spot (a tenth of a stud), each
 * group with where its copies are. Two builders placing the same pieces (a Kiln kit's builder and an assembly that
 * places them again) doubled a whole lobby's meshes and collision, and only the review found it.
 */
export const LUAU_DOUBLES = `local HttpService = game:GetService("HttpService")
local seen: { [string]: { string } } = {}
local n = 0
for _, inst in workspace:GetDescendants() do
	n += 1
	if n > 200000 then
		break
	end
	if inst:IsA("Model") or inst:IsA("MeshPart") then
		local parent = inst.Parent
		-- A part named like the model it is in is that model's own.
		if not (parent and parent:IsA("Model") and parent.Name == inst.Name) then
			local ok, cf = pcall(function()
				return if inst:IsA("Model") then (inst :: Model):GetPivot() else (inst :: BasePart).CFrame
			end)
			if ok then
				local p = cf.Position
				local k = string.format("%s|%.1f|%.1f|%.1f", inst.Name, p.X, p.Y, p.Z)
				local list = seen[k]
				if list then
					table.insert(list, inst:GetFullName())
				else
					seen[k] = { inst:GetFullName() }
				end
			end
		end
	end
end
local out = {}
for k, list in seen do
	if #list > 1 then
		table.insert(out, { name = string.split(k, "|")[1], at = list })
	end
end
table.sort(out, function(a, b)
	return #a.at > #b.at
end)
local top = {}
for i = 1, math.min(#out, 12) do
	top[i] = out[i]
end
return HttpService:JSONEncode({ count = #out, top = top })`;

/** What LUAU_DOUBLES found, in lines an agent acts on (none when nothing stands twice). */
export function doublesLines(raw: string): string[] {
  let r: { count?: number; top?: Array<{ name: string; at: string[] }> };
  try {
    r = JSON.parse(raw) as typeof r;
  } catch {
    return [];
  }
  if (!r.count || !r.top?.length) return [];
  return [
    `Placed more than once at the same spot (${r.count} group${r.count === 1 ? '' : 's'}: doubled meshes and collision, and code that looks one up by name may get either copy). Usually two builders place the same pieces: keep one owner and have the other build around it.`,
    ...r.top.map((d) => `- ${d.name}: ${d.at.slice(0, 4).join(', ')}${d.at.length > 4 ? ` (+${d.at.length - 4})` : ''}`),
  ];
}

/** Runs the world builders in order in the Edit DataModel and reports each one. */
/** How long one builder may take in Studio, and on its second go after it ran out of time. */
export const BUILDER_TIMEOUT = { firstMs: 180_000, againMs: 420_000 };
const BUILDER_TIMED_OUT = /timed out|Request timed out|-32001/i;

export async function rebuildWorld(studio: RobloxStudioAdapter, root: string, only?: string[], signal?: AbortSignal): Promise<{ results: WorldBuildResult[]; problems: string[]; doubles: string[] }> {
  const { files, problems } = listWorldBuilders(root);
  const asked = only?.length ? files.filter((f) => only.some((o) => o.replace(/^world\//, '') === f)) : files;
  const first = asked.findIndex((f) => PLACES_FOR_OTHERS.has(f));
  const after = first >= 0 ? files.slice(files.indexOf(asked[first]!) + 1) : [];
  const wanted = files.filter((f) => asked.includes(f) || after.includes(f));
  const results: WorldBuildResult[] = [];
  for (const file of wanted) {
    if (signal?.aborted) break;
    const code = readFileSync(join(root, 'world', file), 'utf8').replace('__REPLACE__', 'false');
    // Errors name the failing line of the builder; code that only compiles at the top level runs as is.
    let r = await studio.runLuau(withErrorLines(code), 'Edit', BUILDER_TIMEOUT.firstMs, signal);
    if (!r.ok && LUAU_PARSE_FAILED.test(r.output)) r = await studio.runLuau(code, 'Edit', BUILDER_TIMEOUT.firstMs, signal);
    // A builder that ran out of time in a busy Studio is given one more go with longer: world/Models.luau timed out
    // at 3 minutes in the rebuild after a crash (2026-10-03), and the place stayed without its Kiln models.
    if (!r.ok && !signal?.aborted && BUILDER_TIMED_OUT.test(r.output)) r = await studio.runLuau(withErrorLines(code), 'Edit', BUILDER_TIMEOUT.againMs, signal);
    results.push({ file: `world/${file}`, ok: r.ok && !/^(error|Error)[: ]/.test(r.output), output: r.output.slice(0, 1500), durationMs: r.durationMs });
  }
  // The world as the builders left it: anything they placed twice (a look only; a failure here says nothing).
  let doubles: string[] = [];
  if (results.length && results.every((r) => r.ok) && !signal?.aborted) {
    const d = await studio.runLuau(LUAU_DOUBLES, 'Edit', 30_000, signal).catch(() => null);
    if (d?.ok) doubles = doublesLines(d.output.trim());
  }
  return { results, problems, doubles };
}
