import { existsSync, readFileSync } from 'node:fs';
import { REFERENCE_LIMITS, type ReferenceRecord } from '@shared/references';
import type { ProjectContext } from '../projects/project-service';
import type { ReferenceService } from './reference-service';
import type { ReferenceStore } from './reference-store';

/** What the References page asks the core (wired into rpc/router.ts). Pictures go as data: URLs. */

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };

function dataUrl(store: ReferenceStore, id: string, rel: string): string | null {
  try {
    const abs = store.file(id, rel);
    if (!existsSync(abs)) return null;
    const mime = MIME[abs.split('.').pop()?.toLowerCase() ?? ''];
    return mime ? `data:${mime};base64,${readFileSync(abs).toString('base64')}` : null;
  } catch {
    return null;
  }
}

/** The loudness envelope squeezed to at most `n` points (the loudest of each stretch), for the page's level graph. */
function squeeze(db: number[], n: number): number[] {
  if (db.length <= n) return db;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * db.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * db.length) / n));
    out.push(Math.max(...db.slice(a, b)));
  }
  return out;
}

export function referenceRpc(svc: () => ReferenceService, project: () => ProjectContext | null): Record<string, (params: any) => unknown> {
  const need = (): ReferenceService => {
    if (!project()) throw new Error('No project is open');
    return svc();
  };
  return {
    'references.list': () => (project() ? svc().list() : []),
    'references.info': () => ({ canDecode: svc().canDecode, limits: REFERENCE_LIMITS }),
    /** One reference with its study's text, its level graph and the loud hits with their frames. */
    'references.get': ({ id }: { id: string }) => {
      if (!project()) return null;
      const s = svc();
      const rec = s.get(String(id ?? ''));
      if (!rec) return null;
      const store = s.store();
      const audio = rec.kind === 'video' ? store.audio(rec.id) : null;
      return { ...rec, studyText: store.study(rec.id), levels: audio ? { step: (audio.envelope.step * audio.envelope.db.length) / Math.min(audio.envelope.db.length, 600), db: squeeze(audio.envelope.db, 600) } : null, events: audio?.events ?? [] };
    },
    'references.add': ({ paths, from }: { paths: string[]; from?: string }) => need().add(Array.isArray(paths) ? paths.map(String) : [], from === 'chat' ? 'chat' : 'page'),
    'references.analyze': ({ id }: { id: string }) => need().analyze(String(id ?? '')),
    'references.restudy': ({ id }: { id: string }) => need().restudy(String(id ?? '')),
    'references.remove': ({ id }: { id: string }) => need().remove(String(id ?? '')),
    /** A reference's pictures: its frames (stored and detail) and spectrograms, or the picture itself. */
    'references.pictures': ({ id }: { id: string }) => {
      const s = need();
      const rec: ReferenceRecord | null = s.get(String(id ?? ''));
      if (!rec) return null;
      const store = s.store();
      // The stored frames and at most 60 detail ones (each picture is tens of kilobytes over the bridge).
      const frames = [...(rec.video?.frames ?? []), ...(rec.video?.detail ?? []).slice(-60)].sort((a, b) => a.t - b.t).map((f) => ({ t: f.t, why: f.why, url: dataUrl(store, rec.id, `frames/${f.file}`) }));
      const spectrograms = (rec.spectrograms ?? []).map((st) => ({ t0: st.t0, t1: st.t1, url: dataUrl(store, rec.id, st.file) }));
      return { frames, spectrograms, image: rec.image ? dataUrl(store, rec.id, rec.image.preview) : null };
    },
    /** The self-test: a clip made by the media page itself goes through the whole pipeline (smoke runs). */
    'references.selftest': ({ seconds, wait, container }: { seconds?: number; wait?: boolean; container?: 'mp4' | 'webm' } = {}) => need().selftest({ seconds, wait, ...(container === 'mp4' || container === 'webm' ? { container } : {}) }),
  };
}
