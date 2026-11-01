import { useEffect, useMemo, useState } from 'react';
import type { UiDevice, UiNode } from '@shared/ui-layout';
import { MOCK_DEVICES, type MockVersion } from '@shared/ui-mockup';
import type { ForgeWorn } from '@shared/ui-forge';
import { rpc } from '../../lib/rpc';
import { wearsSkins, wornRefs } from '../../lib/skin-css';

/**
 * A mockup version's forged skins for the Mockups view: its screens per device with every skin worn as the game
 * wears it (core forge.worn: the art as each element's "Skin" child, its text in a "Label", the states' art), and
 * the art itself. Each device is asked for on its own (the core forges two at once) and shows as soon as its art is
 * here. The art the page has is kept for the session and named in each request, so each comes once.
 */

const ART_KEPT = 400;
const art = new Map<string, string>();

/** Keeps the art a response brings (and what the version wears, newest last); the oldest of the rest makes room. */
function keep(refs: string[], images: ForgeWorn['images']): void {
  for (const ref of refs) {
    const url = images[ref]?.url ?? art.get(ref);
    art.delete(ref);
    if (url) art.set(ref, url);
  }
  const wanted = new Set(refs);
  for (const ref of [...art.keys()]) {
    if (art.size <= ART_KEPT) break;
    if (!wanted.has(ref)) art.delete(ref);
  }
}

type Got = { key: string; devices: Partial<Record<UiDevice, { screens: UiNode[]; refs: string[] }>>; errors: string[] };

export function useWornSkins(name: string | null | undefined, v: MockVersion | undefined, devices: UiDevice[] = MOCK_DEVICES): { screens: Partial<Record<UiDevice, UiNode[]>> | null; images: Record<string, string>; loading: boolean; errors: string[] } {
  const skinned = useMemo(() => wearsSkins(v), [v]);
  const key = name && v && skinned ? `${name}@${v.id}#${v.rev ?? 1}@${v.revisedAt ?? v.createdAt}` : null;
  const [got, setGot] = useState<Got | null>(null);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!key || !v || !name) return;
    let live = true;
    setGot({ key, devices: {}, errors: [] });
    setPending(devices.length);
    for (const device of devices) {
      rpc<ForgeWorn>('forge.worn', { name, version: v.id, devices: [device], have: [...art.keys()] })
        .then((r) => {
          if (!live || !r.skinned) return;
          const screens = r.screens[device] ?? [];
          const refs = wornRefs(screens);
          keep(refs, r.images);
          setGot((g) => (g && g.key === key ? { ...g, devices: { ...g.devices, [device]: { screens, refs } }, errors: [...new Set([...g.errors, ...r.errors])] } : g));
        })
        .catch(() => {})
        .finally(() => live && setPending((n) => Math.max(0, n - 1)));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = got && got.key === key ? got : null;
  const { screens, images } = useMemo(() => {
    const images: Record<string, string> = {};
    const screens: Partial<Record<UiDevice, UiNode[]>> = {};
    for (const [d, x] of Object.entries(current?.devices ?? {}) as Array<[UiDevice, { screens: UiNode[]; refs: string[] }]>) {
      // A device shows worn once all its art is here (until then, the version's own fills).
      if (!x.refs.every((r) => art.has(r))) continue;
      for (const r of x.refs) images[r] = art.get(r)!;
      screens[d] = x.screens;
    }
    return { screens, images };
  }, [current]);
  return { screens: Object.keys(screens).length ? screens : null, images, loading: !!key && pending > 0, errors: current?.errors ?? [] };
}
