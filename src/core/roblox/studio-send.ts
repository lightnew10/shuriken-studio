import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from './studio-adapter';
import { CAPABILITY_ERROR } from './probe-bridge';
import type { ToolOutput as ToolResult } from '../capabilities/tool-registry';
import { AnimationStore } from '../animation/animation-service';

/**
 * "Send to Studio" from the docks: one click puts what the user is working on into the open place,
 * where they are looking — a model resting on the surface in front of Studio's camera, an animation
 * on a stand-in character or its creature that plays it when the game runs — and selects it there.
 */
export interface StudioSendDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  invokeTool: (name: string, args: unknown) => Promise<ToolResult>;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  /** Where it went in the place. */
  placed?: string;
  /** A sentence for the user. */
  note?: string;
}

/** Luau: the point Studio's camera looks at (the surface it hits, else 30 studs ahead). */
export const CAMERA_TARGET_LUAU = `local cam = workspace.CurrentCamera
local cf = cam.CFrame
local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
params.FilterDescendantsInstances = {}
local hit = workspace:Raycast(cf.Position, cf.LookVector * 1000, params)
local p = if hit then hit.Position else cf.Position + cf.LookVector * 30
local r = function(v) return math.round(v * 100) / 100 end
return game:GetService("HttpService"):JSONEncode({ r(p.X), r(p.Y), r(p.Z) })`;

/** Luau: selects an instance by its dotted path (so it's highlighted in Studio's Explorer and viewport). */
export function selectLuau(path: string): string {
  return `local inst = game
for _, seg in string.split(${JSON.stringify(path)}, ".") do
  local nxt = inst:FindFirstChild(seg)
  if not nxt and inst == game then
    local ok, svc = pcall(function() return game:GetService(seg) end)
    if ok then nxt = svc end
  end
  if not nxt then return "" end
  inst = nxt
end
game:GetService("Selection"):Set({ inst })
return inst:GetFullName()`;
}

/**
 * Luau: a Script that plays an animation on its model when the game runs (looping ones once, one-shots
 * again every moment), so a preview shows it with Run (F8) or Play.
 */
export function previewScriptLuau(requirePath: string, clip: string): string {
  return `-- Shuriken preview: plays "${clip}" on this model while the game runs. Delete the model when done.
local Anims = require(${requirePath})
local model = script.Parent
task.wait(0.5)
while model.Parent do
  local track = Anims.play(model, ${JSON.stringify(clip)})
  if not track then
    warn("Shuriken preview: no animation named ${clip} (build the animations first)")
    break
  end
  if track.Looped then break end
  track.Stopped:Wait()
  task.wait(0.8)
end`;
}

const textOf = (r: ToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join(' ');

export class StudioSend {
  constructor(private readonly d: StudioSendDeps) {}

  private ready(): string | null {
    if (!this.d.project()) return 'No project is open.';
    const av = this.d.studio.availability();
    return av.ok ? null : `Roblox Studio isn't connected (${av.reason ?? 'not open'}): open this project's place in Studio, then send again.`;
  }

  /** Where Studio's camera is looking now. */
  async target(): Promise<[number, number, number]> {
    const r = await this.d.studio.runLuau(CAMERA_TARGET_LUAU, 'Edit', 20_000);
    if (!r.ok) throw new Error(`Couldn't read Studio's camera: ${r.output.slice(0, 200)}`);
    const v = JSON.parse(r.output.trim()) as number[];
    return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  }

  private async select(path: string | undefined): Promise<void> {
    if (path) await this.d.studio.runLuau(selectLuau(path), 'Edit', 15_000).catch(() => null);
  }

  /** A model (one part or a whole multi-part model) into the place where Studio's camera looks. */
  async model(name: string): Promise<SendResult> {
    const why = this.ready();
    if (why) return { ok: false, error: why };
    const position = await this.target();
    const r = await this.d.invokeTool('model_place', { name, position, on_ground: true });
    if (r.isError) return { ok: false, error: textOf(r).slice(0, 600) };
    const data = (r.data ?? {}) as { placed?: string; permanent?: boolean; note?: string; bloom?: string; uploading?: boolean };
    // Its parts are still uploading to Roblox (they carry on): nothing is placed yet.
    if (data.uploading) return { ok: false, error: `${name} is still uploading to Roblox (it carries on in the background): send it again in a minute.` };
    await this.select(data.placed);
    const note = data.permanent === false ? `Placed ${name} as a temporary mesh (not saved with the place): ${data.note ?? 'it could not be uploaded'}` : `Placed ${name} in front of Studio's camera and selected it.`;
    return { ok: true, placed: data.placed, note: data.bloom ? `${note} ${data.bloom}.` : note };
  }

  /**
   * An animation into the place: its creature (a copy of the rig template, rig_build) or, for R15 moves,
   * a stand-in character, in front of Studio's camera, with a script that plays it when the game runs.
   */
  async animation(name: string): Promise<SendResult> {
    const why = this.ready();
    if (why) return { ok: false, error: why };
    const p = this.d.project()!;
    const store = new AnimationStore(p.root);
    const f = store.get(name);
    if (!f) return { ok: false, error: `No animation named ${name}` };
    if (f.draft) return { ok: false, error: `${name} is a draft, so Studio doesn't have it: add it to the game first (Add to game).` };
    const built = await this.d.invokeTool('animation_build', {});
    if (built.isError && !/broken|did not build/i.test(textOf(built))) return { ok: false, error: textOf(built).slice(0, 600) };
    const requirePath = AnimationStore.runtimeLocation(p.extras().syncMap).requirePath;
    const position = await this.target();
    const previewName = `${name}Preview`;
    let placed: string | undefined;
    if (f.clip.rig) {
      const r = await this.d.invokeTool('rig_build', { model: f.clip.rig, place: { position, name: previewName } });
      if (r.isError) return { ok: false, error: textOf(r).slice(0, 600) };
      if ((r.data as { uploading?: boolean } | undefined)?.uploading) return { ok: false, error: `${f.clip.rig}'s parts are still uploading to Roblox (they carry on in the background): send it again in a minute.` };
      placed = `Workspace.${previewName}`;
    } else {
      // A default R15 character standing there (anchored, so it stays put while it plays).
      const r = await this.d.studio.runLuau(
        `local rig = game:GetService("Players"):CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R15)
for _, d in rig:GetDescendants() do if d:IsA("LuaSourceContainer") then d:Destroy() end end
rig.Name = ${JSON.stringify(previewName)}
local old = workspace:FindFirstChild(rig.Name)
if old then old:Destroy() end
local hrp = rig:WaitForChild("HumanoidRootPart")
hrp.Anchored = true
rig:PivotTo(CFrame.new(${position[0]}, ${position[1] + 3}, ${position[2]}))
rig.Parent = workspace
return rig:GetFullName()`,
        'Edit',
        30_000,
      );
      if (!r.ok) return { ok: false, error: `Couldn't place a character to show it on: ${r.output.slice(0, 300)}` };
      placed = `Workspace.${previewName}`;
    }
    let s = await this.d.studio.runLuau(
      `local model = workspace:FindFirstChild(${JSON.stringify(previewName)})
if not model then return "missing" end
local old = model:FindFirstChild("ShurikenPreview")
if old then old:Destroy() end
local sc = Instance.new("Script")
sc.Name = "ShurikenPreview"
sc.Source = ${JSON.stringify(previewScriptLuau(requirePath, name))}
sc.Parent = model
model:SetAttribute("ShurikenPreview", ${JSON.stringify(name)})
return "ok"`,
      'Edit',
      20_000,
    );
    // Studio refusing a script made in Luau (2026-10-01): its own script tool makes it instead.
    if (!s.ok && CAPABILITY_ERROR.test(s.output) && !previewName.includes('.')) {
      const made = await this.d.studio.call('multi_edit', { file_path: `game.Workspace.${previewName}.ShurikenPreview`, className: 'Script', datamodel_type: 'Edit', edits: [{ old_string: '', new_string: previewScriptLuau(requirePath, name) }] }, { timeoutMs: 20_000 });
      if (made.ok) s = await this.d.studio.runLuau(`workspace:FindFirstChild(${JSON.stringify(previewName)}):SetAttribute("ShurikenPreview", ${JSON.stringify(name)})\nreturn "ok"`, 'Edit', 20_000);
      else s = { ...s, output: made.error ?? s.output };
    }
    if (!s.ok || s.output.trim() !== 'ok') return { ok: false, error: `Placed it, but couldn't add its preview script: ${s.output.slice(0, 300)}` };
    await this.select(placed);
    return { ok: true, placed, note: `${f.clip.rig ? `A ${f.clip.rig}` : 'A stand-in character'} now stands in front of Studio's camera (${previewName}); press Run (F8) or Play to see ${name}. Delete it when you're done.` };
  }
}
