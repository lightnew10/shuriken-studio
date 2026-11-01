/**
 * Whether Roblox has approved an uploaded image yet. A texture that is still in Roblox's review renders flat grey
 * in Studio and in the game until it is approved: in the first 1.13 build a warehouse and four props stood grey
 * for 40 minutes, the critic failed the modeler's task for it ("looks like an untextured blockout") and proposed
 * re-uploading, which would only have queued the images again. Roblox's public thumbnail service says where an
 * image is (no key, no sign-in): Completed, Pending or InReview, Blocked.
 */
export type ImageState = 'approved' | 'pending' | 'blocked' | 'unknown';

const STATE: Record<string, ImageState> = { Completed: 'approved', Pending: 'pending', InReview: 'pending', Blocked: 'blocked' };

/** The states of image assets by id ('unknown' where Roblox didn't say, or it couldn't be asked). */
export async function imageStates(ids: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, ImageState>> {
  const out = new Map<string, ImageState>();
  const unique = [...new Set(ids.filter((id) => /^\d{4,}$/.test(id)))];
  for (const id of unique) out.set(id, 'unknown');
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    try {
      const res = await fetchImpl(`https://thumbnails.roblox.com/v1/assets?assetIds=${batch.join(',')}&size=150x150&format=Png&isCircular=false`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: Array<{ targetId: number | string; state: string }> };
      for (const t of body.data ?? []) out.set(String(t.targetId), STATE[t.state] ?? 'unknown');
    } catch {
      // Offline or refused: those stay unknown.
    }
  }
  return out;
}

/**
 * Collects the images that colour the parts under a path of the place (a SurfaceAppearance's ColorMap, a
 * MeshPart's TextureID, a Decal or Texture): JSON `[{ id, at }]`, one entry per image, with one instance that uses it.
 */
export const imagesInUseLuau = (path: string) => `local HttpService = game:GetService("HttpService")
local function resolve(path)
  local node = game
  for seg in string.gmatch(path, "[^/%.]+") do
    if node == game then
      local ok, svc = pcall(function() return game:GetService(seg) end)
      node = ok and svc or game:FindFirstChild(seg)
    else
      node = node:FindFirstChild(seg)
    end
    if not node then return nil end
  end
  return node
end
local roots = {}
local asked = ${JSON.stringify(path)}
if asked ~= "" then
  local r = resolve(asked)
  if not r then return HttpService:JSONEncode({ error = "no instance at " .. asked }) end
  roots = { r }
else
  roots = { workspace, game:GetService("ReplicatedStorage"), game:GetService("ServerStorage") }
end
local seen, out = {}, {}
local function add(value, inst)
  local id = type(value) == "string" and string.match(value, "%d%d%d%d+") or nil
  if id and not seen[id] and #out < 300 then
    seen[id] = true
    table.insert(out, { id = id, at = inst:GetFullName() })
  end
end
for _, root in roots do
  for _, d in root:GetDescendants() do
    if d:IsA("SurfaceAppearance") then
      local ok, v = pcall(function() return d.ColorMap end)
      if ok then add(v, d.Parent or d) end
    elseif d:IsA("MeshPart") then
      add(d.TextureID, d)
    elseif d:IsA("Decal") then
      add(d.Texture, d)
    end
  end
end
return HttpService:JSONEncode(out)`;

/**
 * What to tell whoever just placed a textured model whose images Roblox is still reviewing, or null when none is
 * (or it can't be told). `path`: the placed instance ("Workspace.Map.Warehouse", with or without "game.").
 */
export async function reviewNote(
  studio: { runLuau(code: string, dm: 'Edit', timeoutMs?: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> },
  states: (ids: string[]) => Promise<Map<string, ImageState>>,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!path) return null;
  try {
    const r = await studio.runLuau(imagesInUseLuau(path.replace(/^game\./, '')), 'Edit', 20_000, signal);
    const used = r.ok ? (JSON.parse(r.output) as Array<{ id: string }> | { error: string }) : null;
    if (!Array.isArray(used) || !used.length) return null;
    const got = await states(used.map((u) => u.id));
    const pending = used.filter((u) => got.get(u.id) === 'pending').length;
    if (!pending) return null;
    return `${pending} of its ${used.length} texture image(s) are still in Roblox's review: those parts show FLAT GREY in Studio and in playtests until Roblox approves them (minutes, sometimes an hour). Nothing is wrong and nothing is to be done: don't re-upload, repaint or replace them with flat colours, and don't report it as a defect; judge the look with model_view. texture_status says when they are through.`;
  } catch {
    return null;
  }
}
