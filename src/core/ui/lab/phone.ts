import { isButton, isText, layoutScreen, plainText, type UiBox, type UiNode } from '@shared/ui-layout';
import { labDevice, normalizeInsets, type LabDevice } from './devices';
import type { LabFinding, LabSubject } from './lab';
import { robloxMeasure } from './roblox-fonts';

/**
 * Phone checks across a version's layouts, tuned on what blind judges marked down on phones while every other check
 * passed (`tests/fixtures/ui-judged`):
 * - labels the phone layout drops while what they name stays on screen: a grid's item names, the PAINT caption over
 *   the swatches, a button's caption, the HEALTH label of a bar (a whole part left off the phone is a choice, not a
 *   loss);
 * - lists that show too few whole items without scrolling on the smallest phone ("only 2 of 6 upgrades");
 * - framed panels reaching past the safe area: into the home indicator or the notch, or off the screen;
 * - buttons hugging the edge of the safe area (a swatch 1-2 pt from the bottom of an iPhone SE).
 */
export function phoneChecks(subject: LabSubject, devices: LabDevice[]): LabFinding[] {
  const phones = devices.filter((d) => d.form === 'phone');
  if (!phones.length) return [];
  return [...droppedLabels(subject, phones), ...shortLists(subject, phones), ...pastSafeArea(subject, phones), ...atTheEdge(subject, phones)];
}

/** Elements as shown (Visible = false hides a subtree), by path. */
function shown(screens: UiNode[]): Map<string, UiNode> {
  const m = new Map<string, UiNode>();
  const walk = (n: UiNode, p: string) => {
    if (n.visible === false) return;
    m.set(p, n);
    for (const k of n.kids ?? []) walk(k, `${p}.${k.name}`);
  };
  for (const s of screens) walk(s, s.name);
  return m;
}

const reads = (n: UiNode) => isText(n) && plainText(n).trim().length > 1 && (n.textT ?? 0) < 0.9;
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('.'));
const leafOf = (p: string) => p.slice(p.lastIndexOf('.') + 1);
const quote = (list: string[], n = 3) => `${list.slice(0, n).map((t) => `"${t.slice(0, 18)}"`).join(', ')}${list.length > n ? '…' : ''}`;

function droppedLabels(subject: LabSubject, phones: LabDevice[]): LabFinding[] {
  const desk = labDevice('desktop');
  if (!desk) return [];
  const wide = shown(subject.screensOn(desk));
  const out: LabFinding[] = [];
  // Landscape and upright phones may each have their own layout.
  for (const group of [phones.filter((d) => d.orientation === 'landscape'), phones.filter((d) => d.orientation === 'portrait')]) {
    if (!group.length) continue;
    const phone = shown(subject.screensOn(group[0]!));
    const said = new Set([...phone.values()].filter(reads).map((n) => plainText(n).trim()));
    const lost: string[] = [];
    for (const [p, n] of wide) {
      if (!reads(n)) continue;
      const q = phone.get(p);
      if (q && reads(q)) continue;
      // Moved or reworded on the phone, or its whole part left off: not a loss.
      if (said.has(plainText(n).trim()) || !phone.has(parentOf(p))) continue;
      lost.push(p);
    }
    // A label on its own names the small group it sits in (the PAINT caption and its swatches, a button's caption
    // over its price); in a panel of many parts it is one detail the phone may leave out.
    const captions = (p: string) => (wide.get(parentOf(p))?.kids?.length ?? 99) <= 4;
    for (let i = lost.length - 1; i >= 0; i--) {
      const p = lost[i]!;
      const repeated = lost.filter((q) => leafOf(q) === leafOf(p) && parentOf(parentOf(q)) === parentOf(parentOf(p))).length >= 3;
      if (!repeated && !captions(p)) lost.splice(i, 1);
    }
    if (!lost.length) continue;
    const ids = group.map((d) => d.id);
    // Repeated items losing the same label (Slot1.ItemName, Slot2.ItemName…): the items can't be told apart.
    const byItem = new Map<string, string[]>();
    for (const p of lost) {
      const key = `${parentOf(parentOf(p))}|${leafOf(p)}`;
      byItem.set(key, [...(byItem.get(key) ?? []), p]);
    }
    const single: string[] = [];
    for (const [key, list] of byItem) {
      const [where, leaf] = key.split('|') as [string, string];
      // Icon buttons on a HUD (Shop, Pets, Rebirth as icons on a phone) are how phone HUDs are built; a menu's items
      // (a backpack's slots, a shop's cards) lose what they are without their names.
      const menu = !!wide.get(where.split('.')[0]!)?.hides;
      const icon = (n: UiNode | undefined) => !!n?.image || /:(icon|coin):/.test(n?.skin ?? '');
      const icons = list.every((p) => [...wide.keys()].some((q) => q.startsWith(`${parentOf(p)}.`) && icon(wide.get(q))));
      // What an item is called is its main text (the largest): a description under it is a detail the phone may drop.
      const sizeOf = (n: UiNode | undefined) => n?.textSize ?? 14;
      // (most of the items: a slot with a bigger stack count is still named by its name)
      const main = list.filter((p) => {
        const item = parentOf(p);
        const texts = [...wide.entries()].filter(([q, n]) => q.startsWith(`${item}.`) && reads(n));
        return texts.every(([, n]) => sizeOf(n) <= sizeOf(wide.get(p)));
      }).length * 2 >= list.length;
      if (list.length < 3 || (!menu && icons) || !main) {
        if (list.length < 3) single.push(...list);
        continue;
      }
      const texts = list.map((p) => plainText(wide.get(p)!).trim());
      out.push({
        category: 'layout',
        severity: 'warning',
        path: where,
        message: `On a phone ${list.length} of its items lose their ${leaf} (${quote(texts)}), which the desktop shows: players can't tell them apart. Keep a short name on each, or show the picked one's name beside the grid`,
        devices: ids,
      });
    }
    if (single.length) {
      const texts = single.map((p) => plainText(wide.get(p)!).trim());
      // Where they are: the deepest path every one of them shares.
      const parts = single.map((p) => p.split('.'));
      let common = parts[0]!;
      for (const ps of parts.slice(1)) {
        let i = 0;
        while (i < common.length && common[i] === ps[i]) i++;
        common = common.slice(0, i);
      }
      out.push({
        category: 'layout',
        severity: 'warning',
        path: common.join('.') || parentOf(single[0]!),
        message: `The phone layout drops ${single.length} label${single.length === 1 ? '' : 's'} the desktop shows while what ${single.length === 1 ? 'it names stays' : 'they name stays'} on screen (${quote(texts, 4)}): say what each thing is on the phone too (shorter, smaller, but there)`,
        devices: ids,
      });
    }
  }
  return out;
}

/** What draws: text, an image, forged art, a button, a fill. */
const draws = (b: UiBox) =>
  (isText(b.node) && !!plainText(b.node).trim()) || !!b.node.image || !!b.node.skin || b.node.skinned !== undefined || isButton(b.node) || (!!b.node.bg && (b.node.bgT ?? 0) < 0.5);

function laidOut(subject: LabSubject, d: LabDevice): UiBox[] {
  return subject.screensOn(d).map(normalizeInsets).flatMap((s) => layoutScreen(s, d, { measure: robloxMeasure }));
}

function shortLists(subject: LabSubject, phones: LabDevice[]): LabFinding[] {
  // The smallest landscape phone: where a list shows fewest items.
  const d = [...phones].filter((x) => x.orientation === 'landscape').sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (!d) return [];
  const boxes = laidOut(subject, d);
  const drawsAny = (b: UiBox) => draws(b) || boxes.some((x) => x.path.startsWith(`${b.path}.`) && draws(x));
  const out: LabFinding[] = [];
  for (const sc of boxes.filter((b) => b.node.cls === 'ScrollingFrame' && b.w > 1 && b.h > 1)) {
    const depth = sc.path.split('.').length + 1;
    const items = boxes.filter((b) => b.path.startsWith(`${sc.path}.`) && b.path.split('.').length === depth && b.w > 4 && b.h > 4 && drawsAny(b));
    if (items.length < 4) continue;
    // What of the list a player sees: the frame within whatever clips it and the screen's safe area.
    const [cx, cy, cw, ch] = sc.clip ?? [sc.x, sc.y, sc.w, sc.h];
    const x0 = Math.max(sc.x, cx, d.side ?? 0);
    const y0 = Math.max(sc.y, cy, 0);
    const x1 = Math.min(sc.x + sc.w, cx + cw, d.w - (d.side ?? 0));
    const y1 = Math.min(sc.y + sc.h, cy + ch, d.h - (d.bottom ?? 0));
    const whole = items.filter((b) => b.x >= x0 - 1 && b.y >= y0 - 1 && b.x + b.w <= x1 + 1 && b.y + b.h <= y1 + 1).length;
    if (whole < 3)
      out.push({
        category: 'layout',
        severity: 'warning',
        path: sc.path,
        message: `Only ${whole} of its ${items.length} items show whole without scrolling on a ${d.label}: the list reads as nearly empty. Make the rows shorter on the phone, give the list more of the screen, or show two columns`,
        devices: [d.id],
      });
    else if (whole * 2 <= items.length && items.length >= 5)
      out.push({ category: 'layout', severity: 'note', path: sc.path, message: `${whole} of its ${items.length} items show whole without scrolling on a ${d.label}: a little more room per row on the phone shows more of the list`, devices: [d.id] });
  }
  return out;
}

function pastSafeArea(subject: LabSubject, phones: LabDevice[]): LabFinding[] {
  const found = new Map<string, LabFinding>();
  for (const d of phones) {
    const boxes = laidOut(subject, d);
    const screen = d.w * d.h;
    for (const b of boxes) {
      // A framed panel holding text or buttons (not a backdrop that bleeds to the edges on purpose).
      if (!draws(b) || isText(b.node) || b.w * b.h < 0.2 * screen || b.w * b.h > 0.92 * screen || b.w >= 0.98 * d.w) continue;
      if (!boxes.some((x) => x.path.startsWith(`${b.path}.`) && (isButton(x.node) || (isText(x.node) && !!plainText(x.node).trim())))) continue;
      const side = d.side ?? 0;
      const gaps = { left: b.x - side, right: d.w - side - (b.x + b.w), bottom: d.h - (d.bottom ?? 0) - (b.y + b.h) };
      const [edge, gap] = Object.entries(gaps).sort((a, c) => a[1] - c[1])[0]!;
      if (gap >= -2) continue;
      const into = edge === 'bottom' ? (d.bottom ? 'into the home indicator' : 'off the screen') : side ? 'into the notch' : 'off the screen';
      const key = `${b.path}|${into}`;
      const prev = found.get(key);
      if (prev) prev.devices.push(d.id);
      else
        found.set(key, {
          category: 'layout',
          severity: 'warning',
          path: b.path,
          message: `Its frame reaches ${Math.round(-gap)} pt past the ${edge} of the safe area, ${into}, on a ${d.label}: keep 8+ pt inside it on phones (a smaller window or the phone's own layout)`,
          devices: [d.id],
        });
    }
  }
  return [...found.values()];
}

/** Buttons within 4 pt of the safe area's left, right or bottom edge on a landscape phone (a thumb on the case). */
function atTheEdge(subject: LabSubject, phones: LabDevice[]): LabFinding[] {
  const found = new Map<string, LabFinding>();
  for (const d of phones.filter((x) => x.orientation === 'landscape')) {
    const side = d.side ?? 0;
    for (const b of laidOut(subject, d)) {
      if (!isButton(b.node) || b.w < 8 || b.h < 8 || b.w >= 0.9 * d.w || b.w * b.h >= 0.5 * d.w * d.h) continue;
      const [cx, cy, cw, ch] = b.clip ?? [b.x, b.y, b.w, b.h];
      if (b.x + b.w <= cx || b.y + b.h <= cy || b.x >= cx + cw || b.y >= cy + ch) continue;
      const gaps = { left: b.x - side, right: d.w - side - (b.x + b.w), bottom: d.h - (d.bottom ?? 0) - (b.y + b.h) };
      const [edge, gap] = Object.entries(gaps).sort((a, c) => a[1] - c[1])[0]!;
      // Under 0 is cut or under the notch (other checks say so); 0-4 pt is hugging the edge.
      if (gap < 0 || gap >= 4) continue;
      const key = `${b.path}|${edge}`;
      const prev = found.get(key);
      if (prev) prev.devices.push(d.id);
      else
        found.set(key, {
          category: 'touch',
          severity: 'warning',
          path: b.path,
          message: `Sits ${Math.round(gap * 10) / 10} pt from the ${edge} edge of the safe area on a ${d.label}: a thumb on the phone's case can't hit it cleanly, and it reads as cut off. Keep 8+ pt inside on phones`,
          devices: [d.id],
        });
    }
  }
  return [...found.values()];
}
