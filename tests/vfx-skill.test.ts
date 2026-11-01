import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EASES, TRACK_TYPES, validateEffect, type EffectSpec } from '@shared/effects';
import { TEXTURE_KINDS } from '@core/effects/textures';
import { EXAMPLES } from '@core/effects/examples';
import { listEffectPresets } from '@core/effects/presets';
import { measureEffect } from '@core/effects/measure';
import { EffectSim } from '@shared/fx/sim';
import { roleFor, WORKSHOP_TOOLS } from '@core/agents/roles';
import { coreHarness } from './helpers/make-core';

const makeCore = coreHarness();
const skill = readFileSync(join(__dirname, '..', 'resources', 'skills', 'roblox-vfx', 'SKILL.md'), 'utf8');
const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!;
const body = skill.slice(skill.indexOf('\n---\n', 4) + 5);

describe('skill roblox-vfx', () => {
  it('names tools that exist, every track type, every texture kind and the worked examples', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const tools = new Set(core.tools.all().map((t) => t.name));
    const required = /required_tools: \[([^\]]+)\]/.exec(front)![1]!.split(',').map((s) => s.trim());
    for (const t of required) expect(tools.has(t), t).toBe(true);
    // Every vfx_ tool the text names is a tool.
    for (const t of new Set(body.match(/\bvfx_[a-z_]+\b/g))) expect(tools.has(t), t).toBe(true);
    for (const type of TRACK_TYPES) expect(body.includes(`\`${type}\``) || new RegExp(`"type": "${type}"`).test(body), `track ${type}`).toBe(true);
    for (const kind of Object.keys(TEXTURE_KINDS)) expect(new RegExp(`\\b${kind}\\b`).test(body), `texture kind ${kind}`).toBe(true);
    for (const id of ['FireballImpact']) expect(body.includes(id) && id in EXAMPLES).toBe(true);
    // The eases it recommends are eases.
    for (const e of new Set(body.match(/`((?:sine|quad|cubic|quart|quint|expo|circ|back|elastic|bounce)(?:In|Out|InOut))`/g))) expect((EASES as readonly string[]).includes(e.replace(/`/g, '')), e).toBe(true);
    expect(listEffectPresets().length).toBeGreaterThan(10);
  }, 60_000);

  it('its effect examples are effects that play', () => {
    const blocks = [...body.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    let checked = 0;
    for (const b of blocks) {
      let spec: EffectSpec;
      try {
        spec = JSON.parse(b) as EffectSpec;
      } catch {
        continue; // a fragment (a track list), not a whole effect
      }
      if (!spec || typeof spec !== 'object' || !('kind' in spec)) continue;
      expect(validateEffect(spec), spec.name).toEqual([]);
      const sim = new EffectSim(spec);
      expect(sim.frame().layers.length, spec.name).toBeGreaterThan(0);
      expect(measureEffect(spec).warnings.filter((w) => /blob|heavy/.test(w)), spec.name).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(1);
  });

  it('teaches the way of working the tools give: the picture, changes by path, variants, no waiting', () => {
    for (const phrase of [/contact sheet/, /by day over grass/, /`analysis\.look`|`look`/, /`set`|set: \{/, /from: "PowerUpCollect"/, /`pending: true`/, /vfx_build/, /list: true/, /between 200 and 400 studs/, /burnt to\s+white|burn out to white/]) {
      expect(phrase.test(body), String(phrase)).toBe(true);
    }
    // What it says about the tools is what the tools say.
    expect(body).toMatch(/Squash.*doubles\s+per unit/s);
    expect(body).not.toMatch(/vfx_texture lists them per kind in its error/);
  });

  it('is in the VFX artist prompt and the reviewer can look at an effect', () => {
    const artist = roleFor('vfx-artist');
    expect(artist.instructions).toMatch(/skill roblox-vfx/);
    expect(artist.instructions).toMatch(/contact sheet/);
    expect(artist.instructions).toMatch(/vfx_create \{name, set:/);
    expect(artist.instructions).toMatch(/pending: true/);
    expect(roleFor('critic').appTools).toEqual(expect.arrayContaining(['vfx_list', 'vfx_measure']));
    expect(WORKSHOP_TOOLS.effects).toEqual(expect.arrayContaining(['vfx_create', 'vfx_measure', 'vfx_texture', 'vfx_build', 'vfx_play']));
  });
});

describe('far effects', () => {
  it('warns when something seen from across a map is made of particles only', () => {
    const beacon: EffectSpec = { name: 'Beacon', kind: 'burst', tracks: [{ type: 'flash', name: 'Star', duration: 0.6, size: [150, 300] }] };
    expect(measureEffect(beacon).warnings.join(' ')).toMatch(/made of particles only: Roblox stops drawing particles somewhere between 200 and 400 studs/);
    const withPart: EffectSpec = { ...beacon, tracks: [...beacon.tracks!, { type: 'shell', shape: 'sphere', duration: 0.6, size: [40, 40, 40] }] };
    expect(measureEffect(withPart).warnings.join(' ')).not.toMatch(/particles only/);
    const hit: EffectSpec = { name: 'Hit', kind: 'burst', tracks: [{ type: 'flash', duration: 0.1, size: [3, 6] }] };
    expect(measureEffect(hit).warnings.join(' ')).not.toMatch(/particles only/);
  });
});
