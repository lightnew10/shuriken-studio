import { describe, expect, it } from 'vitest';
import { isVideoFile, referenceFiles, referenceStatus, sizeLabel } from '../../src/renderer/src/lib/references';

// The References page (pages/references.tsx) and the chats' drops: which files become references, and how a
// reference's state reads.

const file = (name: string, type = '') => ({ name, type });

describe('dropped files', () => {
  it('takes videos and pictures by type or extension, and names the rest', () => {
    const files = [file('combat.mp4', 'video/mp4'), file('clip.mkv'), file('ui.png', 'image/png'), file('notes.txt', 'text/plain'), file('song.mp3', 'audio/mpeg')];
    const out = referenceFiles(files, (f) => `C:/in/${f.name}`);
    expect(out.paths).toEqual(['C:/in/combat.mp4', 'C:/in/clip.mkv', 'C:/in/ui.png']);
    expect(out.skipped).toEqual(['notes.txt', 'song.mp3']);
  });

  it('skips a file with no place on disk (dragged from a browser)', () => {
    expect(referenceFiles([file('web.png', 'image/png')], () => null)).toEqual({ paths: [], skipped: ['web.png'] });
  });

  it('knows a video when the docks get one', () => {
    expect(isVideoFile(file('a.webm'))).toBe(true);
    expect(isVideoFile(file('x', 'video/quicktime'))).toBe(true);
    expect(isVideoFile(file('a.png', 'image/png'))).toBe(false);
  });
});

describe('status words', () => {
  it('says what the analysis is doing, and when it needs the user', () => {
    expect(referenceStatus({ status: 'decoding', kind: 'video' })).toEqual({ label: 'Reading the video…', tone: 'busy' });
    expect(referenceStatus({ status: 'studying', kind: 'image' }).tone).toBe('busy');
    expect(referenceStatus({ status: 'measured', kind: 'video' })).toEqual({ label: 'Measured, no study yet', tone: 'measured' });
    expect(referenceStatus({ status: 'failed', kind: 'video' }).tone).toBe('failed');
    expect(referenceStatus({ status: 'ready', kind: 'video' }).label).toBe('Ready');
    expect(sizeLabel(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(sizeLabel(250 * 1024 ** 2)).toBe('250 MB');
    expect(sizeLabel(3.25 * 1024 ** 2)).toBe('3.3 MB');
    expect(sizeLabel(900)).toBe('1 KB');
  });
});
