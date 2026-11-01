import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Keyboard, LocateFixed } from 'lucide-react';
import { rpc, useCoreEvent, useRpc } from '../../lib/rpc';
import { ShurikenMark } from '../../brand/logo';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SceneEngine, type CameraPose, type SceneLighting, type SceneModel, type ScenePart, type TerrainData, type TerrainInterval } from './engine';
import { parseRows, type PartsPage } from './scene-rows';
import { isStudioModeFlip, type ViewerModel } from '@shared/viewer';
import { acceptShot, failRetryDelay, keepPrevious, LoadGate, VIEWER_LOAD } from '../../lib/viewer-load';

interface TerrainPage {
  n: number;
  z0: number;
  z1: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  hits: number;
  cols: string;
  names: string[];
  colors: string[];
  waterColor: string;
}

const CODES = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The project's modeled meshes, loaded once per model (until a rebuild): the viewer's copy of its GLB (geometry
 * only, the core strips the embedded images) and a thumbnail of its colour map.
 */
const modelCache = new Map<string, Promise<SceneModel | null>>();

/** How many models are asked for at once. */
const MODEL_POOL = 6;

function colorMap(dataUrl: string): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false; // the mesh's UVs are glTF's: the image's top-left is the origin
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      t.needsUpdate = true;
      resolve(t);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function fetchModel(name: string): Promise<SceneModel> {
  const m = await rpc<ViewerModel>('viewer.model', { name });
  const bin = atob(m.glb.slice(m.glb.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const geos: THREE.BufferGeometry[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const g = (o.geometry as THREE.BufferGeometry).clone();
      g.applyMatrix4(o.matrixWorld);
      geos.push(g);
    }
  });
  if (!geos.length) throw new Error(`${name} has no mesh`);
  // Positions, normals and UVs are what is drawn; keep indexed geometry (half the vertices of a flat copy).
  const uv = geos.every((g) => g.getAttribute('uv'));
  for (const g of geos) for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(k === 'uv' && uv)) g.deleteAttribute(k);
  const indexed = geos.every((g) => g.index);
  const flat = indexed ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const geo = flat.length === 1 ? flat[0]! : mergeGeometries(flat);
  if (!geo) throw new Error(`${name}'s meshes could not be joined`);
  const texture = m.texture ? await colorMap(m.texture) : null;
  return { geo, size: m.size, legacy: m.legacy, texture, alpha: m.textureAlpha };
}

/** One model, once: a failed read is tried again a moment later, and not remembered. */
function loadModel(name: string): Promise<SceneModel | null> {
  let p = modelCache.get(name);
  if (!p) {
    p = fetchModel(name)
      .catch(() => new Promise<void>((r) => setTimeout(r, 700)).then(() => fetchModel(name)))
      .catch(() => {
        modelCache.delete(name);
        return null;
      });
    modelCache.set(name, p);
  }
  return p;
}

/** Gives the engine the real mesh of every modeled part in the scene, several at a time, widest first. */
async function loadModelMeshes(e: SceneEngine, alive: () => boolean): Promise<void> {
  const queue = e.modelsWanted();
  let next = 0;
  const worker = async () => {
    while (next < queue.length && alive()) {
      const name = queue[next++]!;
      const model = await loadModel(name);
      if (alive()) e.setModel(name, model);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MODEL_POOL, queue.length) }, worker));
}

/** Mean color, luminance and contrast of an image (64×36 thumbnail), for calibration against Studio. */
function imageStats(dataUrl: string, aspect?: number): Promise<{ r: number; g: number; b: number; l: number; sd: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 36;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        // Optionally compare only the centered part with the given aspect (same view, different window shape).
        let sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (aspect && aspect > 0) {
          if (img.width / img.height > aspect) {
            sw = img.height * aspect;
            sx = (img.width - sw) / 2;
          } else {
            sh = img.width / aspect;
            sy = (img.height - sh) / 2;
          }
        }
        g.drawImage(img, sx, sy, sw, sh, 0, 0, 64, 36);
        const d = g.getImageData(0, 0, 64, 36).data;
        let r = 0, gg = 0, b = 0, l = 0, l2 = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
          r += d[i]!;
          gg += d[i + 1]!;
          b += d[i + 2]!;
          l += lum;
          l2 += lum * lum;
        }
        const ml = l / n;
        resolve({ r: r / n, g: gg / n, b: b / n, l: ml, sd: Math.sqrt(Math.max(0, l2 / n - ml * ml)) });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export type ViewerStatus = { state: 'loading' | 'ready' | 'offline' | 'error'; parts: number; message?: string; /** Counts scene loads (the Explorer refreshes on it). */ loaded?: number };

/** What pages can do with the scene (the viewer's Explorer). */
export interface ViewerApi {
  parts(): ScenePart[];
  /** Outline parts (null clears) and optionally glide the camera to frame them. */
  select(parts: ScenePart[] | null, focus?: boolean): void;
}

/**
 * The live replica of the bound Studio place. Loads parts page by page, then terrain around them;
 * refreshes when agents change the world; optionally swaps in a pixel-exact Studio render whenever the
 * camera comes to rest ("Studio shots").
 */
/** Why the viewer is empty: Studio isn't connected yet, or (a project opened blank) there is no place yet. */
function OfflineNote() {
  const info = useRpc<{ settings: { robloxStudioMatch: string | null }; extras: { placeFile: string | null; blank?: boolean; adopted?: { from: string; place: string } } }>('project.settings', undefined, ['project.changed']);
  const [opening, setOpening] = useState(false);
  const adopted = info.data?.extras.adopted;
  // A game plugged in from Studio lives there (a Roblox place, or a file only Studio knows).
  if (adopted && !info.data?.extras.placeFile) return <>Open &ldquo;{adopted.place}&rdquo; in Roblox Studio (with its MCP server on) and the viewer fills in: Shuriken reconnects to it by itself.</>;
  const noPlace = info.data && !info.data.extras.placeFile && !info.data.settings.robloxStudioMatch;
  if (noPlace) return <>No Studio place yet. It&rsquo;s created and opened when the game starts: tell the director what you want to make.</>;
  return (
    <div className="flex flex-col items-center gap-3">
      <span>The place isn&rsquo;t open in Roblox Studio. The viewer fills in as soon as it is (it opens by itself when the team starts working).</span>
      {info.data?.extras.placeFile && (
        <button
          disabled={opening}
          onClick={() => {
            setOpening(true);
            window.shuriken.journal('studio.open.request');
            void rpc('project.openStudio').finally(() => setOpening(false));
          }}
          className="pointer-events-auto rounded-lg bg-accent/20 px-3 py-1.5 text-[12px] font-medium text-accent2 ring-1 ring-accent/30 transition-colors hover:bg-accent/30 disabled:opacity-60"
        >
          {opening ? 'Opening Studio…' : 'Open the place in Studio'}
        </button>
      )}
    </div>
  );
}

export function SceneView({
  compact = false,
  studioShots = true,
  onStatus,
  onPick,
  onApi,
  thumbnail = false,
}: {
  compact?: boolean;
  studioShots?: boolean;
  onStatus?: (s: ViewerStatus) => void;
  onPick?: (p: ScenePart | null) => void;
  onApi?: (api: ViewerApi | null) => void;
  /** Save a project thumbnail after loading (the dashboard viewer does this). */
  thumbnail?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<SceneEngine | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ state: 'loading', parts: 0 });
  const [shot, setShot] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const shotSeq = useRef(0);
  const framed = useRef(false);
  const hasScene = useRef(false);
  // 'Server' while a playtest runs (the map is read from the running game); null in Edit mode.
  const [live, setLive] = useState<'Edit' | 'Server' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const lastThumb = useRef(0);
  // A read that failed because Studio was switching between Edit and Play is tried again, quietly.
  const retries = useRef(0);
  const retryTimer = useRef(0);
  const loadRef = useRef<(withTerrain: boolean) => Promise<void>>(async () => undefined);
  // One read at a time, one more after it when Studio changed meanwhile (lib/viewer-load.ts).
  const gate = useRef<LoadGate | null>(null);
  const emptyReads = useRef(0);
  /** What the engine was last given (the rows as read): a read that finds the same place rebuilds nothing. */
  const drawnSig = useRef<{ e: SceneEngine; parts: string; terrain: string } | null>(null);
  const failures = useRef(0);
  const liveRef = useRef<'Edit' | 'Server' | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;
  const loads = useRef(0);
  const [speedNote, setSpeedNote] = useState<string | null>(null);
  const speedTimer = useRef(0);
  // The controls hint shows the first time the viewer is used in a session (and on the keyboard button).
  const [hint, setHint] = useState(false);
  const hintShown = useRef(false);
  const showHint = (ms = 6500) => {
    setHint(true);
    window.setTimeout(() => setHint(false), ms);
  };

  const report = useCallback((s: ViewerStatus) => {
    setStatus(s);
    onStatusRef.current?.(s);
  }, []);

  const load = useCallback(async (withTerrain: boolean) => {
    const e = engine.current;
    if (!e) return;
    const seq = ++loadSeq.current;
    try {
      const first = await rpc<PartsPage>('viewer.parts', { offset: 0 });
      const source = first.source ?? 'Edit';
      const pages = [first];
      let next = first.next ?? null;
      while (next != null && seq === loadSeq.current) {
        const page = await rpc<PartsPage>('viewer.parts', { offset: next, datamodel: source });
        pages.push(page);
        next = page.next ?? null;
      }
      if (seq !== loadSeq.current) return;
      // Agents change the place all the time, but most reads find it as it was: nothing is parsed or rebuilt then.
      const sig = pages.map((p) => `${p.classes.join(',')}#${p.materials.join(',')}#${(p.parents ?? []).join(',')}#${p.rows}`).join('\n');
      const same = drawnSig.current?.e === e && drawnSig.current.parts === sig;
      const parts = same ? null : pages.flatMap(parseRows);
      const count = parts ? parts.length : e.partCount();
      // No parts, right after a scene that had them: a playtest starting, or Studio reopening the place. The scene
      // stays (an empty one is a grey ground under a sky) and the place is read once more.
      if (keepPrevious(e.partCount(), count, emptyReads.current)) {
        emptyReads.current++;
        window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => gate.current?.request(withTerrain), VIEWER_LOAD.emptyRetryMs);
        return;
      }
      emptyReads.current = 0;
      failures.current = 0;
      e.setLighting(first.lighting ?? null);
      if (parts) {
        e.setParts(parts);
        drawnSig.current = { e, parts: sig, terrain: drawnSig.current?.e === e ? drawnSig.current.terrain : '' };
      }
      const alive = () => engine.current === e && seq === loadSeq.current;
      const modelsDone = loadModelMeshes(e, () => engine.current === e).catch(() => undefined);
      if (withTerrain) {
        // Terrain around the build (at least ±256 studs, see terrainExtent), sampled on a 128² grid, a few rows per call.
        const { minX, maxX, minZ, maxZ } = e.terrainBounds();
        const n = 128;
        const cells: Array<TerrainInterval[] | null> = new Array(n * n).fill(null);
        let names: string[] = [];
        let colors: string[] = [];
        let water = '0c5e7e';
        let hits = 0;
        const read: string[] = [`${minX},${minZ},${maxX},${maxZ}`];
        for (let z0 = 0; z0 < n && seq === loadSeq.current; ) {
          const page = await rpc<TerrainPage>('viewer.terrain', { minX, minZ, maxX, maxZ, n, z0, datamodel: source });
          read.push(`${page.z0}#${page.hits}#${page.names.join(',')}#${page.colors.join(',')}#${page.waterColor ?? ''}#${page.cols}`);
          if (page.hits) {
            // Material indexes are per call; remap them into one legend.
            const remap = page.names.map((nm, i) => {
              let j = names.indexOf(nm);
              if (j < 0) {
                names = [...names, nm];
                colors = [...colors, page.colors[i] ?? '808080'];
                j = names.length - 1;
              }
              return j + 1;
            });
            // Per cell: "top,bottom,code|top,bottom,code…" in half-studs, cells separated by ';'.
            const list = page.cols.split(';');
            for (let k = 0; k < list.length; k++) {
              if (!list[k]) continue;
              cells[page.z0 * n + k] = list[k]!.split('|').map((iv) => {
                const [top, bottom, code] = iv.split(',');
                return { top: Number(top) / 2, bottom: Number(bottom) / 2, mat: remap[CODES.indexOf(code ?? '')] ?? 0 };
              });
            }
            hits += page.hits;
          }
          water = page.waterColor ?? water;
          z0 = page.z1 + 1;
          if (!page.hits && z0 >= n / 4 && hits === 0) break; // no terrain near the build: stop early
        }
        const tsig = read.join('\n');
        if (seq === loadSeq.current && !(drawnSig.current?.e === e && drawnSig.current.terrain === tsig)) {
          const t: TerrainData | null = hits ? { n, minX, minZ, maxX, maxZ, cells, names, colors, waterColor: water } : null;
          e.setTerrain(t);
          if (drawnSig.current?.e === e) drawnSig.current.terrain = tsig;
          else drawnSig.current = { e, parts: '', terrain: tsig };
        }
      }
      // Center on the build the first time there is one; after that the camera is the user's.
      if (!framed.current && count > 0) {
        e.frameMap();
        framed.current = true;
      }
      hasScene.current = count > 0;
      retries.current = 0;
      liveRef.current = source === 'Server' ? 'Server' : null;
      setLive(liveRef.current);
      setNotice(null);
      report({ state: 'ready', parts: count, loaded: ++loads.current });
      if (thumbnail && Date.now() - lastThumb.current > 60_000 && count > 0) {
        lastThumb.current = Date.now();
        // The picture is taken once the meshes are in (a thumbnail of stand-ins says nothing).
        void modelsDone.then(() =>
          window.setTimeout(() => {
            const url = alive() ? engine.current?.snapshot(640) : null;
            if (url) void rpc('projects.saveThumbnail', { dataUrl: url }).catch(() => undefined);
          }, 1500),
        );
      }
    } catch (err) {
      if (seq !== loadSeq.current) return;
      const msg = (err as Error).message.replace(/^Error invoking remote method 'rpc': Error: /, '');
      // Studio switching between Edit and Play (the server datamodel comes and goes): keep the last good scene
      // (or the loading state) and read again in a moment, without an error. Only a long flip says so.
      if (isStudioModeFlip(msg) && retries.current < 8) {
        retries.current++;
        if (hasScene.current && retries.current > 3) setNotice('Studio is switching modes · showing the last view');
        window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => gate.current?.request(withTerrain), Math.min(5000, 900 * retries.current));
        return;
      }
      // A read that failed (Studio busy: a heavy place answers after two minutes, or not at all) is tried again by
      // itself a few times, further and further apart. It used to wait for the next change in Studio.
      const again = failRetryDelay(++failures.current);
      if (again !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => gate.current?.request(withTerrain), again);
      }
      if (hasScene.current) {
        // Keep what we have: the last view stays explorable while Studio is busy or away.
        setNotice(/not connected|No Studio|ECONNREFUSED|unavailable/i.test(msg) ? 'Studio is not connected · showing the last view' : 'Could not refresh from Studio · showing the last view');
        return;
      }
      report({ state: /not connected|No Studio|No open Studio|not open|not bound|ECONNREFUSED|unavailable/i.test(msg) ? 'offline' : 'error', parts: 0, message: msg });
    }
  }, [report, thumbnail]);
  loadRef.current = load;

  useEffect(() => {
    const e = new SceneEngine(host.current!, { quality: compact ? 'low' : 'high' });
    engine.current = e;
    // Inspection hook for automated checks (smoke calibration compares the replica with Studio's render).
    (window as unknown as { __shurikenViewer?: unknown }).__shurikenViewer = {
      parts: () => e.partCount(),
      pose: () => e.pose(),
      frameMap: () => e.frameMap(),
      frame: (pose: CameraPose) => e.frame(pose),
      aspect: () => e.renderer.domElement.width / Math.max(1, e.renderer.domElement.height),
      snapshot: (w?: number) => e.snapshot(w ?? 640),
      tune: (t: Record<string, number>) => e.tune(t),
      tuning: () => e.tuning,
      stats: (url: string, aspect?: number) => imageStats(url, aspect),
      // Checks without Studio: draw a given terrain sample.
      terrain: (t: TerrainData | null) => e.setTerrain(t),
    };
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => e.resize());
    });
    ro.observe(host.current!);
    e.onSelect = (p) => onPickRef.current?.(p);
    onApiRef.current?.({
      parts: () => e.allParts(),
      select: (parts, focus) => {
        e.selectParts(parts);
        if (focus) e.focusSelection();
      },
    });
    e.onSpeedChange = (m) => {
      setSpeedNote(`Camera speed ${m >= 1 ? m.toFixed(m < 10 ? 2 : 0) : m.toFixed(2)}×`);
      window.clearTimeout(speedTimer.current);
      speedTimer.current = window.setTimeout(() => setSpeedNote(null), 1400);
    };
    gate.current = new LoadGate((withTerrain) => loadRef.current(withTerrain));
    gate.current.request(true);
    return () => {
      gate.current = null;
      loadSeq.current++;
      window.clearTimeout(retryTimer.current);
      ro.disconnect();
      cancelAnimationFrame(raf);
      onApiRef.current?.(null);
      e.dispose();
      engine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Studio shots: when the camera rests, fetch Studio's own render from the same pose and fade it in.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.onMove = () => {
      shotSeq.current++;
      setShot(null);
    };
    e.onIdle = (pose: CameraPose) => {
      if (!studioShots || status.state !== 'ready' || live === 'Server' || document.hidden) return;
      const seq = ++shotSeq.current;
      setShooting(true);
      // Studio needs a moment to render after a big camera jump; a flat (washed-out) first capture gets one retry.
      // A picture is shown over the replica only when it can be one of this view (acceptShot): not a blank frame,
      // and not the grey viewport of a Studio that is switching modes or loading, which is much flatter than the
      // replica of the same view.
      const take = () => rpc<string | null>('viewer.shot', { camera: pose.pos, lookAt: pose.look });
      const good = async (img: string): Promise<boolean> => {
        const replica = engine.current === e ? e.snapshot(320) : null;
        return acceptShot(await imageStats(img), replica ? await imageStats(replica) : null);
      };
      void (async () => {
        let img = await take();
        if (img && seq === shotSeq.current && !(await good(img))) {
          await new Promise((r) => setTimeout(r, 600));
          img = seq === shotSeq.current ? await take() : null;
          if (img && !(await good(img))) img = null;
        }
        // A playtest that began while Studio drew it: the picture is of the game starting, not of this view.
        if (seq === shotSeq.current && img && liveRef.current !== 'Server') setShot(img);
      })()
        .catch(() => undefined)
        .finally(() => seq === shotSeq.current && setShooting(false));
    };
    if (!studioShots || live === 'Server') setShot(null);
  }, [studioShots, status.state, live]);

  // Agents change the world constantly: refresh (debounced) when Studio reports changes.
  const refreshTimer = useRef<number | null>(null);
  useCoreEvent(['roblox.changed'], (_c, p) => {
    const reason = (p as { reason?: string }).reason ?? '';
    if (reason.startsWith('connection:') && reason !== 'connection:connected') return;
    // A playtest starts or stops: Studio's picture of the Edit view comes down at once (one that is on its way is
    // dropped), not after the next read of the place.
    if (reason.startsWith('playtest:')) {
      shotSeq.current++;
      setShot(null);
      setShooting(false);
    }
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    const withTerrain = reason === 'luau' || reason === 'connection:connected' || reason === 'binding';
    refreshTimer.current = window.setTimeout(() => gate.current?.request(withTerrain), 2500);
  });
  // A rebuilt model has new geometry: load it again next time. Models that failed before (not built yet,
  // Studio or the core busy) are asked for again now.
  useCoreEvent(['assets.changed'], () => {
    modelCache.clear();
    const e = engine.current;
    if (!e) return;
    e.forgetFailedModels();
    void loadModelMeshes(e, () => engine.current === e);
  });

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#0d1016]"
      onPointerEnter={() => {
        if (hintShown.current || status.state !== 'ready') return;
        hintShown.current = true;
        let seen = false;
        try {
          seen = sessionStorage.getItem('shuriken.viewer.hint') === '1';
          sessionStorage.setItem('shuriken.viewer.hint', '1');
        } catch {
          /* per-session convenience only */
        }
        if (!seen) showHint();
      }}
    >
      <div ref={host} className="absolute inset-0" />
      <AnimatePresence>
        {shot && (
          <motion.div key={shot.slice(-24)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="pointer-events-none absolute inset-0">
            <img src={shot} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl" />
            <img src={shot} alt="Studio render" className="absolute inset-0 h-full w-full object-contain" />
          </motion.div>
        )}
      </AnimatePresence>
      {status.state !== 'ready' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0d1016]/70 text-center backdrop-blur-[2px]">
          {status.state === 'loading' ? (
            <>
              <ShurikenMark size={compact ? 28 : 40} active />
              <div className="text-[12.5px] text-dim">Loading the place…</div>
            </>
          ) : (
            <div className="max-w-sm px-6 text-[12.5px] leading-relaxed text-dim">
              {status.state === 'offline' ? <OfflineNote /> : `The viewer could not read the place: ${status.message}`}
            </div>
          )}
        </div>
      )}
      {shooting && !shot && status.state === 'ready' && (
        <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-[11px] text-white/80 backdrop-blur">
          <ShurikenMark size={12} active /> Studio view
        </div>
      )}
      {shot && (
        <div className="pointer-events-none absolute right-3 bottom-3 rounded-full bg-black/45 px-2.5 py-1 text-[11px] text-white/80 backdrop-blur">Studio render · move to explore</div>
      )}
      {status.state === 'ready' && (live === 'Server' || notice) && (
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white/85 ring-1 ring-white/10 backdrop-blur">
          {notice ?? 'Playtest running · showing the live game (Studio renders paused)'}
        </div>
      )}
      <AnimatePresence>
        {(hint || speedNote) && status.state === 'ready' && (
          <motion.div
            key={speedNote ? 'speed' : 'hint'}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="pointer-events-none absolute bottom-3 left-1/2 max-w-[92%] -translate-x-1/2 rounded-xl bg-black/60 px-3 py-1.5 text-center text-[11.5px] leading-relaxed text-white/85 ring-1 ring-white/10 backdrop-blur"
          >
            {speedNote ?? (
              <>
                <b className="font-semibold text-white">Right-drag</b> look · <b className="font-semibold text-white">WASD</b> fly · <b className="font-semibold text-white">Q/E</b> down/up · <b className="font-semibold text-white">Shift</b> precise · <b className="font-semibold text-white">Wheel</b> fly in/out · <b className="font-semibold text-white">Middle-drag</b> pan · <b className="font-semibold text-white">F</b> focus · <b className="font-semibold text-white">Right-drag + wheel</b> speed
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {status.state === 'ready' && status.parts > 0 && (
        <button
          onClick={() => showHint(9000)}
          title="Camera controls (same as Roblox Studio)"
          className="absolute top-3 left-12 flex h-8 w-8 items-center justify-center rounded-lg bg-black/45 text-white/80 ring-1 ring-white/10 backdrop-blur transition-colors hover:bg-black/65 hover:text-white"
        >
          <Keyboard size={15} />
        </button>
      )}
      {status.state === 'ready' && status.parts > 0 && (
        <button
          onClick={() => {
            shotSeq.current++;
            setShot(null);
            engine.current?.frameMap(true);
          }}
          title="Center on the map"
          className="absolute top-3 left-3 flex h-8 w-8 items-center justify-center rounded-lg bg-black/45 text-white/80 ring-1 ring-white/10 backdrop-blur transition-colors hover:bg-black/65 hover:text-white"
        >
          <LocateFixed size={15} />
        </button>
      )}
    </div>
  );
}
