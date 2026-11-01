import * as THREE from 'three';

/**
 * Roblox-like materials for the live replica. Each Roblox material maps to PBR parameters plus a
 * tileable grayscale detail texture (wood grain, bricks, cobbles, slate, fabric weave, diamond plate…)
 * that is multiplied by the part's own color and sampled in world space (triplanar), so textures keep
 * the same stud scale whatever the part's size — the way Studio's materials behave.
 */

export type Family =
  | 'plastic'
  | 'smooth'
  | 'wood'
  | 'planks'
  | 'brick'
  | 'cobble'
  | 'slate'
  | 'stone'
  | 'marble'
  | 'concrete'
  | 'grass'
  | 'sand'
  | 'metal'
  | 'plate'
  | 'rust'
  | 'fabric'
  | 'ice'
  | 'glass'
  | 'neon'
  | 'forcefield';

interface Spec {
  family: Family;
  roughness: number;
  metalness: number;
  /** Studs per texture repeat. */
  tile: number;
}

const SPECS: Record<string, Spec> = {
  Plastic: { family: 'plastic', roughness: 0.72, metalness: 0, tile: 8 },
  SmoothPlastic: { family: 'smooth', roughness: 0.55, metalness: 0, tile: 8 },
  Wood: { family: 'wood', roughness: 0.78, metalness: 0, tile: 6 },
  WoodPlanks: { family: 'planks', roughness: 0.8, metalness: 0, tile: 8 },
  Brick: { family: 'brick', roughness: 0.9, metalness: 0, tile: 8 },
  Cobblestone: { family: 'cobble', roughness: 0.92, metalness: 0, tile: 10 },
  Slate: { family: 'slate', roughness: 0.85, metalness: 0, tile: 12 },
  Rock: { family: 'stone', roughness: 0.9, metalness: 0, tile: 14 },
  Basalt: { family: 'stone', roughness: 0.88, metalness: 0, tile: 12 },
  Granite: { family: 'stone', roughness: 0.75, metalness: 0, tile: 10 },
  Limestone: { family: 'concrete', roughness: 0.85, metalness: 0, tile: 12 },
  Sandstone: { family: 'sand', roughness: 0.9, metalness: 0, tile: 12 },
  Marble: { family: 'marble', roughness: 0.55, metalness: 0, tile: 16 },
  Concrete: { family: 'concrete', roughness: 0.92, metalness: 0, tile: 12 },
  Pavement: { family: 'concrete', roughness: 0.9, metalness: 0, tile: 10 },
  Asphalt: { family: 'concrete', roughness: 0.95, metalness: 0, tile: 8 },
  CrackedLava: { family: 'stone', roughness: 0.8, metalness: 0, tile: 12 },
  Grass: { family: 'grass', roughness: 0.95, metalness: 0, tile: 10 },
  LeafyGrass: { family: 'grass', roughness: 0.95, metalness: 0, tile: 10 },
  Ground: { family: 'sand', roughness: 0.95, metalness: 0, tile: 12 },
  Mud: { family: 'sand', roughness: 0.7, metalness: 0, tile: 12 },
  Sand: { family: 'sand', roughness: 0.95, metalness: 0, tile: 10 },
  Salt: { family: 'sand', roughness: 0.85, metalness: 0, tile: 10 },
  Snow: { family: 'sand', roughness: 0.8, metalness: 0, tile: 12 },
  Ice: { family: 'ice', roughness: 0.15, metalness: 0, tile: 16 },
  Glacier: { family: 'ice', roughness: 0.25, metalness: 0, tile: 16 },
  Metal: { family: 'metal', roughness: 0.35, metalness: 0.85, tile: 8 },
  DiamondPlate: { family: 'plate', roughness: 0.35, metalness: 0.85, tile: 4 },
  CorrodedMetal: { family: 'rust', roughness: 0.7, metalness: 0.6, tile: 8 },
  Foil: { family: 'metal', roughness: 0.25, metalness: 1, tile: 6 },
  Fabric: { family: 'fabric', roughness: 0.95, metalness: 0, tile: 4 },
  Carpet: { family: 'fabric', roughness: 1, metalness: 0, tile: 4 },
  Leather: { family: 'fabric', roughness: 0.6, metalness: 0, tile: 6 },
  Plaster: { family: 'concrete', roughness: 0.9, metalness: 0, tile: 12 },
  CeramicTiles: { family: 'brick', roughness: 0.3, metalness: 0, tile: 6 },
  ClayRoofTiles: { family: 'brick', roughness: 0.8, metalness: 0, tile: 6 },
  RoofShingles: { family: 'planks', roughness: 0.9, metalness: 0, tile: 6 },
  Rubber: { family: 'smooth', roughness: 0.9, metalness: 0, tile: 8 },
  Cardboard: { family: 'fabric', roughness: 0.95, metalness: 0, tile: 8 },
  Pebble: { family: 'cobble', roughness: 0.9, metalness: 0, tile: 6 },
  Glass: { family: 'glass', roughness: 0.05, metalness: 0.1, tile: 8 },
  Neon: { family: 'neon', roughness: 0.4, metalness: 0, tile: 8 },
  ForceField: { family: 'forcefield', roughness: 0.2, metalness: 0, tile: 8 },
};

export function materialSpec(name: string): Spec {
  return SPECS[name] ?? SPECS.Plastic!;
}

// ─── Procedural detail maps ────────────────────────────────────────────────────

const SIZE = 256;

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise at a given cell count. */
function valueNoise(x: number, y: number, cells: number, seed: number): number {
  const fx = (x / SIZE) * cells;
  const fy = (y / SIZE) * cells;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const s = (a: number) => a * a * (3 - 2 * a);
  const w = (i: number) => ((i % cells) + cells) % cells;
  const a = hash(w(x0), w(y0), seed);
  const b = hash(w(x0 + 1), w(y0), seed);
  const c = hash(w(x0), w(y0 + 1), seed);
  const d = hash(w(x0 + 1), w(y0 + 1), seed);
  return a + (b - a) * s(tx) + (c - a) * s(ty) + (a - b - c + d) * s(tx) * s(ty);
}

function fbm(x: number, y: number, base: number, seed: number, octaves = 4): number {
  let v = 0;
  let amp = 0.5;
  let cells = base;
  for (let o = 0; o < octaves; o++) {
    v += amp * valueNoise(x, y, cells, seed + o * 17);
    cells *= 2;
    amp *= 0.5;
  }
  return v;
}

/** Tileable Worley (cell) noise: distance to nearest and second-nearest feature points. */
function worley(x: number, y: number, cells: number, seed: number): [number, number] {
  const fx = (x / SIZE) * cells;
  const fy = (y / SIZE) * cells;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  let d1 = 9;
  let d2 = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const gy = cy + j;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const px = gx + hash(wx, wy, seed);
      const py = gy + hash(wx, wy, seed + 7);
      const d = Math.hypot(px - fx, py - fy);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) d2 = d;
    }
  return [d1, d2];
}

function build(family: Family): (x: number, y: number) => number {
  switch (family) {
    case 'plastic':
      return (x, y) => 0.93 + 0.07 * fbm(x, y, 16, 3, 3);
    case 'smooth':
      return () => 1;
    case 'wood':
      return (x, y) => {
        const g = Math.sin((y / SIZE) * Math.PI * 2 * 7 + fbm(x, y, 4, 11, 3) * 5) * 0.5 + 0.5;
        return 0.72 + 0.2 * g + 0.08 * fbm(x, y, 32, 5, 2);
      };
    case 'planks':
      return (x, y) => {
        const rows = 4;
        const row = Math.floor((y / SIZE) * rows);
        const v = ((y / SIZE) * rows) % 1;
        const offset = hash(row, 0, 9) * SIZE;
        const u = (((x + offset) % SIZE) / SIZE) * 2;
        const gap = v < 0.04 || v > 0.96 || u % 1 < 0.015 ? 0.45 : 1;
        const grain = Math.sin(v * Math.PI * 2 * 3 + fbm(x, y, 8, row + 3, 3) * 4) * 0.5 + 0.5;
        return gap * (0.74 + 0.16 * grain + 0.1 * hash(row, Math.floor(u), 4));
      };
    case 'brick':
      return (x, y) => {
        const rows = 8;
        const row = Math.floor((y / SIZE) * rows);
        const v = ((y / SIZE) * rows) % 1;
        const u = ((x / SIZE) * 4 + (row % 2) * 0.5) % 1;
        const mortar = v < 0.08 || u < 0.04 ? 0.55 : 1;
        return mortar * (0.78 + 0.14 * hash(row, Math.floor((x / SIZE) * 4 + (row % 2) * 0.5), 12) + 0.08 * fbm(x, y, 24, 2, 2));
      };
    case 'cobble':
      return (x, y) => {
        const [d1, d2] = worley(x, y, 6, 21);
        const edge = Math.min(1, (d2 - d1) * 5);
        return (0.5 + 0.5 * edge) * (0.8 + 0.2 * fbm(x, y, 16, 8, 2));
      };
    case 'slate':
      return (x, y) => {
        const [d1, d2] = worley(x, y, 3, 31);
        const crack = d2 - d1 < 0.05 ? 0.62 : 1;
        return crack * (0.72 + 0.28 * fbm(x, y, 6, 14, 4));
      };
    case 'stone':
      return (x, y) => 0.62 + 0.38 * fbm(x, y, 5, 41, 5);
    case 'marble':
      return (x, y) => {
        const vein = Math.abs(Math.sin((x / SIZE) * Math.PI * 4 + fbm(x, y, 3, 51, 5) * 9));
        return 0.8 + 0.2 * Math.pow(vein, 0.35);
      };
    case 'concrete':
      return (x, y) => 0.82 + 0.18 * fbm(x, y, 12, 61, 4);
    case 'grass':
      return (x, y) => 0.72 + 0.28 * fbm(x, y, 20, 71, 4);
    case 'sand':
      return (x, y) => 0.85 + 0.15 * fbm(x, y, 40, 81, 3);
    case 'metal':
      return (x, y) => 0.9 + 0.1 * fbm(x, y, 2, 91, 3);
    case 'plate':
      return (x, y) => {
        const u = ((x / SIZE) * 8) % 1;
        const v = ((y / SIZE) * 8) % 1;
        const cell = (Math.floor((x / SIZE) * 8) + Math.floor((y / SIZE) * 8)) % 2;
        const ridge = cell ? Math.abs(u - v) < 0.08 : Math.abs(u + v - 1) < 0.08;
        return ridge ? 1 : 0.75;
      };
    case 'rust':
      return (x, y) => 0.5 + 0.5 * fbm(x, y, 8, 101, 5);
    case 'fabric':
      return (x, y) => {
        const u = Math.sin((x / SIZE) * Math.PI * 2 * 32) * 0.5 + 0.5;
        const v = Math.sin((y / SIZE) * Math.PI * 2 * 32) * 0.5 + 0.5;
        return 0.8 + 0.12 * (Math.floor(y / 4) % 2 ? u : v) + 0.08 * fbm(x, y, 16, 111, 2);
      };
    case 'ice':
      return (x, y) => 0.9 + 0.1 * fbm(x, y, 4, 121, 4);
    default:
      return () => 1;
  }
}

const cache = new Map<Family, THREE.Texture>();

/** The grayscale detail map of a material family (cached). */
export function detailTexture(family: Family): THREE.Texture {
  let t = cache.get(family);
  if (t) return t;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const f = build(family);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const v = Math.max(0, Math.min(255, Math.round(f(x, y) * 255)));
      const i = (y * SIZE + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  cache.set(family, t);
  return t;
}

/**
 * A MeshStandardMaterial whose detail map is sampled in world space (triplanar) at `tile` studs per
 * repeat — works for instanced, rotated and non-uniformly scaled parts.
 */
export function triplanarMaterial(params: THREE.MeshStandardMaterialParameters, tile: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTile = { value: tile };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTpPos;\nvarying vec3 vTpNormal;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 tpWorld = vec4(transformed, 1.0);
        vec3 tpN = objectNormal;
        #ifdef USE_INSTANCING
          tpWorld = instanceMatrix * tpWorld;
          tpN = mat3(instanceMatrix) * tpN;
        #endif
        tpWorld = modelMatrix * tpWorld;
        vTpPos = tpWorld.xyz;
        vTpNormal = normalize(mat3(modelMatrix) * tpN);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTpPos;\nvarying vec3 vTpNormal;\nuniform float uTile;')
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec3 tpW = pow(abs(normalize(vTpNormal)), vec3(4.0));
          tpW /= (tpW.x + tpW.y + tpW.z + 1e-5);
          vec4 tpX = texture2D(map, vTpPos.zy / uTile);
          vec4 tpY = texture2D(map, vTpPos.xz / uTile);
          vec4 tpZ = texture2D(map, vTpPos.xy / uTile);
          diffuseColor *= tpX * tpW.x + tpY * tpW.y + tpZ * tpW.z;
        #endif`,
      );
  };
  m.customProgramCacheKey = () => `tp-${tile}`;
  return m;
}
