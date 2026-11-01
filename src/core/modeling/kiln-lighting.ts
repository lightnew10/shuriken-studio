import { createHash } from 'node:crypto';

/**
 * The place's Lighting as Kiln 0.7.3 takes it (`lighting` on POST /projects and POST /projects/:id/target):
 * Kiln lights its Roblox preview and its copilot's own renders like the game, so a model is judged under
 * the light it will be seen in. Read from Studio with a read-only Luau snippet; never required: a place
 * that can't be read just leaves Kiln on a new place's defaults.
 */

export type Rgb = [number, number, number];

export interface KilnLighting {
  brightness?: number;
  ambient?: Rgb;
  outdoorAmbient?: Rgb;
  clockTime?: number;
  latitude?: number;
  envDiffuse?: number;
  envSpecular?: number;
  exposure?: number;
  atmosphere?: { density?: number; offset?: number; haze?: number; glare?: number; color?: Rgb; decay?: Rgb } | null;
  bloom?: { intensity?: number; size?: number; threshold?: number } | null;
  colorCorrection?: { brightness?: number; contrast?: number; saturation?: number; tint?: Rgb } | null;
}

/** Read-only Luau: Lighting's own properties and its Atmosphere / BloomEffect / ColorCorrectionEffect children (enabled ones), as JSON. */
export const LIGHTING_LUAU = `local L = game:GetService("Lighting")
local H = game:GetService("HttpService")
local function c3(c) return { c.R, c.G, c.B } end
local function try(f) local ok, v = pcall(f) if ok then return v end return nil end
local function child(class)
  for _, x in L:GetChildren() do
    if x:IsA(class) and (x:IsA("PostEffect") == false or x.Enabled) then return x end
  end
  return nil
end
local out = {
  Brightness = try(function() return L.Brightness end),
  Ambient = try(function() return c3(L.Ambient) end),
  OutdoorAmbient = try(function() return c3(L.OutdoorAmbient) end),
  ClockTime = try(function() return L.ClockTime end),
  GeographicLatitude = try(function() return L.GeographicLatitude end),
  EnvironmentDiffuseScale = try(function() return L.EnvironmentDiffuseScale end),
  EnvironmentSpecularScale = try(function() return L.EnvironmentSpecularScale end),
  ExposureCompensation = try(function() return L.ExposureCompensation end),
}
local a = child("Atmosphere")
if a then out.Atmosphere = { Density = a.Density, Offset = a.Offset, Haze = a.Haze, Glare = a.Glare, Color = c3(a.Color), Decay = c3(a.Decay) } end
local b = child("BloomEffect")
if b then out.Bloom = { Intensity = b.Intensity, Size = b.Size, Threshold = b.Threshold } end
local cc = child("ColorCorrectionEffect")
if cc then out.ColorCorrection = { Brightness = cc.Brightness, Contrast = cc.Contrast, Saturation = cc.Saturation, TintColor = c3(cc.TintColor) } end
return H:JSONEncode(out)`;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10_000) / 10_000 : undefined);
const rgb = (v: unknown): Rgb | undefined => {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const c = v.slice(0, 3).map(num);
  return c.every((x) => x !== undefined) ? (c as Rgb) : undefined;
};
const drop = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** What Studio's snippet returned (Roblox property names) as the contract's lighting; null when there's nothing usable. */
export function mapLighting(raw: unknown): KilnLighting | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sub = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
  const a = sub(o.Atmosphere);
  const b = sub(o.Bloom);
  const cc = sub(o.ColorCorrection);
  const out: KilnLighting = drop({
    brightness: num(o.Brightness),
    ambient: rgb(o.Ambient),
    outdoorAmbient: rgb(o.OutdoorAmbient),
    clockTime: num(o.ClockTime),
    latitude: num(o.GeographicLatitude),
    envDiffuse: num(o.EnvironmentDiffuseScale),
    envSpecular: num(o.EnvironmentSpecularScale),
    exposure: num(o.ExposureCompensation),
    atmosphere: a ? drop({ density: num(a.Density), offset: num(a.Offset), haze: num(a.Haze), glare: num(a.Glare), color: rgb(a.Color), decay: rgb(a.Decay) }) : null,
    bloom: b ? drop({ intensity: num(b.Intensity), size: num(b.Size), threshold: num(b.Threshold) }) : null,
    colorCorrection: cc ? drop({ brightness: num(cc.Brightness), contrast: num(cc.Contrast), saturation: num(cc.Saturation), tint: rgb(cc.TintColor) }) : null,
  });
  // Nothing numeric came back (an unreadable place): not a lighting, so nothing to send.
  return Object.entries(out).some(([k, v]) => v !== undefined && v !== null && !['atmosphere', 'bloom', 'colorCorrection'].includes(k)) ? out : null;
}

/** A stable hash of a lighting: the same place twice gives the same one, any change a different one. */
export function lightingHash(l: KilnLighting): string {
  return createHash('sha1').update(JSON.stringify(l)).digest('hex').slice(0, 16);
}

/** The slice of the Studio adapter this needs (so it is testable without Studio). */
export interface LightingSource {
  connected: boolean;
  luauJson<T>(code: string, datamodel?: 'Edit' | 'Server' | 'Client', timeoutMs?: number): Promise<T>;
}

/** The place's Lighting from Studio, or null when Studio isn't connected or the read fails (never throws). */
export async function readPlaceLighting(studio: LightingSource): Promise<KilnLighting | null> {
  if (!studio.connected) return null;
  try {
    return mapLighting(await studio.luauJson<unknown>(LIGHTING_LUAU, 'Edit', 8_000));
  } catch {
    return null;
  }
}
