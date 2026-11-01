import { describe, expect, it } from 'vitest';
import { canPlay, checkWords, groupSounds, moveSelection, navAction, soundLength, soundState, type KeyTarget, type SoundKind } from '../../src/renderer/src/lib/sound-list';
import { SoundPlayer, type AudioLike } from '../../src/renderer/src/lib/sound-player';

// The Audio page's list (pages/audio.tsx) and the dashboard's Audio container: grouping, where the arrow
// keys go, which keys the page takes, and the one player they share (lib/sound-player.ts).

const s = (name: string, kind: SoundKind) => ({ name, kind });
const SOUNDS = [s('Hit', 'sfx'), s('Theme', 'music'), s('Wind', 'ambience'), s('Step', 'sfx'), s('Boss', 'music'), s('Jump', 'sfx')];
const groups = groupSounds(SOUNDS);

describe('grouping', () => {
  it('lists music, then sound effects, then ambience, each in library order, leaving out empty groups', () => {
    expect(groups.map((g) => [g.kind, g.sounds.map((x) => x.name)])).toEqual([
      ['music', ['Theme', 'Boss']],
      ['sfx', ['Hit', 'Step', 'Jump']],
      ['ambience', ['Wind']],
    ]);
    expect(groupSounds([s('Hit', 'sfx')]).map((g) => g.kind)).toEqual(['sfx']);
    expect(groupSounds([])).toEqual([]);
  });

  it('plays files only: a Creator Store sound plays in Studio and the game, not here', () => {
    expect(canPlay({ source: 'generated', file: 'audio/sfx/Hit.mp3' })).toBe(true);
    expect(canPlay({ source: 'imported', file: 'assets/audio/imported/x.ogg' })).toBe(true);
    expect(canPlay({ source: 'store', file: undefined })).toBe(false);
    expect(canPlay({ source: 'generated' })).toBe(false);
  });
});

describe('arrow keys move the selection', () => {
  it('Up and Down go one sound at a time through every group, without wrapping', () => {
    expect(moveSelection(groups, 'Theme', 'down')).toBe('Boss');
    expect(moveSelection(groups, 'Boss', 'down')).toBe('Hit');
    expect(moveSelection(groups, 'Jump', 'down')).toBe('Wind');
    expect(moveSelection(groups, 'Wind', 'down')).toBe('Wind');
    expect(moveSelection(groups, 'Hit', 'up')).toBe('Boss');
    expect(moveSelection(groups, 'Theme', 'up')).toBe('Theme');
  });

  it('Left and Right jump to the first sound of the group before or after, and stay put at the ends', () => {
    expect(moveSelection(groups, 'Step', 'right')).toBe('Wind');
    expect(moveSelection(groups, 'Boss', 'right')).toBe('Hit');
    expect(moveSelection(groups, 'Step', 'left')).toBe('Theme');
    expect(moveSelection(groups, 'Wind', 'left')).toBe('Hit');
    expect(moveSelection(groups, 'Wind', 'right')).toBe('Wind');
    expect(moveSelection(groups, 'Boss', 'left')).toBe('Boss');
  });

  it('Home and End go to the first and last sound; Space keeps the selection', () => {
    expect(moveSelection(groups, 'Step', 'first')).toBe('Theme');
    expect(moveSelection(groups, 'Step', 'last')).toBe('Wind');
    expect(moveSelection(groups, 'Step', 'toggle')).toBe('Step');
  });

  it('with nothing selected (or a sound that was removed) a move lands on the first sound, End on the last', () => {
    expect(moveSelection(groups, null, 'down')).toBe('Theme');
    expect(moveSelection(groups, 'Gone', 'up')).toBe('Theme');
    expect(moveSelection(groups, 'Gone', 'right')).toBe('Theme');
    expect(moveSelection(groups, null, 'last')).toBe('Wind');
    expect(moveSelection(groups, null, 'toggle')).toBeNull();
    expect(moveSelection([], null, 'down')).toBeNull();
  });
});

describe('which keys the page takes', () => {
  const body: KeyTarget = { tag: 'BODY', editable: false, inSounds: false };
  const row: KeyTarget = { tag: 'DIV', editable: false, inSounds: true };
  const key = (k: string, more: Record<string, boolean> = {}) => ({ key: k, ...more });

  it('arrows, Home/End, Space and Enter with nothing focused or in the sounds', () => {
    expect(navAction(key('ArrowDown'), body)).toBe('down');
    expect(navAction(key('ArrowUp'), row)).toBe('up');
    expect(navAction(key('ArrowLeft'), row)).toBe('left');
    expect(navAction(key('ArrowRight'), row)).toBe('right');
    expect(navAction(key('Home'), row)).toBe('first');
    expect(navAction(key('End'), row)).toBe('last');
    expect(navAction(key(' '), row)).toBe('toggle');
    expect(navAction(key('Enter'), body)).toBe('toggle');
    expect(navAction(key('a'), row)).toBeNull();
    expect(navAction(key('Tab'), row)).toBeNull();
  });

  it('never while typing: the copilot box, a name field, a select, anything editable', () => {
    for (const tag of ['TEXTAREA', 'INPUT', 'SELECT']) {
      expect(navAction(key('ArrowDown'), { tag, editable: false, inSounds: false })).toBeNull();
      expect(navAction(key(' '), { tag, editable: false, inSounds: true })).toBeNull();
    }
    expect(navAction(key('ArrowUp'), { tag: 'DIV', editable: true, inSounds: true })).toBeNull();
  });

  it('not outside the sounds (the copilot panel, the top bar), with a modifier, or under a menu or dialog', () => {
    expect(navAction(key('ArrowDown'), { tag: 'BUTTON', editable: false, inSounds: false })).toBeNull();
    expect(navAction(key('ArrowDown'), { tag: 'DIV', editable: false, inSounds: false })).toBeNull();
    expect(navAction(key('ArrowDown', { ctrlKey: true }), row)).toBeNull();
    expect(navAction(key('ArrowDown', { altKey: true }), row)).toBeNull();
    expect(navAction(key('ArrowDown', { metaKey: true }), row)).toBeNull();
    expect(navAction(key('ArrowDown'), row, true)).toBeNull();
  });

  it('Space and Enter on a button press the button; arrows on it still move', () => {
    const button: KeyTarget = { tag: 'BUTTON', editable: false, inSounds: true };
    expect(navAction(key(' '), button)).toBeNull();
    expect(navAction(key('Enter'), button)).toBeNull();
    expect(navAction(key('ArrowDown'), button)).toBe('down');
  });

  it('a held Space does not start and stop the sound over and over; a held arrow keeps moving', () => {
    expect(navAction(key(' ', { repeat: true }), row)).toBeNull();
    expect(navAction(key('ArrowDown', { repeat: true }), row)).toBe('down');
  });
});

describe('words on the page', () => {
  it('a sound stands as draft, not uploaded, in game or unused', () => {
    expect(soundState({ assetId: null, draft: true }).label).toBe('draft');
    expect(soundState({ assetId: null }).label).toBe('not uploaded');
    expect(soundState({ assetId: '1', playedBy: ['src/server/Weapons.luau'] })).toMatchObject({ label: 'in game', title: 'Played by src/server/Weapons.luau' });
    expect(soundState({ assetId: '1', playedBy: [] }).label).toBe('unused');
  });

  it('lengths read as seconds or minutes', () => {
    expect(soundLength(0.42)).toBe('0.42 s');
    expect(soundLength(12.4)).toBe('12 s');
    expect(soundLength(92)).toBe('1:32');
    expect(soundLength(119.7)).toBe('2:00');
    expect(soundLength(undefined)).toBe('');
  });

  it("the mastering check in words: clean, or what it found", () => {
    expect(checkWords('ok: -12 LUFS-M (target -12), -1.6 dBTP, DC 0, starts at 0 ms')).toMatch(/^Measured clean/);
    expect(checkWords('check: -20 LUFS-M (target -12), -1.6 dBTP, DC 0, starts at 0 ms; ends abruptly (-20 dB in the last millisecond): it can click')).toBe('Measured: ends abruptly (-20 dB in the last millisecond): it can click.');
    expect(checkWords(undefined)).toBeNull();
  });
});

/** An audio element that plays at once (or fails), and remembers what was done to it. */
class FakeAudio implements AudioLike {
  loop = false;
  currentTime = 0;
  duration = 2;
  paused = true;
  onended: ((ev: Event) => unknown) | null = null;
  constructor(
    readonly url: string,
    private readonly fail = false,
  ) {}
  play(): Promise<void> {
    if (this.fail) return Promise.reject(new Error('no decoder'));
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

function player(opts: { slow?: string; failing?: string } = {}) {
  const made: FakeAudio[] = [];
  const loads: string[] = [];
  let release: (() => void) | null = null;
  const p = new SoundPlayer({
    load: (name, take) => {
      loads.push(`${name}#${take}`);
      const url = `data:${name}#${take}`;
      if (name === opts.slow) return new Promise((r) => (release = () => r(url)));
      return Promise.resolve(url);
    },
    create: (url) => {
      const a = new FakeAudio(url, url.startsWith(`data:${opts.failing}#`));
      made.push(a);
      return a;
    },
  });
  return { p, made, loads, release: () => release?.() };
}
const snd = (name: string, more: { looped?: boolean; playable?: boolean; version?: string } = {}) => ({ name, looped: false, playable: true, ...more });

describe('one sound at a time', () => {
  it('nothing plays until asked', () => {
    const { p, made } = player();
    expect(p.state).toEqual({ name: null, take: 0, status: 'idle', error: null });
    expect(made).toHaveLength(0);
  });

  it('a click plays a sound; clicking it again stops it', async () => {
    const { p, made } = player();
    await p.toggle(snd('Hit'));
    expect(p.state).toMatchObject({ name: 'Hit', status: 'playing' });
    expect(made[0]!.paused).toBe(false);
    await p.toggle(snd('Hit'));
    expect(p.state.status).toBe('idle');
    expect(made[0]!.paused).toBe(true);
  });

  it('a click on another sound replaces the one playing', async () => {
    const { p, made } = player();
    await p.toggle(snd('Hit'));
    await p.toggle(snd('Theme', { looped: true }));
    expect(made.map((a) => [a.url, a.paused, a.loop])).toEqual([
      ['data:Hit#0', true, false],
      ['data:Theme#0', false, true],
    ]);
    expect(p.state.name).toBe('Theme');
  });

  it('a sound still loading when another is clicked never starts', async () => {
    const t = player({ slow: 'Theme' });
    const first = t.p.toggle(snd('Theme'));
    expect(t.p.state).toMatchObject({ name: 'Theme', status: 'loading' });
    await t.p.toggle(snd('Hit'));
    t.release();
    await first;
    expect(t.made.map((a) => [a.url, a.paused])).toEqual([['data:Hit#0', false]]);
    expect(t.p.state.name).toBe('Hit');
  });

  it('clicking a sound that is loading stops it before it starts', async () => {
    const t = player({ slow: 'Theme' });
    const first = t.p.toggle(snd('Theme'));
    await t.p.toggle(snd('Theme'));
    t.release();
    await first;
    expect(t.made).toHaveLength(0);
    expect(t.p.state.status).toBe('idle');
  });

  it('a Creator Store sound (nothing to play here) silences the one playing', async () => {
    const { p, made } = player();
    await p.toggle(snd('Hit'));
    await p.toggle(snd('StoreBoom', { playable: false }));
    expect(made[0]!.paused).toBe(true);
    expect(p.state).toMatchObject({ name: null, status: 'idle' });
  });

  it('a row toggles any take; a take button plays that take', async () => {
    const { p, made } = player();
    await p.toggle(snd('Hit'), 2);
    expect(p.state).toMatchObject({ name: 'Hit', take: 2, status: 'playing' });
    await p.toggle(snd('Hit'), 1);
    expect(p.state).toMatchObject({ take: 1, status: 'playing' });
    expect(made[1]!.url).toBe('data:Hit#1');
    await p.toggle(snd('Hit'));
    expect(p.state.status).toBe('idle');
  });

  it('a sound that ends goes back to silence; a loop keeps going', async () => {
    const { p, made } = player();
    await p.play(snd('Hit'));
    made[0]!.onended?.(new Event('ended'));
    expect(p.state.status).toBe('idle');
    await p.play(snd('Theme', { looped: true }));
    made[1]!.onended?.(new Event('ended'));
    expect(p.state).toMatchObject({ name: 'Theme', status: 'playing' });
  });

  it('a sound that fails says why, on that sound', async () => {
    const { p } = player({ failing: 'Bad' });
    await p.play(snd('Bad'));
    expect(p.state).toEqual({ name: 'Bad', take: 0, status: 'idle', error: 'no decoder' });
    p.stop();
    expect(p.state.error).toBeNull();
  });

  it('replays come from memory until the sound is remade', async () => {
    const { p, loads } = player();
    await p.play(snd('Hit', { version: 'a' }));
    await p.play(snd('Hit', { version: 'a' }));
    expect(loads).toEqual(['Hit#0']);
    await p.play(snd('Hit', { version: 'b' }));
    expect(loads).toEqual(['Hit#0', 'Hit#0']);
  });

  it('starts from a point of the waveform, and seeks while playing', async () => {
    const { p, made } = player();
    await p.play(snd('Theme'), 0, 0.5);
    expect(made[0]!.currentTime).toBe(1);
    p.seek(0.25);
    expect(made[0]!.currentTime).toBe(0.5);
  });

  it('listeners hear every change', async () => {
    const { p } = player();
    const seen: string[] = [];
    const off = p.subscribe(() => seen.push(`${p.state.name}:${p.state.status}`));
    await p.toggle(snd('Hit'));
    p.stop();
    off();
    await p.toggle(snd('Hit'));
    expect(seen).toEqual(['Hit:loading', 'Hit:playing', 'null:idle']);
  });
});
