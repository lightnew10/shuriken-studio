import type { ContactSheet } from './render';

/**
 * What a VFX artist would say after looking at an effect's contact sheet, taken from its pixels: layers
 * that melt into a bright background (the critic's "the cyan sheath vanishes against the sky" in the
 * user's test game), parts burnt out to white where glows pile up, layers nothing can be seen of, the
 * colour it actually comes out. `measureEffect` covers what needs no picture (cost, timing, the dark blob).
 */
export interface EffectLook {
  /** How to read the picture. */
  sheet: string;
  /** Share of the picture it covers per frame, the most it reaches and when, and how opaque the middle gets then. */
  coverage: ContactSheet['coverage'];
  /** Per stage: how much of what it draws shows there (by day also against a bright sky), how much burns out to white, the colour it reads as. */
  byDay?: { shows: string; againstSky?: string; burntToWhite: string; readsAs: string | null };
  inTheDark?: { shows: string; burntToWhite: string; readsAs: string | null };
  /** The mean of the colours its layers were given, weighted by how much each draws. */
  authoredColor: string | null;
  /** Its biggest layers: share of everything it draws, and how much of each shows by day / in the dark. */
  layers: string[];
  /** What the picture doesn't show as the game does. */
  notes: string[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function lookOf(sheet: ContactSheet): EffectLook {
  const stage = (name: 'day' | 'dark') => {
    const r = sheet.reads.find((x) => x.stage === name);
    return r ? { shows: pct(r.shown), ...(r.onSky !== undefined ? { againstSky: pct(r.onSky) } : {}), burntToWhite: pct(r.whiteOut), readsAs: r.color } : undefined;
  };
  const rows = sheet.stages.map((s) => (s === 'day' ? 'by day over grass' : 'on a dark stage'));
  return {
    sheet: `Frames at ${sheet.times.join(', ')} s, left to right; ${rows.length > 1 ? `top row ${rows[0]}, bottom row ${rows[1]}` : rows[0]}. Seen from ${sheet.distance} studs, behind and beside whoever plays it; the floor grid is 4 studs.`,
    coverage: sheet.coverage,
    ...(stage('day') ? { byDay: stage('day') } : {}),
    ...(stage('dark') ? { inTheDark: stage('dark') } : {}),
    authoredColor: sheet.authored,
    layers: sheet.layers.filter((l) => l.share >= 0.02).slice(0, 8).map((l) => `${l.name}: ${pct(l.share)} of it, shows ${l.shown.map((v, i) => `${pct(v)} ${sheet.stages[i] === 'day' ? 'by day' : 'in the dark'}`).join(' / ')}${l.onSky !== null ? ` / ${pct(l.onSky)} against sky` : ''}${l.overdraw >= 3 ? `, drawn ${Math.round(l.overdraw)}× over itself` : ''}`),
    notes: [...sheet.notes, 'Lighting and Bloom are approximated here: the final look is in Studio (vfx_play + roblox_screenshot, or a playtest).'],
  };
}

/** Warnings an artist would give from the picture (added to the measure's). */
export function lookWarnings(sheet: ContactSheet): string[] {
  const out: string[] = [];
  const day = sheet.stages.indexOf('day');
  const dark = sheet.stages.indexOf('dark');
  const read = (i: number) => (i >= 0 ? sheet.reads[i] : undefined);
  const worst = [read(day), read(dark)].filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => b.whiteOut - a.whiteOut)[0];
  if (worst && worst.whiteOut >= 0.3) {
    out.push(`At its fullest (${sheet.coverage.at} s) ${pct(worst.whiteOut)} of it is burnt out to pure white${worst.stage === 'day' ? ' by day' : ''}: glowing layers pile up there and lose their colour and their shapes. Fewer or more transparent glow layers, Brightness nearer 1, or LightEmission under 1 on the big ones, and keep white for the small hot core.`);
  }
  if (day >= 0 && dark >= 0) {
    const d = read(day)!;
    const n = read(dark)!;
    // Over the grass the picture has behind it: layers that show in the dark and melt away by day.
    const faint = sheet.layers.filter((l) => l.share >= 0.05 && l.shown[dark]! >= 0.35 && l.shown[day]! < l.shown[dark]! * 0.5);
    if (faint.length) {
      const names = (ls: typeof faint) => ls.map((l) => `${l.name} (${pct(l.shown[day]!)} of it shows; ${pct(l.shown[dark]!)} in the dark)`).join(', ');
      const glow = faint.filter((l) => l.glows);
      const pale = faint.filter((l) => !l.glows);
      if (glow.length) out.push(`By day ${names(glow)} ${glow.length > 1 ? 'mostly vanish' : 'mostly vanishes'}: glow added onto a bright background has little left to add. Back ${glow.length > 1 ? 'them' : 'it'} with a darker or less additive layer (LightEmission 0–0.4, a deeper colour, a dark rim), so the shape reads on any background.`);
      if (pale.length) out.push(`By day ${names(pale)} ${pale.length > 1 ? 'are' : 'is'} hard to see: ${pale.length > 1 ? 'their' : 'its'} colour is close to the background's. A darker or more saturated tone, or shading in the texture, gives ${pale.length > 1 ? 'them' : 'it'} an edge.`);
    }
    // Against the sky (a fight in the air, a beam at head height, a tall pillar): any glow shows less there,
    // so this is said only when most of the effect is lost, once, with the layers that lose the most.
    if (d.onSky !== undefined && d.onSky < 0.3 && n.shown >= 0.4 && d.onSky < n.shown * 0.5) {
      const lost = sheet.layers.filter((l) => l.share >= 0.1 && l.onSky !== null && l.onSky < 0.3 && !faint.includes(l)).sort((a, b) => a.onSky! - b.onSky!).slice(0, 3);
      out.push(`Against a bright sky only ${pct(d.onSky)} of it shows (${pct(n.shown)} in the dark)${lost.length ? `; ${lost.map((l) => `${l.name} ${pct(l.onSky!)}`).join(', ')}` : ''}: pale and glowing colours have nothing to add to a sky that is already bright. If it is seen against the sky (in the air, at head height, from far), give it a layer that isn't additive in a deeper colour (a core, a rim, a shadow side) and keep white for the hot centre.`);
    }
  }
  // Overdraw: a layer that draws the same pixels many times over, most of it for nothing once they are white.
  const piled = sheet.layers.filter((l) => l.share >= 0.04 && l.overdraw >= 8 && Math.max(...l.shown) < 0.3);
  for (const l of piled) out.push(`${l.name} draws the same pixels ${Math.round(l.overdraw)} times over, and only ${pct(Math.max(...l.shown))} of that shows: its particles sit on top of each other. A few bigger or brighter ones look the same and cost a fraction (overdraw is what slows phones).`);
  const all = sheet.layers.filter((l) => l.share >= 0.04 && Math.max(...l.shown) < 0.1 && !piled.includes(l));
  if (all.length) out.push(`${all.map((l) => l.name).join(', ')} ${all.length > 1 ? 'add' : 'adds'} almost nothing you can see (it lands where other layers are already white, or matches what is behind it): cut ${all.length > 1 ? 'them' : 'it'}, or move ${all.length > 1 ? 'them' : 'it'} off the bright core.`);
  if (sheet.coverage.peak <= 0.002) out.push('Nothing shows in any frame: the effect draws nothing (check its tracks, sizes and transparencies).');
  return out;
}
