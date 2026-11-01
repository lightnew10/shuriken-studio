import { referenceKindOf, type ReferenceRecord } from '@shared/references';

/** How the References page and the chats say where a reference stands. */
export type ReferenceTone = 'busy' | 'ready' | 'measured' | 'failed' | 'waiting';

export function referenceStatus(r: Pick<ReferenceRecord, 'status' | 'kind'>): { label: string; tone: ReferenceTone } {
  switch (r.status) {
    case 'queued':
      return { label: 'Waiting to be analyzed', tone: 'waiting' };
    case 'decoding':
      return { label: r.kind === 'video' ? 'Reading the video…' : 'Reading the picture…', tone: 'busy' };
    case 'measuring':
      return { label: 'Measuring frames and sound…', tone: 'busy' };
    case 'studying':
      return { label: 'Writing the study…', tone: 'busy' };
    case 'measured':
      return { label: 'Measured, no study yet', tone: 'measured' };
    case 'ready':
      return { label: 'Ready', tone: 'ready' };
    default:
      return { label: 'Failed', tone: 'failed' };
  }
}

export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The dropped or picked files that can be references (videos and pictures, by type or extension), as paths on
 * disk; the rest by name. A file with no path (dragged from a browser) can't be copied in.
 */
export function referenceFiles<F extends { name: string; type: string }>(files: F[], pathOf: (f: F) => string | null): { paths: string[]; skipped: string[] } {
  const paths: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const ok = /^(video|image)\//.test(f.type) || referenceKindOf(f.name) !== null;
    const path = ok ? pathOf(f) : null;
    if (path) paths.push(path);
    else skipped.push(f.name || 'a file');
  }
  return { paths, skipped };
}

/** Whether a dropped file is a video (the docks' chats keep attaching pictures, and add videos as references). */
export function isVideoFile(f: { name: string; type: string }): boolean {
  return f.type.startsWith('video/') || referenceKindOf(f.name) === 'video';
}
