import type { UiNode } from '@shared/ui-layout';

/** What a UI capture returns (the shape `uiCaptureLuau` prints as JSON). */
export interface UiCapture {
  /** Where the ScreenGuis were read: StarterGui in Edit, or a playing client's PlayerGui. */
  source: 'StarterGui' | 'PlayerGui';
  screens: UiNode[];
  /** GuiObjects read (capped at MAX_NODES; `truncated` when there were more). */
  count: number;
  truncated: boolean;
  /** The ScreenOrientation in force (StarterGui's, or the playing client's PlayerGui's): Portrait or Sensor allow portrait. */
  orientation?: string | null;
}

export const MAX_NODES = 4000;

/** Luau shared by the capture programs: the helpers, the UI* modifiers folded into their parent, a node's own properties. */
const NODE_LUAU = `
local function r3(x) return math.floor(x * 1000 + 0.5) / 1000 end
local function rgb(c) return { math.floor(c.R * 255 + 0.5), math.floor(c.G * 255 + 0.5), math.floor(c.B * 255 + 0.5) } end
local function udim(u) return { r3(u.Scale), u.Offset } end
local function udim2(u) return { r3(u.X.Scale), u.X.Offset, r3(u.Y.Scale), u.Y.Offset } end
local function big(x) if x >= 1e9 then return 1e9 end return x end

local function fontOf(o)
  local ok, ff = pcall(function() return o.FontFace end)
  if ok and ff then
    local fam = tostring(ff.Family)
    fam = fam:match("([%w_%-]+)%.json$") or fam
    return fam, ff.Weight.Value >= 600, ff.Style == Enum.FontStyle.Italic, ff.Weight.Value
  end
  return o.Font.Name, false, false, nil
end

local function gradientOf(m)
  local cols, tr = {}, {}
  for _, k in ipairs(m.Color.Keypoints) do table.insert(cols, { r3(k.Time), math.floor(k.Value.R * 255 + 0.5), math.floor(k.Value.G * 255 + 0.5), math.floor(k.Value.B * 255 + 0.5) }) end
  for _, k in ipairs(m.Transparency.Keypoints) do table.insert(tr, { r3(k.Time), r3(k.Value) }) end
  local g = { rot = m.Rotation, colors = cols, transp = tr, offset = { r3(m.Offset.X), r3(m.Offset.Y) } }
  pcall(function()
    if m.Type.Name ~= "Linear" then g.type = m.Type.Name end
  end)
  return g
end

local function fold(n, m)
  local c = m.ClassName
  if c == "UICorner" then
    n.corner = udim(m.CornerRadius)
    -- Per-corner radii (newer Studios), when they differ.
    pcall(function()
      local tl, tr, br, bl = m.TopLeftRadius, m.TopRightRadius, m.BottomRightRadius, m.BottomLeftRadius
      if tl ~= tr or tl ~= br or tl ~= bl then n.corners = { udim(tl), udim(tr), udim(br), udim(bl) } end
    end)
  elseif c == "UIStroke" then
    if m.Enabled then
      local s = { color = rgb(m.Color), t = r3(m.Transparency), px = m.Thickness, text = m.ApplyStrokeMode == Enum.ApplyStrokeMode.Contextual }
      pcall(function()
        if m.BorderStrokePosition ~= Enum.BorderStrokePosition.Outer then s.pos = m.BorderStrokePosition.Name end
      end)
      pcall(function()
        if m.ZIndex ~= 0 then s.z = m.ZIndex end
      end)
      local g = m:FindFirstChildOfClass("UIGradient")
      if g and g.Enabled then s.gradient = gradientOf(g) end
      -- Several strokes stack by ZIndex: the first is n.stroke, all of them n.strokes.
      if n.stroke then
        n.strokes = n.strokes or { n.stroke }
        table.insert(n.strokes, s)
      else
        n.stroke = s
      end
    end
  elseif c == "UIGradient" then
    if m.Enabled then n.gradient = gradientOf(m) end
  elseif c == "UIShadow" then
    local on = true
    pcall(function() on = m.Enabled end)
    if on then
      pcall(function()
        n.shadow = { color = rgb(m.Color), t = r3(m.Transparency), blur = m.BlurRadius.Offset, spread = m.Spread.X.Offset, offset = { m.Offset.X.Offset, m.Offset.Y.Offset } }
      end)
    end
  elseif c == "UIPadding" then
    n.padding = { udim(m.PaddingTop), udim(m.PaddingRight), udim(m.PaddingBottom), udim(m.PaddingLeft) }
  elseif c == "UIListLayout" then
    local l = { dir = m.FillDirection.Name, h = m.HorizontalAlignment.Name, v = m.VerticalAlignment.Name, pad = udim(m.Padding), byName = m.SortOrder == Enum.SortOrder.Name }
    n.list = l
    pcall(function()
      if m.HorizontalFlex ~= Enum.UIFlexAlignment.None then l.hFlex = m.HorizontalFlex.Name end
      if m.VerticalFlex ~= Enum.UIFlexAlignment.None then l.vFlex = m.VerticalFlex.Name end
      if m.Wraps then l.wraps = true end
      if m.ItemLineAlignment ~= Enum.ItemLineAlignment.Automatic then l.itemAlign = m.ItemLineAlignment.Name end
    end)
  elseif c == "UIFlexItem" then
    n.flex = { mode = m.FlexMode.Name, grow = r3(m.GrowRatio), shrink = r3(m.ShrinkRatio) }
    if m.ItemLineAlignment ~= Enum.ItemLineAlignment.Automatic then n.flex.align = m.ItemLineAlignment.Name end
  elseif c == "UIPageLayout" then
    n.pages = { byName = m.SortOrder == Enum.SortOrder.Name, current = if m.CurrentPage then m.CurrentPage.Name else nil }
  elseif c == "UIGridLayout" then
    n.grid = { cell = udim2(m.CellSize), pad = udim2(m.CellPadding), dir = m.FillDirection.Name, h = m.HorizontalAlignment.Name, v = m.VerticalAlignment.Name, byName = m.SortOrder == Enum.SortOrder.Name, max = m.FillDirectionMaxCells }
  elseif c == "UIAspectRatioConstraint" then
    n.aspect = { ratio = r3(m.AspectRatio), scaleWithParent = m.AspectType == Enum.AspectType.ScaleWithParentSize, heightDominant = m.DominantAxis == Enum.DominantAxis.Height }
  elseif c == "UISizeConstraint" then
    n.sizeMin = { m.MinSize.X, m.MinSize.Y }
    n.sizeMax = { big(m.MaxSize.X), big(m.MaxSize.Y) }
  elseif c == "UITextSizeConstraint" then
    n.textMin = m.MinTextSize
    n.textMax = m.MaxTextSize
  elseif c == "UIScale" then
    n.scale = r3(m.Scale)
    -- A script that fits the scale to the screen declares its rule, so layouts can redo it per device.
    local ref, range = m:GetAttribute("FitReference"), m:GetAttribute("FitRange")
    if typeof(ref) == "Vector2" and ref.X > 0 and ref.Y > 0 then
      local ranged = typeof(range) == "NumberRange"
      n.fit = { ref = { r3(ref.X), r3(ref.Y) }, min = if ranged then r3(range.Min) else 0, max = if ranged then r3(range.Max) else 100 }
      local tenFoot = m:GetAttribute("FitTenFoot")
      if typeof(tenFoot) == "number" and tenFoot > 0 then n.fit.tenFoot = r3(tenFoot) end
    end
  end
end

-- The properties of one ScreenGui or GuiObject, written into n.
local function fill(n, o)
  if o:IsA("ScreenGui") then
    n.enabled = o.Enabled
    n.ignoreInset = o.IgnoreGuiInset
    local ok, si = pcall(function() return o.ScreenInsets end)
    if ok and si then n.insets = si.Name end
    n.displayOrder = o.DisplayOrder
    n.global = o.ZIndexBehavior == Enum.ZIndexBehavior.Global
  elseif o:IsA("GuiObject") then
    n.visible = o.Visible
    n.pos = udim2(o.Position)
    n.size = udim2(o.Size)
    n.anchor = { r3(o.AnchorPoint.X), r3(o.AnchorPoint.Y) }
    if o.Rotation ~= 0 then n.rot = r3(o.Rotation) end
    n.z = o.ZIndex
    n.order = o.LayoutOrder
    n.bg = rgb(o.BackgroundColor3)
    n.bgT = r3(o.BackgroundTransparency)
    if o.BorderSizePixel > 0 and o.BackgroundTransparency < 1 then n.border = o.BorderSizePixel; n.borderColor = rgb(o.BorderColor3) end
    if o.ClipsDescendants then n.clips = true end
    if o.AutomaticSize ~= Enum.AutomaticSize.None then n.auto = o.AutomaticSize.Name end
    if o:IsA("TextLabel") or o:IsA("TextButton") or o:IsA("TextBox") then
      local text = o.Text
      if o:IsA("TextBox") and text == "" then text = o.PlaceholderText end
      n.text = string.sub(text, 1, 2000)
      n.textColor = rgb(o.TextColor3)
      n.textT = r3(o.TextTransparency)
      n.textSize = o.TextSize
      n.scaled = o.TextScaled
      n.wrapped = o.TextWrapped
      n.font, n.bold, n.italic, n.weight = fontOf(o)
      n.xAlign = o.TextXAlignment.Name
      n.yAlign = o.TextYAlignment.Name
      n.strokeT = r3(o.TextStrokeTransparency)
      n.strokeColor = rgb(o.TextStrokeColor3)
      n.rich = o.RichText
      if o.TextTruncate ~= Enum.TextTruncate.None then n.truncate = true end
      if o.LineHeight ~= 1 then n.lineHeight = r3(o.LineHeight) end
    end
    if o:IsA("ImageLabel") or o:IsA("ImageButton") then
      n.image = o.Image
      n.imageColor = rgb(o.ImageColor3)
      n.imageT = r3(o.ImageTransparency)
      n.scaleType = o.ScaleType.Name
      if o.ScaleType == Enum.ScaleType.Slice then
        local r = o.SliceCenter
        n.slice = { r.Min.X, r.Min.Y, r.Max.X, r.Max.Y }
        if o.SliceScale ~= 1 then n.sliceScale = r3(o.SliceScale) end
      end
      if o.ResampleMode == Enum.ResamplerMode.Pixelated then n.resample = "Pixelated" end
      if o.ImageRectSize.X > 0 and o.ImageRectSize.Y > 0 then
        n.rect = { o.ImageRectOffset.X, o.ImageRectOffset.Y, o.ImageRectSize.X, o.ImageRectSize.Y }
      end
    end
    if o:IsA("ScrollingFrame") then n.canvas = udim2(o.CanvasSize) end
    -- Looping animations running on it (the Motion module marks them), for "still running while hidden".
    local loops = o:GetAttribute("MotionLoops")
    if typeof(loops) == "number" and loops > 0 then n.loops = loops end
  end
end

-- Which way up the game may be played: Portrait or Sensor let a phone turn it upright.
local function orientationOf(root)
  local ok, name = pcall(function()
    if root:IsA("PlayerGui") then return root.ScreenOrientation.Name end
    return game:GetService("StarterGui").ScreenOrientation.Name
  end)
  return if ok then name else nil
end
`;

/** Roblox's own screens in a player's PlayerGui (Studio's Freecam, touch controls, chat, prompts). */
const ROBLOX_SCREENS = 'local ROBLOX = { Freecam = true, TouchGui = true, BubbleChat = true, Chat = true, ProximityPrompts = true }';

function root(playerGui: boolean): string {
  return `local HttpService = game:GetService("HttpService")
local root
if ${playerGui ? 'true' : 'false'} then
  local lp = game:GetService("Players").LocalPlayer
  root = lp and lp:FindFirstChildOfClass("PlayerGui")
  if not root then return HttpService:JSONEncode({ error = "No local player's PlayerGui here: read it from a playing client." }) end
else
  root = game:GetService("StarterGui")
end
local MAX = ${MAX_NODES}
local count, nextId = 0, 0`;
}

/**
 * Read-only Luau that serializes every ScreenGui under StarterGui (or, with `playerGui`, the local
 * player's PlayerGui in a playing client) into UiNode JSON: the GuiObject properties layout and
 * drawing need, with UI* modifiers (UICorner, UIStroke, UIGradient, UIPadding, UIListLayout with its
 * flex, UIFlexItem, UIGridLayout, UIPageLayout, UIAspectRatioConstraint, UISizeConstraint,
 * UITextSizeConstraint, UIScale and its FitReference/FitRange attributes) folded into their parent.
 * Nothing in the place changes. The whole UI in one answer: Studio cuts an answer at about 100,000
 * characters (some 300 elements), so anything that may be bigger is read with readUi, page by page.
 */
export function uiCaptureLuau(opts: { playerGui?: boolean } = {}): string {
  return `
${root(!!opts.playerGui)}
${NODE_LUAU}
local function ser(o)
  count += 1
  if count > MAX then return nil end
  nextId += 1
  local n = { id = nextId, name = o.Name, cls = o.ClassName, kids = {} }
  fill(n, o)
  for _, c in ipairs(o:GetChildren()) do
    if c:IsA("GuiObject") then
      local k = ser(c)
      if k then table.insert(n.kids, k) end
    elseif string.sub(c.ClassName, 1, 2) == "UI" then
      pcall(fold, n, c)
    end
  end
  if #n.kids == 0 then n.kids = nil end
  return n
end

${ROBLOX_SCREENS}
local screens = {}
for _, g in ipairs(root:GetChildren()) do
  if g:IsA("ScreenGui") and not (${opts.playerGui ? 'true' : 'false'} and ROBLOX[g.Name]) then
    local s = ser(g)
    if s then table.insert(screens, s) end
  end
end
table.sort(screens, function(a, b) return (a.displayOrder or 0) < (b.displayOrder or 0) end)
return HttpService:JSONEncode({ source = ${opts.playerGui ? '"PlayerGui"' : '"StarterGui"'}, screens = screens, count = math.min(count, MAX), truncated = count > MAX, orientation = orientationOf(root) })
`;
}

/**
 * Characters of node records one page of the UI asks for. Studio cuts an execute_luau answer at about 100,000
 * characters; a page well under that arrives whole (the DataModel snapshot pages at the same size). A page that
 * still comes back cut is asked for again at half the size. An object so a test can shorten it.
 */
export const UI_PAGE = { chars: 80_000, minChars: 4000, attempts: 3 };

/**
 * One page of the UI: the same walk as uiCaptureLuau (depth first, ids in that order), but the nodes come as a
 * flat list with their parent's id, only those after node `from`, and only as many as fit in `budget` characters.
 * `next` is the node to start the next page after (-1 when this was the last); `count` is the whole UI's size, so
 * pages that disagree about it were read from a UI that changed in between.
 */
export function uiCapturePageLuau(opts: { playerGui?: boolean; from: number; budget: number }): string {
  return `
${root(!!opts.playerGui)}
${NODE_LUAU}
local FROM, BUDGET = ${Math.max(0, Math.floor(opts.from))}, ${Math.max(1, Math.floor(opts.budget))}
local out, size, full, nextFrom = {}, 0, false, -1
local function ser(o, parent)
  count += 1
  if count > MAX then return end
  nextId += 1
  local id = nextId
  if id > FROM and not full then
    local n = { id = id, parent = parent, name = o.Name, cls = o.ClassName }
    fill(n, o)
    for _, c in ipairs(o:GetChildren()) do
      if not c:IsA("GuiObject") and string.sub(c.ClassName, 1, 2) == "UI" then pcall(fold, n, c) end
    end
    local chars = #HttpService:JSONEncode(n) + 1
    if #out > 0 and size + chars > BUDGET then
      full = true
      nextFrom = id - 1
    else
      table.insert(out, n)
      size += chars
    end
  end
  for _, c in ipairs(o:GetChildren()) do
    if c:IsA("GuiObject") then ser(c, id) end
  end
end
${ROBLOX_SCREENS}
for _, g in ipairs(root:GetChildren()) do
  if g:IsA("ScreenGui") and not (${opts.playerGui ? 'true' : 'false'} and ROBLOX[g.Name]) then ser(g, 0) end
end
return HttpService:JSONEncode({ source = ${opts.playerGui ? '"PlayerGui"' : '"StarterGui"'}, nodes = out, count = math.min(count, MAX), truncated = count > MAX, from = FROM, next = nextFrom, orientation = orientationOf(root) })
`;
}

interface UiPage {
  source: UiCapture['source'];
  /** JSONEncode writes an empty table as []. */
  nodes: Array<UiNode & { parent: number }>;
  count: number;
  truncated: boolean;
  from: number;
  next: number;
  orientation?: string | null;
  error?: string;
}

/** What reads a page: the Studio adapter's runLuau. */
export interface UiReader {
  runLuau(code: string, datamodel: 'Edit' | 'Client', timeoutMs?: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }>;
}

/**
 * Reads the UI page by page and puts the tree back together. A UI of more than about 300 elements does not fit in
 * one answer from Studio: read in one piece it came back cut off, the JSON would not parse, and ui_audit said
 * "The playing client didn't answer" for every game with a real menu. A UI that changes while its pages are read
 * (scripts still building it) is read again, at most UI_PAGE.attempts times; the last attempt takes what it gets.
 */
export async function readUi(studio: UiReader, playerGui: boolean, signal?: AbortSignal): Promise<UiCapture> {
  let budget = UI_PAGE.chars;
  for (let attempt = 1; ; attempt++) {
    const nodes: UiPage['nodes'] = [];
    let from = 0;
    let first: UiPage | null = null;
    let changed = false;
    for (;;) {
      const r = await studio.runLuau(uiCapturePageLuau({ playerGui, from, budget }), playerGui ? 'Client' : 'Edit', 45_000, signal);
      if (!r.ok) throw new Error(r.output);
      let page: UiPage | null = null;
      try {
        page = JSON.parse(r.output.trim()) as UiPage;
      } catch {
        /* cut by Studio: below */
      }
      if (!page || typeof page.next !== 'number') {
        if (page?.error) throw new Error(page.error);
        if (budget <= UI_PAGE.minChars) throw new Error(`Studio's answer was cut off (${r.output.length} characters, even for pages of ${budget}): the UI could not be read.`);
        budget = Math.max(UI_PAGE.minChars, Math.floor(budget / 2));
        continue;
      }
      first ??= page;
      if (page.count !== first.count) changed = true;
      if (Array.isArray(page.nodes)) nodes.push(...page.nodes);
      if (page.next < 0) break;
      if (page.next <= from) throw new Error(`The UI capture made no progress at element ${from}`);
      from = page.next;
    }
    if (changed && attempt < UI_PAGE.attempts) continue;
    return assembleUi(nodes, first!);
  }
}

/** The tree from a flat list in depth-first order (each node carries its parent's id; 0 for a screen). */
function assembleUi(flat: UiPage['nodes'], page: Pick<UiPage, 'source' | 'count' | 'truncated' | 'orientation'>): UiCapture {
  const byId = new Map<number, UiNode>();
  const screens: UiNode[] = [];
  for (const { parent, ...rest } of flat) {
    const node = rest as UiNode;
    byId.set(node.id, node);
    const above = byId.get(parent);
    if (above) (above.kids ??= []).push(node);
    else if (parent === 0) screens.push(node);
  }
  screens.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  return { source: page.source, screens, count: page.count, truncated: page.truncated, orientation: page.orientation ?? null };
}
