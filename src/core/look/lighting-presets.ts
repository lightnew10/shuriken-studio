import { z } from 'zod';
import type { LookMood } from './look-analysis';

/**
 * Lighting and atmosphere presets as data: starting points by time of day and mood, which the environment
 * artist adapts to the game's brief (lighting_set {preset, adjust}) and which land as a generated, idempotent
 * builder (world/Lighting.luau from world/Lighting.json), so the look is code on disk and rebuilds with the
 * world. Each preset says what it is for, what to change for which brief, and what look_analyze should roughly
 * measure on a gameplay-height screenshot (targets, conventions, not laws).
 *
 * Provenance: "sunny_cartoon" was checked in Studio (Sept 2026, skill roblox-environment-art v5); "dusk_haze"
 * is the 2026-10-01 arena's final Lighting.luau with a neutral grade instead of its warm tint (its screenshots
 * measured b* +22 to +30 and one hue family 77-92%); the others are the skill's earlier recipes and common
 * practice, not yet measured in Studio: screenshot each and run look_analyze before relying on the targets.
 */

export type Rgb = [number, number, number];

const rgb = z.union([
  z.tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)]),
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .transform((h): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]),
]);

/** Every property a preset or an adjustment may set, with the ranges Studio's Properties window allows. */
export const lightingLookSchema = z.object({
  lighting: z
    .object({
      ClockTime: z.number().min(0).max(24),
      GeographicLatitude: z.number().min(-90).max(90),
      Brightness: z.number().min(0).max(10),
      ExposureCompensation: z.number().min(-3).max(3),
      Ambient: rgb,
      OutdoorAmbient: rgb,
      ColorShift_Top: rgb,
      ColorShift_Bottom: rgb,
      EnvironmentDiffuseScale: z.number().min(0).max(1),
      EnvironmentSpecularScale: z.number().min(0).max(1),
      GlobalShadows: z.boolean(),
      ShadowSoftness: z.number().min(0).max(1),
      LightingStyle: z.enum(['Realistic', 'Soft']),
      PrioritizeLightingQuality: z.boolean(),
    })
    .partial(),
  atmosphere: z.union([z.literal(false), z.object({ Density: z.number().min(0).max(1), Offset: z.number().min(0).max(1), Color: rgb, Decay: rgb, Glare: z.number().min(0).max(10), Haze: z.number().min(0).max(10) }).partial()]),
  sky: z
    .object({
      SunAngularSize: z.number().min(0).max(60),
      MoonAngularSize: z.number().min(0).max(60),
      StarCount: z.number().int().min(0).max(5000),
      CelestialBodiesShown: z.boolean(),
      SkyboxBk: z.string(),
      SkyboxDn: z.string(),
      SkyboxFt: z.string(),
      SkyboxLf: z.string(),
      SkyboxRt: z.string(),
      SkyboxUp: z.string(),
    })
    .partial()
    .optional(),
  clouds: z.union([z.literal(false), z.object({ Cover: z.number().min(0).max(1), Density: z.number().min(0).max(1), Color: rgb }).partial()]).optional(),
  bloom: z.union([z.literal(false), z.object({ Intensity: z.number().min(0).max(1), Size: z.number().min(0).max(56), Threshold: z.number().min(0).max(4) }).partial()]),
  colorCorrection: z.union([z.literal(false), z.object({ Brightness: z.number().min(-1).max(1), Contrast: z.number().min(-1).max(1), Saturation: z.number().min(-1).max(1), TintColor: rgb }).partial()]),
  sunRays: z.union([z.literal(false), z.object({ Intensity: z.number().min(0).max(1), Spread: z.number().min(0).max(1) }).partial()]),
  depthOfField: z.union([z.literal(false), z.object({ FarIntensity: z.number().min(0).max(1), FocusDistance: z.number().min(0).max(200), InFocusRadius: z.number().min(0).max(50), NearIntensity: z.number().min(0).max(1) }).partial()]),
});
export type LightingLook = z.output<typeof lightingLookSchema>;
/** An adjustment: any part of a look; a section set to false removes that piece (no Bloom, no Atmosphere…). */
export const lightingAdjustSchema = lightingLookSchema.partial();
export type LightingAdjust = z.output<typeof lightingAdjustSchema>;

export interface LightingPreset {
  /** When to start from it. */
  intent: string;
  /** What to change for which brief. */
  adapt: string;
  /** The mood to pass look_analyze, and what it should roughly measure at gameplay height (targets, not laws). */
  expect: { mood: LookMood; medianL: [number, number]; note: string };
  /** Where the numbers come from. */
  source: string;
  look: LightingLook;
}

const OFF = { sunRays: false, depthOfField: false } as const;

export const LIGHTING_PRESETS = {
  sunny_cartoon: {
    intent: "The default modern-cartoon look (the studio's default art style): sunny, soft, saturated, readable from anywhere.",
    adapt: 'More playful: Saturation up to 0.25. Calmer for a hub: Bloom.Intensity 0.25. Never more than 0.3 saturation or Bloom washing out the sky.',
    expect: { mood: 'day', medianL: [50, 72], note: 'two or more hue families, chroma 20-40, no cast beyond b* +15' },
    source: 'checked in Studio, Sept 2026 (skill roblox-environment-art v5)',
    look: {
      lighting: { ClockTime: 14, Brightness: 3.2, Ambient: [110, 110, 125], OutdoorAmbient: [150, 150, 165], EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, GlobalShadows: true, ExposureCompensation: 0 },
      atmosphere: { Density: 0.22, Offset: 0.3, Color: [205, 225, 255], Decay: [140, 170, 220], Glare: 0, Haze: 0.6 },
      bloom: { Intensity: 0.35, Size: 22, Threshold: 1.8 },
      colorCorrection: { Brightness: 0, Contrast: 0.06, Saturation: 0.2, TintColor: [255, 252, 245] },
      sunRays: { Intensity: 0.04, Spread: 0.8 },
      depthOfField: false,
    },
  },
  clear_day: {
    intent: 'Realistic midday: competitive shooters, sports, racing, anything where reading targets beats mood.',
    adapt: 'Long sightlines: Atmosphere.Density 0.2-0.25 and Haze ≤ 1. Hotter climate: OutdoorAmbient a little warmer, Haze 1.5. Never DepthOfField in gameplay.',
    expect: { mood: 'day', medianL: [40, 62], note: 'value range (5-95%) 50+, far contrast at least 40% of near' },
    source: "the skill's day recipe (v2-v5); not yet measured in Studio",
    look: {
      lighting: { ClockTime: 14, Brightness: 3, Ambient: [70, 72, 82], OutdoorAmbient: [128, 128, 140], EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, GlobalShadows: true, ShadowSoftness: 0.2, ExposureCompensation: 0, LightingStyle: 'Realistic' },
      atmosphere: { Density: 0.3, Offset: 0.25, Color: [199, 205, 215], Decay: [106, 115, 130], Glare: 0, Haze: 1 },
      bloom: { Intensity: 0.4, Size: 24, Threshold: 1.6 },
      colorCorrection: { Brightness: 0, Contrast: 0.05, Saturation: 0.1, TintColor: [255, 255, 255] },
      sunRays: { Intensity: 0.05, Spread: 0.8 },
      depthOfField: false,
    },
  },
  golden_hour: {
    intent: 'Late afternoon, low warm sun and long shadows: adventure, exploration, open worlds, a lobby that sells the mood.',
    adapt: 'Keep play readable into the sun: Glare ≤ 0.4, Haze ≤ 1.5. Cooler shadows for contrast: OutdoorAmbient toward blue-grey. Less orange overall: TintColor nearer white.',
    expect: { mood: 'golden', medianL: [38, 60], note: 'warm cast b* +10 to +30, shadows cooler than lights, two or more hue families' },
    source: "the skill's golden recipe (v2-v5); not yet measured in Studio",
    look: {
      lighting: { ClockTime: 17.6, GeographicLatitude: 35, Brightness: 2.5, Ambient: [80, 64, 60], OutdoorAmbient: [150, 115, 95], EnvironmentDiffuseScale: 0.8, EnvironmentSpecularScale: 1, GlobalShadows: true, ShadowSoftness: 0.3, LightingStyle: 'Realistic' },
      atmosphere: { Density: 0.35, Offset: 0.2, Color: [255, 214, 175], Decay: [165, 110, 90], Glare: 0.6, Haze: 2 },
      bloom: { Intensity: 0.6, Size: 28, Threshold: 1.3 },
      colorCorrection: { Brightness: 0, Contrast: 0.08, Saturation: 0.15, TintColor: [255, 242, 228] },
      sunRays: { Intensity: 0.12, Spread: 0.8 },
      depthOfField: false,
    },
  },
  dusk_haze: {
    intent: 'Sun just above the horizon through dust or smog: industrial, post-apocalyptic, war, scrapyard arenas.',
    adapt: 'Fights at range: Density ≤ 0.27, Haze ≤ 1, Glare ≤ 0.1 (targets looking into the sun). Keep the grade neutral: the low sun already makes everything orange, so a warm TintColor or Atmosphere.Color turns the frame monochrome; put cool colour in OutdoorAmbient and in accents.',
    expect: { mood: 'dusk', medianL: [28, 48], note: 'b* at most +20 and no hue family over 75% (the arena that started from a warm grade measured b* +22 to +30 and 77-92% orange)' },
    source: "the 2026-10-01 arena's final lighting with a neutral grade; not yet measured in Studio",
    look: {
      lighting: { ClockTime: 17.4, GeographicLatitude: 28, Brightness: 2.6, Ambient: [62, 68, 76], OutdoorAmbient: [108, 116, 126], ColorShift_Top: [255, 200, 150], ColorShift_Bottom: [38, 54, 62], EnvironmentDiffuseScale: 0.35, EnvironmentSpecularScale: 0.5, GlobalShadows: true, ShadowSoftness: 0.45, ExposureCompensation: 0.1, LightingStyle: 'Realistic' },
      atmosphere: { Density: 0.27, Offset: 0.08, Color: [176, 166, 150], Decay: [112, 104, 100], Glare: 0.08, Haze: 0.9 },
      sky: { SunAngularSize: 12 },
      bloom: { Intensity: 0.4, Size: 22, Threshold: 1.9 },
      colorCorrection: { Brightness: 0, Contrast: 0.12, Saturation: 0.04, TintColor: [250, 248, 246] },
      sunRays: { Intensity: 0.05, Spread: 0.5 },
      depthOfField: false,
    },
  },
  overcast: {
    intent: 'Grey, soft, shadowless daylight: rain, northern towns, calm survival, the quiet before horror.',
    adapt: 'Rain: pair it with the VFX artist\'s weather (skill roblox-vfx). Gloomier: Brightness 1.2, Saturation -0.15. Keep a few saturated accents (signs, gear) or it reads colourless.',
    expect: { mood: 'overcast', medianL: [42, 64], note: 'low chroma (under 20) is the point; values still span 35+' },
    source: 'common practice; not yet measured in Studio',
    look: {
      lighting: { ClockTime: 12, Brightness: 1.6, Ambient: [95, 98, 104], OutdoorAmbient: [150, 152, 158], EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 0.6, GlobalShadows: true, ShadowSoftness: 1, LightingStyle: 'Soft' },
      atmosphere: { Density: 0.4, Offset: 0.15, Color: [190, 195, 200], Decay: [140, 145, 150], Glare: 0, Haze: 2.5 },
      sky: { CelestialBodiesShown: false },
      clouds: { Cover: 0.9, Density: 0.6, Color: [200, 200, 205] },
      bloom: { Intensity: 0.2, Size: 24, Threshold: 2.2 },
      colorCorrection: { Brightness: 0, Contrast: 0.04, Saturation: -0.08, TintColor: [245, 248, 255] },
      ...OFF,
    },
  },
  misty_morning: {
    intent: 'Low sun through thick mist: forests, swamps, mysteries, horror that wants distance hidden.',
    adapt: 'Horror: Density 0.65, Brightness 1.4, Saturation -0.15. For gameplay that needs range, mist is the wrong preset: start from clear_day.',
    expect: { mood: 'overcast', medianL: [48, 70], note: 'the distance fades on purpose: far contrast under 35% of near; the near ground keeps 35+ L* of range' },
    source: "the skill's mist recipe (v2-v5); not yet measured in Studio",
    look: {
      lighting: { ClockTime: 9, Brightness: 2, Ambient: [70, 78, 76], OutdoorAmbient: [120, 132, 128], EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 0.7, GlobalShadows: true, ShadowSoftness: 0.6 },
      atmosphere: { Density: 0.55, Offset: 0.1, Color: [185, 202, 196], Decay: [110, 125, 120], Glare: 0, Haze: 3 },
      bloom: { Intensity: 0.3, Size: 24, Threshold: 1.8 },
      colorCorrection: { Brightness: 0, Contrast: 0, Saturation: -0.05, TintColor: [236, 255, 244] },
      sunRays: { Intensity: 0.03, Spread: 0.8 },
      depthOfField: false,
    },
  },
  night_moon: {
    intent: 'A readable moonlit night: stealth, horror, camping, night levels. Local lights (lamps, torches, windows) do the work.',
    adapt: 'Too dark to play: OutdoorAmbient up (cool blue-grey) or ExposureCompensation +0.3, never Brightness of a noon sun. Lamps: warm PointLights along paths, Shadows on only the few hero lights.',
    expect: { mood: 'night', medianL: [14, 34], note: 'crushed under 8%, the paths readable, blue cast is the point' },
    source: "the skill's night recipe (v2-v5); not yet measured in Studio",
    look: {
      lighting: { ClockTime: 0, Brightness: 1, Ambient: [34, 36, 52], OutdoorAmbient: [55, 60, 88], EnvironmentDiffuseScale: 0.5, EnvironmentSpecularScale: 1, GlobalShadows: true, ShadowSoftness: 0.4, LightingStyle: 'Realistic' },
      atmosphere: { Density: 0.4, Offset: 0.15, Color: [62, 72, 110], Decay: [28, 30, 48], Glare: 0, Haze: 1.5 },
      sky: { StarCount: 3000, CelestialBodiesShown: true },
      bloom: { Intensity: 0.8, Size: 30, Threshold: 0.9 },
      colorCorrection: { Brightness: 0, Contrast: 0.1, Saturation: 0, TintColor: [225, 232, 255] },
      ...OFF,
    },
  },
  neon_night: {
    intent: 'A city or sci-fi night lit by neon and signs: cyberpunk, racing at night, clubs, sci-fi bases.',
    adapt: 'Neon blooms because Threshold is low: keep Neon to trims and signs, never big walls. Wet streets: EnvironmentSpecularScale 1 with reflective materials. Two accent hues (e.g. magenta and cyan), not five.',
    expect: { mood: 'night', medianL: [12, 32], note: 'loud colour under 25% of the frame, clipped under 2% below the horizon' },
    source: 'common practice; not yet measured in Studio',
    look: {
      lighting: { ClockTime: 22, Brightness: 0.5, Ambient: [30, 28, 48], OutdoorAmbient: [40, 44, 80], EnvironmentDiffuseScale: 0.5, EnvironmentSpecularScale: 1, GlobalShadows: true, ShadowSoftness: 0.3, LightingStyle: 'Realistic' },
      atmosphere: { Density: 0.35, Offset: 0.1, Color: [70, 60, 120], Decay: [30, 20, 60], Glare: 0, Haze: 1 },
      bloom: { Intensity: 0.9, Size: 32, Threshold: 1 },
      colorCorrection: { Brightness: 0, Contrast: 0.15, Saturation: 0.15, TintColor: [235, 230, 255] },
      ...OFF,
    },
  },
  interior_dark: {
    intent: 'Dungeons, caves, bunkers, haunted houses: no sky light at all, every light is placed.',
    adapt: 'Light pools mark the path and the goal; darkness between them is fine, black where the player must act is not. A faint Ambient (not black) keeps silhouettes.',
    expect: { mood: 'interior', medianL: [10, 30], note: 'pools of light: values span 50+, crushed under 8%' },
    source: "the skill's dungeon recipe (v2-v5); not yet measured in Studio",
    look: {
      lighting: { ClockTime: 0, Brightness: 0, Ambient: [28, 24, 32], OutdoorAmbient: [0, 0, 0], EnvironmentDiffuseScale: 0, EnvironmentSpecularScale: 0.5, GlobalShadows: true, ShadowSoftness: 0.3, LightingStyle: 'Realistic' },
      atmosphere: { Density: 0.5, Offset: 0, Color: [40, 34, 44], Decay: [20, 16, 22], Glare: 0, Haze: 0 },
      sky: { CelestialBodiesShown: false, StarCount: 0 },
      bloom: { Intensity: 0.9, Size: 26, Threshold: 0.85 },
      colorCorrection: { Brightness: 0, Contrast: 0.12, Saturation: 0.05, TintColor: [255, 236, 214] },
      ...OFF,
    },
  },
} satisfies Record<string, LightingPreset>;

export type LightingPresetName = keyof typeof LIGHTING_PRESETS;
export const PRESET_NAMES = Object.keys(LIGHTING_PRESETS) as LightingPresetName[];

/**
 * Lighting properties every preset sets unless it says otherwise (their engine defaults), so switching presets
 * doesn't leave the last one's colour shift or exposure behind.
 */
const BASE_LIGHTING: LightingLook['lighting'] = { ExposureCompensation: 0, ColorShift_Top: [0, 0, 0], ColorShift_Bottom: [0, 0, 0], ShadowSoftness: 0.2 };

/** A preset with an adjustment on top (sections merge property by property; false removes a piece). */
export function resolveLighting(preset: LightingPresetName, adjust: LightingAdjust = {}): LightingLook {
  const base = structuredClone(LIGHTING_PRESETS[preset].look) as LightingLook;
  const out: Record<string, unknown> = { ...base, lighting: { ...BASE_LIGHTING, ...base.lighting } };
  for (const [k, v] of Object.entries(adjust)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = v === false ? false : { ...(cur && typeof cur === 'object' ? cur : {}), ...v };
  }
  return lightingLookSchema.parse(out);
}

/** Two adjustments, the later winning property by property (lighting_set without a preset keeps refining). */
export function mergeAdjust(a: LightingAdjust, b: LightingAdjust): LightingAdjust {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = v === false ? false : { ...(cur && typeof cur === 'object' ? cur : {}), ...v };
  }
  return out as LightingAdjust;
}

export const LIGHTING_MARKER = "-- Built by Shuriken's lighting_set from world/Lighting.json.";

function luau(v: unknown, indent = ''): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `{ ${v.map((x) => luau(x)).join(', ')} }`;
  if (v && typeof v === 'object') {
    const inner = `${indent}\t`;
    const rows = Object.entries(v).map(([k, x]) => `${inner}${k} = ${luau(x, inner)},`);
    return rows.length ? `{\n${rows.join('\n')}\n${indent}}` : '{}';
  }
  return 'nil';
}

/**
 * The builder: sets Lighting's properties, replaces the one Atmosphere and the post effects it owns (one of each
 * class), keeps an existing Sky (and its skybox) while setting the given Sky properties, and the Terrain's Clouds.
 * Each property is set on its own, so one Studio can't-set (a property a newer or older Studio lacks) is reported,
 * not fatal.
 */
export function lightingBuilderLuau(look: LightingLook, preset: string): string {
  return `${LIGHTING_MARKER}
-- Preset "${preset}" with this game's adjustments. Change it with lighting_set (adjust), or write this file by hand
-- (then it is yours and lighting_set leaves it alone).
local Lighting = game:GetService("Lighting")
local LOOK: { [string]: any } = ${luau(look)}

local skipped: { string } = {}
local function value(key: string, v: any): any
	if type(v) == "table" then
		return Color3.fromRGB(v[1], v[2], v[3])
	elseif key == "LightingStyle" then
		return (Enum :: any).LightingStyle[v]
	end
	return v
end
local function apply(inst: Instance, props: { [string]: any })
	for key, v in props do
		local ok, err = pcall(function()
			(inst :: any)[key] = value(key, v)
		end)
		if not ok then
			table.insert(skipped, key .. " (" .. tostring(err) .. ")")
		end
	end
end

apply(Lighting, LOOK.lighting)
local EFFECTS = {
	{ key = "atmosphere", class = "Atmosphere", name = "Atmosphere" },
	{ key = "bloom", class = "BloomEffect", name = "Bloom" },
	{ key = "colorCorrection", class = "ColorCorrectionEffect", name = "Grade" },
	{ key = "sunRays", class = "SunRaysEffect", name = "SunRays" },
	{ key = "depthOfField", class = "DepthOfFieldEffect", name = "DepthOfField" },
}
for _, e in EFFECTS do
	for _, c in Lighting:GetChildren() do
		if c:IsA(e.class) then
			c:Destroy()
		end
	end
	local props = LOOK[e.key]
	if type(props) == "table" then
		local inst = Instance.new(e.class)
		inst.Name = e.name
		apply(inst, props)
		inst.Parent = Lighting
	end
end
if type(LOOK.sky) == "table" then
	local sky: Instance = Lighting:FindFirstChildOfClass("Sky") or Instance.new("Sky")
	apply(sky, LOOK.sky)
	sky.Parent = Lighting
end
local terrain = workspace:FindFirstChildOfClass("Terrain")
if terrain and LOOK.clouds == false then
	local old = terrain:FindFirstChildOfClass("Clouds")
	if old then
		old:Destroy()
	end
elseif terrain and type(LOOK.clouds) == "table" then
	local clouds = terrain:FindFirstChildOfClass("Clouds") or Instance.new("Clouds")
	apply(clouds, LOOK.clouds)
	clouds.Parent = terrain
end
Lighting:SetAttribute("LightingPreset", ${JSON.stringify(preset)})
return "lighting: ${preset} @ " .. Lighting.ClockTime .. (if #skipped > 0 then "; could not set " .. table.concat(skipped, "; ") else "")
`;
}
