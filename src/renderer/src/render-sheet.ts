import { clipDuration, sampleClip } from '@shared/animation';
import { forwardKinematics } from '@shared/rig';
import { filmstripTimes, type RenderRequest } from '@shared/render';
import { ICON_SIZE, ICON_VIEWS, alphaBounds, iconFit, outlinePx } from '@shared/icon';
import { ModelView, PLAYER_HEIGHT } from './components/models/model-view';
import { MannequinView } from './components/anim/mannequin';
import { installForgePage } from './lib/forge-gl/forge-page';

/**
 * The model sheet's panels: [label, azimuth, elevation (radians; the Models page opens at 0.7, 0.42),
 * with the player]. The last is a close-up from behind with no player, so small props show detail.
 */
const VIEWS: Array<[string, number, number, boolean]> = [
  ['Three-quarter', 0.7, 0.42, true],
  ['Front', 0, 0.08, true],
  ['Side', Math.PI / 2, 0.08, true],
  ['Close-up from behind', 0.7 + Math.PI, 0.35, false],
];

const LABEL = '600 18px "Segoe UI", Arial, sans-serif';
const NOTE = '500 15px "Segoe UI", Arial, sans-serif';

function stage(w: number, h: number): HTMLDivElement {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px`;
  document.body.appendChild(host);
  return host;
}

/** Three angles beside a default Roblox character (5.2 studs) and a close-up, drawn by the Models page's view. */
async function modelSheet(req: Extract<RenderRequest, { kind: 'model' }>): Promise<string> {
  const size = 512;
  const host = stage(size, size);
  const view = new ModelView(host, { player: true, still: true });
  try {
    await view.loadParts(req.parts.map((x) => ({ url: `data:model/gltf-binary;base64,${x.glb}`, color: x.color, material: x.material, origin: x.origin, instances: x.instances })));
    const sheet = document.createElement('canvas');
    sheet.width = size * 2;
    sheet.height = size * 2;
    const ctx = sheet.getContext('2d')!;
    VIEWS.forEach(([label, az, el, player], i) => {
      view.setPlayer(player);
      view.setView(az, el);
      const x = (i % 2) * size;
      const y = Math.floor(i / 2) * size;
      ctx.drawImage(view.renderNow(), x, y, size, size);
      ctx.font = LABEL;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(label, x + 14, y + 28);
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(size, size * 2);
    ctx.moveTo(0, size);
    ctx.lineTo(size * 2, size);
    ctx.stroke();
    ctx.font = NOTE;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`${req.name ? `${req.name} · ` : ''}blue-grey figure = a default Roblox character, ${PLAYER_HEIGHT} studs tall`, 14, size * 2 - 14);
    return sheet.toDataURL('image/jpeg', 0.86);
  } finally {
    view.dispose();
    host.remove();
  }
}

/**
 * A UI icon of a model: drawn alone on a transparent background from the asked angle, cropped to what was
 * drawn, scaled to fill the square, with a dark outline so it reads on any panel colour (the sticker look of
 * shop cards and counters). A PNG.
 */
async function iconPicture(req: Extract<RenderRequest, { kind: 'icon' }>): Promise<string> {
  const out = Math.max(64, Math.min(1024, Math.round(req.size ?? ICON_SIZE)));
  const draw = 768;
  const host = stage(draw, draw);
  const view = new ModelView(host, { still: true, bare: true });
  const canvas = (side: number) => {
    const c = document.createElement('canvas');
    c.width = side;
    c.height = side;
    return c;
  };
  try {
    await view.loadParts(req.parts.map((x) => ({ url: `data:model/gltf-binary;base64,${x.glb}`, color: x.color, material: x.material, origin: x.origin, instances: x.instances })));
    const [az, el] = ICON_VIEWS[req.view ?? 'three-quarter'];
    view.setView(az, el);
    const raw = canvas(draw);
    const rctx = raw.getContext('2d', { willReadFrequently: true })!;
    rctx.drawImage(view.renderNow(), 0, 0, draw, draw);
    const box = alphaBounds(rctx.getImageData(0, 0, draw, draw).data, draw, draw);
    if (!box) throw new Error('nothing was drawn');
    const stroke = outlinePx(out, req.outline !== false);
    const at = iconFit(box, out, stroke);
    const body = canvas(out);
    const bctx = body.getContext('2d')!;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(raw, box.x, box.y, box.w, box.h, at.x, at.y, at.w, at.h);
    const icon = canvas(out);
    const ictx = icon.getContext('2d')!;
    if (stroke) {
      // The model's silhouette in the outline colour, stamped around a circle, then the model on top.
      const sil = canvas(out);
      const sctx = sil.getContext('2d')!;
      sctx.drawImage(body, 0, 0);
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = '#15110f';
      sctx.fillRect(0, 0, out, out);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        ictx.drawImage(sil, Math.cos(a) * stroke, Math.sin(a) * stroke);
      }
    }
    ictx.drawImage(body, 0, 0);
    return icon.toDataURL('image/png');
  } finally {
    view.dispose();
    host.remove();
  }
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('frame did not load'));
    img.src = src;
  });

/** A filmstrip of a clip on the R15 mannequin (the Animation page's), frames snapped to its markers. */
async function animationSheet(req: Extract<RenderRequest, { kind: 'animation' }>): Promise<string> {
  const clip = req.clip;
  const duration = clipDuration(clip);
  const markers = clip.markers ?? [];
  const times = filmstripTimes(duration, markers, req.frames ?? 8);
  // Square frames on a square stage: room for a sword's whole arc beside the character.
  const fw = 270;
  const fh = 270;
  const cols = Math.min(4, times.length);
  const rows = Math.ceil(times.length / cols);
  const host = stage(900, 900);
  const view = new MannequinView(host, {});
  try {
    view.playing = false;
    view.setClip(clip, { sword: req.sword ?? false });
    const shots = await Promise.all(view.snapshots(times, fw, fh).map(loadImage));
    const footer = 34;
    const sheet = document.createElement('canvas');
    sheet.width = cols * fw;
    sheet.height = rows * fh + footer;
    const ctx = sheet.getContext('2d')!;
    ctx.fillStyle = '#1b1714';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    shots.forEach((img, i) => {
      const x = (i % cols) * fw;
      const y = Math.floor(i / cols) * fh;
      ctx.drawImage(img, x, y, fw, fh);
      const at = markers.filter((m) => Math.abs(m.t - times[i]!) < 0.0015).map((m) => m.name);
      ctx.font = LABEL;
      ctx.fillStyle = at.length ? '#ffb454' : 'rgba(255,255,255,0.88)';
      ctx.fillText(`${times[i]!.toFixed(2)} s${at.length ? ` · ${at.join(', ')}` : ''}`, x + 10, y + 24);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.strokeRect(x + 0.5, y + 0.5, fw - 1, fh - 1);
    });
    ctx.font = NOTE;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    const markerText = markers.length ? ` · markers: ${markers.map((m) => `${m.name} at ${m.t.toFixed(2)} s`).join(', ')}` : '';
    ctx.fillText(`${req.name ?? clip.name} · ${duration.toFixed(2)} s · ${clip.loop ? 'loops' : 'plays once'}${markerText}`, 12, rows * fh + 23);
    return sheet.toDataURL('image/jpeg', 0.86);
  } finally {
    view.dispose();
    host.remove();
  }
}

/**
 * A filmstrip of a custom rig's clip on the rigged model itself (the Models page's view, each part moved
 * by its segment's joints), frames snapped to its markers.
 */
async function rigAnimationSheet(req: Extract<RenderRequest, { kind: 'rig-animation' }>): Promise<string> {
  const clip = req.clip;
  const duration = clipDuration(clip);
  const markers = clip.markers ?? [];
  const times = filmstripTimes(duration, markers, req.frames ?? 8);
  const fw = 300;
  const fh = 300;
  const cols = Math.min(4, times.length);
  const rows = Math.ceil(times.length / cols);
  const host = stage(fw, fh);
  const view = new ModelView(host, { still: true });
  try {
    await view.loadParts(req.parts.map((x) => ({ url: `data:model/gltf-binary;base64,${x.glb}`, color: x.color, material: x.material, origin: x.origin, segment: x.segment })));
    // Three-quarter from the front right, a little above: legs, tail and head all show.
    view.setView(0.9, 0.3);
    const footer = 34;
    const sheet = document.createElement('canvas');
    sheet.width = cols * fw;
    sheet.height = rows * fh + footer;
    const ctx = sheet.getContext('2d')!;
    ctx.fillStyle = '#1b1714';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    times.forEach((t, i) => {
      view.pose(forwardKinematics(req.rig, sampleClip(clip, t)));
      const x = (i % cols) * fw;
      const y = Math.floor(i / cols) * fh;
      ctx.drawImage(view.renderNow(), x, y, fw, fh);
      const at = markers.filter((m) => Math.abs(m.t - t) < 0.0015).map((m) => m.name);
      ctx.font = LABEL;
      ctx.fillStyle = at.length ? '#ffb454' : 'rgba(255,255,255,0.88)';
      ctx.fillText(`${t.toFixed(2)} s${at.length ? ` · ${[...new Set(at)].join(', ')}` : ''}`, x + 10, y + 24);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.strokeRect(x + 0.5, y + 0.5, fw - 1, fh - 1);
    });
    ctx.font = NOTE;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    const markerText = markers.length ? ` · markers: ${[...new Set(markers.map((m) => m.name))].map((n) => `${n} at ${markers.filter((m) => m.name === n).map((m) => m.t.toFixed(2)).join('/')} s`).join(', ')}` : '';
    ctx.fillText(`${req.name ?? clip.name} on ${req.rig.model} · ${duration.toFixed(2)} s · ${clip.loop ? 'loops' : 'plays once'}${markerText}`, 12, rows * fh + 23);
    return sheet.toDataURL('image/jpeg', 0.86);
  } finally {
    view.dispose();
    host.remove();
  }
}

/**
 * The hidden render page (`?render`): the main process asks it for pictures for agents that can't
 * look at a 3D viewer — a model beside a Roblox character, or an animation's filmstrip — drawn by the
 * same views the user sees on the Models and Animation pages.
 */
export function installRenderSheet(): void {
  const w = window as Window & { __render?: (req: RenderRequest) => Promise<string | null> };
  w.__render = async (req) =>
    req.kind === 'model' ? modelSheet(req) : req.kind === 'icon' ? iconPicture(req) : req.kind === 'animation' ? animationSheet(req) : req.kind === 'rig-animation' ? rigAnimationSheet(req) : null;
  // Forge plans drawn on the GPU for the core (window.__forge; lib/forge-gl).
  installForgePage();
}
