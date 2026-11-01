import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SoundLibrary, audioBuilder, AUDIO_RUNTIME_MODULE, type SoundEntry } from '@core/audio/audio-library';
import { OpenCloudAssets } from '@core/roblox/open-cloud-assets';
import { rootNote } from '@core/capabilities/audio-tools';
import { composeStyle } from '@core/audio/synth';

const entry = (over: Partial<SoundEntry>): Omit<SoundEntry, 'updatedAt'> => ({ name: 'Swing', kind: 'sfx', source: 'generated', assetId: null, volume: 0.6, looped: false, ...over });

describe('sound library', () => {
  it('builds sound templates with groups, variations and upload state', () => {
    const code = audioBuilder([
      { ...entry({ name: 'Swing', assetId: '111', variations: [{ file: 'a.mp3', assetId: '112' }, { file: 'b.mp3', assetId: null }], pitchVariation: 0.06 }), updatedAt: '' },
      { ...entry({ name: 'Theme', kind: 'music', looped: true }), updatedAt: '' },
    ]);
    expect(code).toContain('{name="Swing",kind="sfx",id="111",volume=0.6,looped=false,pitch=0.06,range=80,alts="112"}');
    expect(code).toContain('{name="Theme",kind="music",id=nil');
    expect(code).toContain('group("ShurikenMusic", 0.7)');
    expect(AUDIO_RUNTIME_MODULE).toContain("isn't uploaded yet");
  });

  it('keeps entries, the builder and the runtime module in the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-audio-'));
    const lib = new SoundLibrary(root);
    lib.save(entry({ name: 'Hit', assetId: '9' }));
    lib.save(entry({ name: 'Theme', kind: 'music', looped: true, source: 'store', assetId: '1843' }));
    expect(lib.names()).toEqual(['Hit', 'Theme']);
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).toContain('name="Theme"');
    expect(lib.ensureRuntime(undefined)).toMatchObject({ file: 'src/Shared/ShurikenAudio.luau', requirePath: 'game.ReplicatedStorage.Shared.ShurikenAudio', written: true });
    expect(lib.ensureRuntime(undefined).written).toBe(false);
    lib.remove('Hit');
    lib.remove('Theme');
    expect(existsSync(join(root, 'world/Audio.luau'))).toBe(false);
  });
});

describe('drafts and what the game plays', () => {
  it('keeps drafts out of the game and finds the sounds its code plays', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-audio-'));
    const lib = new SoundLibrary(root);
    lib.save(entry({ name: 'Jump', assetId: '100000000000005' }));
    lib.save(entry({ name: 'LobbyTheme', kind: 'music', looped: true, assetId: '100000000000006' }));
    lib.save(entry({ name: 'Whoosh', assetId: '100000000000007' }));
    lib.save(entry({ name: 'Boom', draft: true }));
    const builder = readFileSync(join(root, 'world/Audio.luau'), 'utf8');
    expect(builder).toContain('name="Jump"');
    expect(builder).not.toContain('name="Boom"');
    expect(lib.inGame().map((s) => s.name)).toEqual(['Jump', 'LobbyTheme', 'Whoosh']);
    // A draft never takes a game sound's name; a draft's own name is reused.
    expect(lib.freeName('Jump')).toBe('Jump2');
    expect(lib.freeName('Boom')).toBe('Boom');
    // Played: an audio call with its name, or its asset id. An animation called "Jump" is not the sound.
    mkdirSync(join(root, 'src/Client'), { recursive: true });
    mkdirSync(join(root, 'src/Server'), { recursive: true });
    writeFileSync(join(root, 'src/Client/LobbyMusic.client.luau'), 'local Audio = require(game.ReplicatedStorage.Shared.ShurikenAudio)\nAudio.music("LobbyTheme")\n');
    writeFileSync(join(root, 'src/Client/Movement.client.luau'), 'Anims.play(character, "Jump")\n');
    writeFileSync(join(root, 'src/Server/Wind.server.luau'), 'local s = Instance.new("Sound")\ns.SoundId = "rbxassetid://100000000000007"\n');
    const use = lib.usage(undefined);
    expect(use.get('LobbyTheme')).toEqual(['src/Client/LobbyMusic.client.luau']);
    expect(use.get('Whoosh')).toEqual(['src/Server/Wind.server.luau']);
    expect(use.has('Jump')).toBe(false);
    expect(use.has('Boom')).toBe(false);
  });

  it("finds sounds played through the game's own helpers, by a built name or in a mix table", () => {
    // How the mech arena plays 11 of its 23 sounds (they showed "unused" though the game plays them).
    const root = mkdtempSync(join(tmpdir(), 'shuriken-audio-'));
    const lib = new SoundLibrary(root);
    for (const name of ['Fire_Autocannon', 'Fire_Shotgun', 'Firework', 'Footstep_Light', 'Footstep_Heavy', 'TreadRumble', 'UI_Click', 'UI_Deploy', 'Hum', 'Stomp', 'Beep']) lib.save(entry({ name }));
    mkdirSync(join(root, 'src/Client/UI'), { recursive: true });
    const req = 'local Audio = require(Shared:WaitForChild("ShurikenAudio"))\n';
    writeFileSync(join(root, 'src/Client/CombatFx.client.luau'), `${req}local function sound(name, where) return Audio.play(name, where) end\nsound("Fire_" .. shortName(weaponId), where)\n`);
    writeFileSync(join(root, 'src/Client/Feedback.luau'), `${req}local soundName = "Footstep_" .. weightClass\nAudio.play(soundName, foot)\n`);
    writeFileSync(join(root, 'src/Client/Treads.luau'), 'local Feedback = require(script.Parent.Feedback)\nt.rumble = Feedback.loop("TreadRumble", t.pelvis)\n');
    writeFileSync(join(root, 'src/Client/UI/Garage.luau'), 'Style.sfx("UI_Click")\nif ok then Style.sfx("UI_Deploy") end\n');
    writeFileSync(join(root, 'src/Client/Mix.luau'), `${req}return {\n\tHum = { volume = 1, minDistance = 14 },\n}\n`);
    // Not sounds: an animation clip, a label.
    writeFileSync(join(root, 'src/Client/Anim.luau'), 'Anims.play("Stomp")\nlocal Stomp = 2\ndisplay("Beep")\n');
    const use = lib.usage(undefined);
    expect([...use.keys()].sort()).toEqual(['Fire_Autocannon', 'Fire_Shotgun', 'Footstep_Heavy', 'Footstep_Light', 'Hum', 'TreadRumble', 'UI_Click', 'UI_Deploy']);
    expect(use.get('TreadRumble')).toEqual(['src/Client/Treads.luau']);
    expect(use.get('Fire_Shotgun')).toEqual(['src/Client/CombatFx.client.luau']);
  });

  // The Audio page asks on every refresh; reading every script against every sound took 370-470 ms of the core's
  // one thread in a 44-sound game. What a file plays is remembered until the file or the sound list changes.
  it('remembers what each file plays, and looks again when the file or the sounds change', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-audio-'));
    const lib = new SoundLibrary(root);
    lib.save(entry({ name: 'Hit' }));
    lib.save(entry({ name: 'Miss' }));
    mkdirSync(join(root, 'src/Client'), { recursive: true });
    const file = join(root, 'src/Client/Combat.client.luau');
    const req = 'local Audio = require(game.ReplicatedStorage.Shared.ShurikenAudio)\n';
    writeFileSync(file, `${req}Audio.play("Hit")\n`);
    expect([...lib.usage(undefined).keys()]).toEqual(['Hit']);
    expect([...lib.usage(undefined).keys()]).toEqual(['Hit']);
    // The file changes (another size): read again.
    writeFileSync(file, `${req}Audio.play("Hit")\nAudio.play("Miss")\n`);
    expect([...lib.usage(undefined).keys()].sort()).toEqual(['Hit', 'Miss']);
    // A sound is added: files already read are read against the new list.
    lib.save(entry({ name: 'Block' }));
    writeFileSync(join(root, 'src/Client/Shield.client.luau'), `${req}Audio.play("Block")\n`);
    const use = new SoundLibrary(root).usage(undefined);
    expect([...use.keys()].sort()).toEqual(['Block', 'Hit', 'Miss']);
    expect(use.get('Block')).toEqual(['src/Client/Shield.client.luau']);
  });
});

describe('Open Cloud asset uploads', () => {
  const file = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-up-'));
    const f = join(dir, 'boom.mp3');
    writeFileSync(f, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    return f;
  })();

  it('explains a missing key without calling Roblox', async () => {
    let called = false;
    const up = new OpenCloudAssets(async () => null, (async () => {
      called = true;
      return new Response('');
    }) as typeof fetch);
    const r = await up.upload({ file, type: 'Audio', name: 'Boom', creator: { userId: '1' } });
    expect(r).toMatchObject({ ok: false, needsUser: true });
    expect(called).toBe(false);
  });

  it('uploads and waits for the asset id', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; headers?: unknown }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body, headers: init?.headers });
      if (url.endsWith('/assets')) return new Response(JSON.stringify({ path: 'operations/op-1', done: false }), { status: 200 });
      return new Response(JSON.stringify({ path: 'operations/op-1', done: true, response: { assetId: '424242' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const up = new OpenCloudAssets(async () => 'KEY', fake);
    const r = await up.upload({ file, type: 'Audio', name: 'Boom', creator: { userId: '1000000001' }, waitMs: 5000 });
    expect(r).toEqual({ ok: true, assetId: '424242' });
    expect(calls[0]).toMatchObject({ url: 'https://apis.roblox.com/assets/v1/assets', method: 'POST' });
    // The body is one multipart document (not a FormData: see multipartBody); read it back the way a server does.
    const form = await new Response(calls[0]!.body as Buffer, { headers: { 'content-type': (calls[0]!.headers as Record<string, string>)['content-type']! } }).formData();
    expect(JSON.parse(String(form.get('request')))).toMatchObject({ assetType: 'Audio', displayName: 'Boom', creationContext: { creator: { userId: '1000000001' } } });
    expect(form.get('fileContent')).toMatchObject({ name: 'boom.mp3', type: 'audio/mpeg', size: 4 });
    expect(calls[1]!.url).toBe('https://apis.roblox.com/assets/v1/operations/op-1');
  });

  it('turns a permission error into something the user can act on', async () => {
    const up = new OpenCloudAssets(async () => 'KEY', (async () => new Response('{"message":"Forbidden"}', { status: 403 })) as unknown as typeof fetch);
    const r = await up.upload({ file, type: 'Audio', name: 'Boom', creator: { userId: '1' } });
    expect(r.ok).toBe(false);
    expect(r.needsUser).toBe(true);
    expect(r.error).toMatch(/asset:read, asset:write/);
  });
});

describe('music keys', () => {
  it('takes the root note from how people write keys', () => {
    expect(rootNote('D minor', 'action')).toBe('D3');
    expect(rootNote('f# major', 'lofi')).toBe('F#3');
    expect(rootNote('Bb', 'epic')).toBe('Bb2');
    expect(rootNote('C4', 'ambient')).toBe('C4');
    expect(rootNote('minor', 'action')).toBeUndefined();
    expect(() => composeStyle('action', { key: rootNote('D minor', 'action'), bars: 4 })).not.toThrow();
  });
});
