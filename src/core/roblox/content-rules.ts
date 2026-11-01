import { existsSync, readFileSync } from 'node:fs';
import { decodePng, type RgbaImage } from '../modeling/png';

/**
 * What Roblox's moderation removes from uploaded images (and counts against the account): anything that points
 * players off the platform. On 2026-10-01 a decorative QR code that Kiln's copilot painted on a vending machine's
 * pay panel was removed a minute after the upload ("Directing Users Off-Platform"). Roblox treats every QR code
 * as an off-site link, whatever it encodes.
 */
const BANNED =
  'QR codes or scannable-looking barcodes, web addresses or domain-like text ("www", ".com", ".jp"), social handles or "@names", the names or logos of other platforms (Discord, YouTube, Twitter/X, Twitch, Facebook, Guilded, TikTok, Instagram), phone numbers, email addresses, or real brand logos and trademarks';

/** For agents: everything they put in a game (textures, decals, UI images and text, signs). */
export const OFF_PLATFORM_RULE = `Nothing in the game may point players off Roblox or copy a real brand: no ${BANNED}, in any texture, decal, image, sign or UI text. Roblox removes such images and it counts against the user's account. Invented brand names, prices and ordinary signage are fine.`;

/*
 * Kiln's copilot is NOT told this rule by Shuriken. Up to 1.12.1 every message to it ended with a 600-character
 * paragraph of it, on each brief, fix and correction. Kiln carries the rule in its own prompt for every Roblox
 * project and scans what it paints (`content_problems`, below); the paragraph made briefs longer than the request
 * and made the copilot spend its turn proving it had drawn no logo on a sword. What Kiln's strict QR detector lets
 * through (a lookalike that doesn't decode) is caught here before an upload: findQrCode and the look at each image
 * (image-screen.ts).
 */

/**
 * What Kiln's own check flagged in a baked export (manifest `content_problems`, Kiln 0.8.3): a second, different
 * net (true QR geometry) beside Shuriken's own scan. One line per finding, for the agent.
 */
export function kilnContentProblems(manifest: Record<string, unknown> | null | undefined): string[] {
  const list = manifest?.content_problems;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const { material, map, problem } = raw as { material?: unknown; map?: unknown; problem?: unknown };
    if (typeof problem !== 'string' || !problem.trim()) continue;
    out.push(`Kiln flagged the ${typeof map === 'string' ? map : 'image'} map of ${typeof material === 'string' ? material : 'a material'}: ${problem.trim().replace(/[.\s]+$/, '')}. Roblox removes such images and it counts against the user's account: have it repainted (kiln_request kind "fix") before it is uploaded.`);
  }
  return out;
}

export interface QrFinding {
  /** Centre of the code in pixels, and roughly how wide it is. */
  x: number;
  y: number;
  size: number;
}

/** Summed-area table of a 0/1 map (one extra row and column of zeros). */
function integral(src: Uint8Array, w: number, h: number): Uint32Array {
  const out = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x]!;
      out[(y + 1) * (w + 1) + x + 1] = out[y * (w + 1) + x + 1]! + row;
    }
  }
  return out;
}

const WINDOWS = [32, 48, 64, 96, 128, 192, 256, 384, 512];

/**
 * A QR code (or anything that reads as one: a 2D matrix code) in the image, or null. Codes painted on game textures
 * are small and often stylized (wrong finder patterns, two pixels per module), so this looks for what makes any of
 * them read as a code: a square patch that is nearly all pure black and pure white, in roughly even shares, changing
 * every few pixels both across and down, and not repeating (a checkerboard, a grille or stripes repeat; a code doesn't).
 */
export function findQrCode(img: RgbaImage): QrFinding | null {
  const { width: w, height: h, data } = img;
  if (w < 32 || h < 32) return null;
  // 1 black, 2 white, 0 anything else (colour, grey, transparent).
  const cls = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (data[p + 3]! < 200) continue;
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx - mn > 40) continue;
    if (mx < 80) cls[i] = 1;
    else if (mn > 175) cls[i] = 2;
  }
  const black = new Uint8Array(w * h);
  const white = new Uint8Array(w * h);
  const across = new Uint8Array(w * h);
  const down = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = cls[i]!;
      if (c === 1) black[i] = 1;
      else if (c === 2) white[i] = 1;
      if (c && x + 1 < w && cls[i + 1] && cls[i + 1] !== c) across[i] = 1;
      if (c && y + 1 < h && cls[i + w] && cls[i + w] !== c) down[i] = 1;
    }
  const W = w + 1;
  const sum = (t: Uint32Array, x: number, y: number, s: number) => t[(y + s) * W + x + s]! - t[y * W + x + s]! - t[(y + s) * W + x]! + t[y * W + x]!;
  const iB = integral(black, w, h);
  const iW = integral(white, w, h);
  const iA = integral(across, w, h);
  const iD = integral(down, w, h);

  /** The share of black/white pixels that equal the one `d` pixels along; a repeating pattern reaches ~1 at its period. */
  const repeats = (x0: number, y0: number, s: number): boolean => {
    for (const vertical of [false, true]) {
      for (let d = 2; d <= s / 2; d++) {
        let same = 0;
        let n = 0;
        for (let y = y0; y < y0 + s - (vertical ? d : 0); y += 2)
          for (let x = x0; x < x0 + s - (vertical ? 0 : d); x += 2) {
            const a = cls[y * w + x]!;
            const b = cls[(vertical ? y + d : y) * w + (vertical ? x : x + d)]!;
            if (!a || !b) continue;
            n++;
            if (a === b) same++;
          }
        if (n > 40 && same / n > 0.86) return true;
      }
    }
    return false;
  };

  for (const s of WINDOWS) {
    if (s > w || s > h) break;
    const step = Math.max(4, s >> 3);
    const area = s * s;
    for (let y = 0; y + s <= h; y += step)
      for (let x = 0; x + s <= w; x += step) {
        const nb = sum(iB, x, y, s);
        const nw = sum(iW, x, y, s);
        if (nb + nw < area * 0.9) continue;
        const share = nb / (nb + nw);
        if (share < 0.28 || share > 0.68) continue;
        const ta = sum(iA, x, y, s) / area;
        const td = sum(iD, x, y, s) / area;
        // A module every 2 to 12 pixels, about as often across as down.
        if (ta < 0.04 || td < 0.04 || ta > 2.2 * td || td > 2.2 * ta) continue;
        // A code fills its square evenly; lettering (a glowing sign's mask) has gaps between strokes and lines.
        const q = s >> 1;
        let even = true;
        for (const [qx, qy] of [[x, y], [x + q, y], [x, y + q], [x + q, y + q]] as const) {
          const b4 = sum(iB, qx, qy, q);
          const w4 = sum(iW, qx, qy, q);
          const sh = b4 / Math.max(1, b4 + w4);
          const qa = q * q;
          if (b4 + w4 < qa * 0.88 || sh < 0.3 || sh > 0.7 || sum(iA, qx, qy, q) / qa < ta * 0.6 || sum(iD, qx, qy, q) / qa < td * 0.6) {
            even = false;
            break;
          }
        }
        if (!even) continue;
        if (repeats(x, y, s)) continue;
        return { x: x + (s >> 1), y: y + (s >> 1), size: s };
      }
  }
  return null;
}

/**
 * Why an image file must not go to Roblox, or null. Reads PNG files (what the exporter and Kiln write); a file that
 * can't be read is let through (the check must never block an upload by failing itself).
 */
export function uploadBlocker(file: string): string | null {
  if (!existsSync(file)) return null;
  let img: RgbaImage;
  try {
    img = decodePng(readFileSync(file));
  } catch {
    return null;
  }
  const qr = findQrCode(img);
  return qr ? `a QR code at about (${qr.x}, ${qr.y}), ${qr.size} px wide` : null;
}
