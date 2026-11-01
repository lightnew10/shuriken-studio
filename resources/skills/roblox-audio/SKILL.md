---
name: roblox-audio
description: "Music, ambience and sound effects for Roblox games made with Shuriken's audio workshop: composing with real samples (CC0 and public-domain one-shots, loops and textures found on the web, the user's own, TR-808 emulations: a real cowbell, vocal chops, keys, rain or vinyl) and crafting a song by editing its score instead of re-rolling seeds (audio_score, audio_music_edit: swap a part for a sample, rewrite a riff, layer a pad, thin the drums for a breakdown, risers and impacts, pump, tape, filter sweeps), listening to a song through its mix analysis (clashes, section lift, pump), designing sound effects like a sound designer with audio_sfx (the anatomy of a sound: transient, body, tail, place; recipes for gunshots, explosions, footsteps, metal, mechanisms, whooshes, risers, loops, UI; ambience beds with audio_ambience and stingers in the music's key with audio_stinger; which parameters give weight, punch, crack, air, space and movement; reading the tool's analysis and improving a sound in two or three passes), finding recordings (Creator Store and licensed Openverse tracks: audio_find, audio_add, audio_import, credits) for music, voices and nature, composing structured loops (style, key, tempo, bars, seeds) that fit each scene, loudness categories and takes, mixing with SoundGroups, 2D vs 3D sounds, music that follows the game's state, wiring through the ShurikenAudio module from server and client, and uploading so it isn't silent in the published game."
version: 5
tags: [audio, sound, samples, sampler, cowbell, 808, phonk, score, arrangement, sfx, sound design, music, soundtrack, ambience, mix, soundgroup, footsteps, gunshot, explosion, impact, hit, swing, servo, loop, ui sounds, lobby music, combat music, creator store]
roblox_systems: [Sound, SoundGroup, SoundService]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [audio_music, audio_music_edit, audio_score, audio_sample_find, audio_sample_add, audio_samples, audio_sfx, audio_ambience, audio_stinger, audio_find, audio_import, audio_add, audio_upload, audio_list, store_search]
---
# Sound for Roblox games

## Purpose
A game that sounds finished: every action a player takes answers with a sound, every place has its
mood, music follows what's happening, and nothing is too loud, repetitive or silent in the published
game.

## Pick the source first
| Wanted | Use | Why |
|---|---|---|
| **Every full track**: background music, themes, menu and battle loops, genre music (phonk, rock, orchestral, vocals), ambience beds; also voices and real instruments | **Find it: `audio_find`** (Creator Store, then Openverse), then `audio_add` / `audio_import` the best fit | A produced recording beats a synthesized track. The Roblox, APM, Pro Sound Effects and Monstercat libraries on the Creator Store are cleared for any game; Openverse results are limited to commercial-use licenses. Compose (`audio_music`) only after two searches without a fit, for music that must be layered or adaptive, or when the user asks for original music. |
| Sound effects: weapons, impacts, explosions, footsteps, machines and vehicles, mechanisms, whooshes, magic and sci-fi, UI | **Look first too** (`audio_find`: the licensed libraries hold clean, cleared effects); **design** (`audio_sfx`) what no library has and what must match as a set | A good cleared recording is quicker and usually better than a synthesized one. A family that must sound like one thing (a weapon set's shots, a creature's calls, the UI's clicks) is designed by one hand, or built around one found sound. See "Designing sound effects". |

Say which you chose, and why, in your result.

Search by material + action + size, not by mood: "wood door creak slow", "stone footstep gravel",
"sword steel clang heavy", "rain on tin roof loop", "drift phonk instrumental", not "epic sound". Put
every phrasing in one `audio_find` call (up to 3 queries; Openverse allows only a few anonymous
searches an hour). Check the length (effects under 3 s, loops 20-120 s with "loop" in the title),
prefer the licensed libraries, skip unknown creators, add the best two or three, and listen to them in
a playtest before wiring. After two searches without a good fit, synthesize. Never take a sound whose
license isn't clear: nothing ripped from a game, a film or a chart song.

## Imported tracks and credits
- `audio_add` (a Creator Store id) needs no credit. `audio_import` (an Openverse id from
  `audio_find`) downloads the file (https, at most 20 MB and 7 minutes; mp3, ogg, wav or flac), looks
  the license up again and keeps source, creator and license on the sound. It is used as it is: set
  `volume` to balance it against the generated sounds (commercial tracks are mastered hotter).
- Only CC0, public domain, CC BY and CC BY-SA are accepted: never import anything non-commercial or
  no-derivatives, or without a clear license (the `url` form of `audio_import` is for a track whose
  page you read, with its license, creator and source page).
- `audio/CREDITS.md` lists every imported sound with title, creator, license and URL, and the Audio
  page shows the license on the sound. CC BY and CC BY-SA need a credit in the game (a Credits screen
  or the game's description): tell the user, and give them the credit line from the result.
- CC BY-SA applies to adaptations of that sound: don't cut or remix it into something else.

## What the workshop gives you
- **audio_music** composes original loops, not one repeated pattern: `style` lofi | chiptune | epic |
  ambient | action | japanese | tropical | spooky | phonk, `key`, `bpm` (50-200), `bars` (4-64; 16-32 lets the A
  and B sections play out; phonk wants 20-32: intro, drop, breakdown, drop), `seed` (another song of the same brief), `kind` music | ambience,
  `volume`. Voice-led chords (7ths in lofi and ambient), a developed melody, a bass line, drums with
  fills every 4 and 8 bars, swing and human timing, a wide mix with a mono bass.
- **audio_sfx** designs effects from `params`: voices (oscillators, noise colours, struck materials,
  fm) with their own envelopes, filters and movement, layered in time, then shaped as a whole
  (`transient`, `weight`, `tone`, `clip`), put in a `space`, in mono or stereo, as a one-shot or a
  seamless `loop`. Its result carries an `analysis` (what it measures as, what to improve): see
  "Designing sound effects". `category`, `kind`, `variations` 1-4 (takes differ in grain and balance,
  not just pitch). Presets are there for quick stock sounds (UI: click, hover, blip, confirm, cancel,
  error; rewards: coin, pickup, powerup, checkpoint, levelup, victory, defeat, magic, heal, purchase;
  movement: jump, dash, swing, whoosh, splash; footsteps per surface; combat: hit, hurt, punch,
  block, clang, slam, explosion, laser) and can be overridden field by field.
- **audio_ambience** designs the bed of a place (a long seamless stereo loop with events scattered in
  it) and **audio_stinger** composes win / lose / start / reward phrases in the music's key: see
  "Ambience beds and stingers".
- **Loudness is set for you**: every sound is mastered to its category (music -16 LUFS, ambience -24,
  impact -12, pickup -16, ui -20, footstep -22, movement -18, stinger -14) with true peaks under
  -1.5 dBTP, so one class sits at one level whatever its Volume. The result's `check` line says how
  it measured; if it lists a fix (under its target, clipping, a click, a loop seam), act on it.
- **audio_find** searches the Creator Store and Openverse for something that already exists; **audio_add** (a
  Creator Store id) and **audio_import** (an Openverse id) bring it in; **audio_list** shows what the game has.
- **Samples** are sounds the composer plays as instruments: **audio_samples** lists them (the project's, earlier
  finds, the user's own "My samples" folder, built-in TR-808 emulations and textures), **audio_sample_find** and
  **audio_sample_add** bring in CC0 and public-domain ones from the web. A song's part plays one with
  `audio_music {samples}` or `audio_music_edit` (set `sample`). See "Composing with samples and editing the score".
- **audio_score** reads a composed song's score and **audio_music_edit** changes it and renders it again with the
  same seed; every song result carries an `analysis` of its mix.
- Every sound becomes a template in `ReplicatedStorage.ShurikenAudio`, in a SoundGroup
  (`ShurikenSFX` 1.0, `ShurikenMusic` 0.7, `ShurikenAmbience` 0.8 in SoundService), and plays through
  the **ShurikenAudio** module. Generated loops carry their loop region (it skips the MP3 encoder
  delay); check in a playtest that a loop does not gap.
- **Generated sounds are silent in the game until uploaded**: `audio_upload` (the user's Open Cloud
  key with the Assets permission). Upload finished sounds; if it can't, say so in plain words.

## Music by scene
| Scene | Style | Tempo | Notes |
|---|---|---|---|
| Menu, lobby, shop | lofi, tropical, japanese | 70-95 | warm, unobtrusive, 24-32 bars |
| Exploration, building | ambient, lofi | 85-110 | space for effects; ambience beds under it |
| Combat, chase, boss | action, epic, phonk | 125-160 | driving drums; a distinct boss theme; phonk for a drift or street feel |
| Horror, night | spooky, ambient | 60-90 | sparse; let silence work |
| Retro, obby, arcade | chiptune | 120-150 | bright, short loops (16 bars) |
One motif per game (same key across tracks: pick it once, e.g. A minor) makes it feel composed.
Try 2-3 seeds to pick a song, then craft that one: edit its score (below) instead of rolling seeds to fix a
part. A track that's fine at first and grating on loop 20 is not fine.

## Composing with samples and editing the score
Synthesis is good at drums, basses, pads and plucks, and weak where a sound is a real object or a real
voice. Put **samples** on those parts, and **craft the song by editing its score** rather than composing it again.

**Samples first for**: the cowbell (a real 808 cowbell is the sound of phonk; the synthesized one is its weakest
part), vocal chops, real keys (Rhodes, piano), choir and string pads, and textures (rain, vinyl crackle,
cassette hiss). Also the user's own one-shots: they drop WAV, AIFF, FLAC or MP3 files in their "My samples"
folder (or the project's assets/audio/samples) and they appear in `audio_samples` as `my-...` / `proj-...`.
1. `audio_samples` first: what is already there (`role`, `kind`, `root`, `bpm`, `energy`). Built-ins:
   `tr808-cowbell` (540/800 Hz squares), `tr808-clap`, `-hat`, `-openhat`, `-kick` (a long 49 Hz boom: pitched,
   an 808 bass), `-snare`, `-rim`; textures `vinyl-crackle`, `tape-hiss`.
2. `audio_sample_find {queries: ["808 cowbell", "phonk cowbell"], kind: "oneshot"}`: CC0 and public-domain
   sounds only. Judge by title, tags, length (a one-shot is under a second or two) and creator.
3. `audio_sample_add {id, name: "808 cowbell"}`: downloads, trims, normalises and measures it. Read the
   result: `kind` (oneshot, loop, texture), `root` (the note it plays at: melodies need one), `bpm`/`beats` for a
   loop, `energy` (a "cowbell" that is 90 % sub is a cowbell layered on an 808: pick another). Fix what the
   analysis got wrong with `audio_sample_add {sample, root: "C#5"}` (or kind, role, bpm).
4. Put it on a part: `audio_music {style, samples: {"cowbell": "808-cowbell"}}`, or on a song that exists
   `audio_music_edit {name, ops: [{op: "set", track: "cowbell", sample: "808-cowbell"}]}`. The sample is matched
   in loudness to the voice it replaces and keeps the part's mix (send, low-cut, pump). Read `sampleNotes`: a
   melody pitched far from the sample's root sounds thin or muddy (transpose the part by octaves), a loop
   stretched over 30 % smears.
- **Why only CC0 and public domain**: a sample becomes part of a new song that is uploaded to Roblox; a sound that
  asks for a credit (CC BY) or for share-alike (CC BY-SA) would follow every song made with it. Whole tracks with
  those licenses still come in with `audio_import`. The user's own samples are theirs to have the rights to.
- **How samples play**: a one-shot follows the notes against its root (`pitched`; drum hits ring at their own
  pitch), is cut at the note's end plus `release` (`gate`), `tune` moves it in semitones, `start` skips into it,
  `reverse` flips it. A loop (`kind: loop`) is stretched to the song's tempo without changing pitch and moved to
  the song's key when it has one (a key in the file name, "[C#Minor]"); a note plays it from beat `o` for as long
  as the note lasts. A texture loops seamlessly at its own speed. Sample-only parts: `vocal`, `texture`, `sample`.

**Editing the score.** Every composed song keeps its score and seed. `audio_score {name}` shows its sections with
their bars, the chords bar by bar, and every part (number, name, instrument or sample, bars it plays in,
settings); `tracks: ["cowbell"]` adds its notes bar by bar. `audio_music_edit {name, ops}` applies operations in
order and renders with the same seed, so what you don't touch sounds exactly the same. Bars count from 1.
| To | ops |
|---|---|
| a real cowbell | `{op: "set", track: "cowbell", sample: "<id>"}` |
| rewrite the riff | `{op: "notes", track: "cowbell", section: "Drop", every: 2, notes: [[0, 0.25, "F5", 1], [0.75, 0.25, "Ab5", 0.8], ...]}` (t in beats from the span's start; `every`: a 2-bar pattern repeated) |
| layer a pad | `{op: "add", instrument: "pad", name: "pad 2", pattern: "chords", section: "Drop 2", duck: 0.7, hp: 200}` (chords, stabs, arp, bass, drone from the song's chords; hits from a `rhythm`; `bed` for a texture or loop throughout; `chops` gates a loop to a rhythm) |
| thin the drums for a breakdown | `{op: "thin", track: "hat", keep: "beats", section: "Breakdown"}`, `{op: "clear", track: "kick", section: "Breakdown"}` |
| build into a drop | `{op: "riser", at: 15, bars: 2}`, `{op: "impact", at: 15}` |
| sweep a filter | `{op: "set", track: "pad", auto: {lp: [[48, 2400], [56, 500], [60, 2400]]}}` (beats, Hz); the whole mix: `{op: "song", auto: {lp: ...}}` |
| pump harder | `duck` 0.6-0.8 on pads and chords, `{op: "song", duckRelease: 0.15}` |
| a dirtier, longer 808 slide | `{op: "set", track: "808", drive: 0.6, slide: 0.7}` |
| tape, dust, age | `{op: "song", tape: {wow: 0.3, hiss: 0.2, crackle: 0.2, warmth: 0.3}}` |
| more or fewer bars | `insert {at, bars, copy}`, `delete {bars}`, `copy {from, to}`, `sections` |
Rename nothing you don't have to: parts are found by number, name or instrument.

**Listen, then fix.** Every `audio_music` and `audio_music_edit` result carries `analysis`: `heard` (each part's
share of the energy and of what is heard above 150 Hz, each section's loudness, the low end and the highs, the
pump), `sections`, and `improve`: parts fighting for the low end in the same bars (an 808 under a pad: high-pass
the pad, duck it, or move it up an octave), a drop that doesn't lift over what comes before it (thin the part
before, a riser and an impact), a part on top of everything or a buried tune, mud, dullness. Change what improve
names and edit again: two or three passes, as with a sound effect.

**Ambient drift phonk**, as a worked example: `audio_music {style: "phonk", bars: 24, samples: {"cowbell":
"<a real 808 cowbell>"}}`; then `audio_music_edit`: a texture bed (`add`, instrument "texture", sample
"vinyl-crackle" or a rain recording, pattern "bed", volume 0.5), a second pad or a choir sample in the drops
(`add` pattern "chords", duck 0.7), tape (`song` tape {wow 0.3, hiss 0.15, warmth 0.3}), a longer pump
(`duckRelease` 0.15), the breakdown thinned and swept (`thin`, `clear`, a pad `auto` lp), a riser into the second
drop. Read the analysis after each pass.

## Designing sound effects (audio_sfx)
You design a sound the way a sound designer does: decide what the thing IS (what is struck or moving,
how big, where), build it from layers placed in time and in frequency, then listen and correct. You
have no ears here, so the tool listens for you: every result carries `analysis`. Presets exist for
quick UI and pickup sounds; anything that gives the game its character (weapons, impacts, machines,
footsteps, creatures) is designed from `params`.

### Anatomy: every sound has four parts
| Part | When | What it is | How |
|---|---|---|---|
| Transient | 0-10 ms | the crack, click or tick: the loudest thing at the very start | `white`, `highpass` 2500-6000, `attack` 0.0003, `sustain` 0, `decay` 0.01-0.04, `volume` 1.5-2.5 |
| Body | 10-200 ms | the thump, the ring, the dense noise: this carries the loudness | a sine falling in pitch, a `modal` material, noise with a short `sustain` (0.02-0.06) |
| Tail | 0.2 s on | rumble, debris, hiss: darker and sparser as it dies | `brown` under `lowpass` 300, a `crackle` layer, long decays, `lowpassEnd` |
| Place | all of it | where it happens | `space` + `spaceMix`; `distance` for far away |

Put each layer in its own band so they add up instead of masking each other: weight under 150 Hz,
body 200-2000 Hz, crack and air above 3 kHz. One strong layer per band beats five overlapping ones.

Things that decide whether it works:
- **A voice is a hit unless you hold it.** `sustain` is seconds at full level (default 0) and `decay`
  is the time to silence: a sound is already 20 dB down after a third of its `decay`, so 0.3 sounds
  like a tenth of a second. Hold only the body noise, never the crack or the thump.
- **Noise is quieter than oscillators**: at the same `volume` noise is about 6 dB under a sine. A crack
  that must lead the sound wants `volume` 1.5-2.5.
- **Loudness comes from the body, not the peak.** A sharp front with nothing behind it ends under its
  loudness target; a flat burst reaches it and sounds like a blanket. Aim for a front 3-7 dB over the
  body (`heard: front +N dB over body`) and make the body dense (`clip`, `weight`, `drive`).
- **Real tails get darker.** Sweep long noise down (`lowpass` 8000 with `lowpassEnd` 500), never hold
  one cutoff for a second.
- **Nothing happens in a padded box.** Weapons and explosions outdoors: `space: 'outdoor'`
  (`spaceMix` 0.2-0.3). Interiors: `room`, `hangar`. Stingers: `hall`.

### Families
**Gunshot / cannon** (kind `shot`): crack + body + thump + mechanism + place.
```json
{"wave":"white","highpass":3000,"attack":0.0003,"decay":0.03,"volume":2.2,
 "layers":[
  {"wave":"pink","lowpass":9000,"lowpassEnd":900,"sweepTime":0.12,"sustain":0.05,"decay":0.3,"drive":0.5,"volume":1.8},
  {"wave":"sine","freq":160,"freqEnd":50,"pitchTime":0.05,"decay":0.22,"drive":0.5,"volume":1},
  {"wave":"brown","lowpass":180,"decay":0.25,"volume":0.8},
  {"wave":"modal","material":"bar","freq":900,"hardness":0.8,"decay":0.08,"volume":0.3}],
 "clip":0.7,"weight":0.5,"space":"outdoor","spaceMix":0.18,"spaceDecay":0.6}
```
Bigger gun: lower thump (`freq` 120 to `freqEnd` 38, `pitchTime` 0.09), longer body (`decay` 0.45), a
rumble (`brown`, `lowpass` 300 to `lowpassEnd` 80, `decay` 0.9), more space. Smaller: higher thump,
shorter everything, more crack. Rapid fire: keep it under 0.4 s dry and let the space overlap. A
pump or rack after the shot is two `modal` `bar` clacks with their own `delay`. Energy weapons: replace
the noise body with a `saw` or `fm` voice falling in pitch (`freqEnd`, `driveType: "fold"`).

**Explosion** (kind `explosion`): a crack, a blast that closes over half a second, a sub drop, a
rumble, fire, debris.
```json
{"wave":"white","highpass":2000,"attack":0.0003,"decay":0.05,"volume":2.2,
 "layers":[
  {"wave":"pink","lowpass":8000,"lowpassEnd":300,"sweepTime":0.5,"sustain":0.06,"decay":0.9,"drive":0.6,"volume":1.6},
  {"wave":"sine","freq":95,"freqEnd":28,"pitchTime":0.2,"decay":0.9,"drive":0.5,"volume":1.2},
  {"wave":"brown","lowpass":250,"lowpassEnd":60,"attack":0.01,"sustain":0.1,"decay":1.6,"volume":1},
  {"wave":"pink","bandpass":500,"bandpassEnd":200,"resonance":1,"attack":0.03,"sustain":0.1,"decay":0.8,"volume":0.6},
  {"wave":"white","highpass":2500,"crackle":70,"grain":0.004,"attack":0.02,"sustain":0.1,"decay":1,"volume":0.7,"delay":0.08}],
 "weight":0.5,"space":"outdoor","spaceMix":0.3}
```
Bigger: longer decays, a second boom (`delay` 0.15-0.2), metal debris (`modal` `plate` hits at
`delay` 0.6, 0.95, 1.3). The same blast far away: add `distance` 0.6-0.8 and `transient` 0.

**Footstep / landing** (kind `step`; category `footstep` whatever the size): a low impact, a knock of
the surface, debris after it.
```json
{"wave":"sine","freq":75,"freqEnd":30,"pitchTime":0.12,"decay":0.45,"drive":0.45,"volume":1.2,
 "layers":[
  {"wave":"brown","lowpass":300,"decay":0.4,"volume":0.9},
  {"wave":"modal","material":"plate","freq":190,"modeCount":16,"hardness":0.6,"damping":0.5,"decay":0.5,"volume":0.6},
  {"wave":"white","highpass":2500,"attack":0.0003,"decay":0.025,"volume":2.4},
  {"wave":"pink","lowpass":9000,"lowpassEnd":800,"sustain":0.02,"decay":0.18,"volume":1.2},
  {"wave":"white","highpass":2500,"crackle":110,"grain":0.004,"decay":0.4,"volume":1.2,"delay":0.04},
  {"wave":"pink","bandpass":4500,"resonance":1.2,"attack":0.04,"sustain":0.05,"decay":0.2,"volume":0.4,"delay":0.15}],
 "transient":0.7,"weight":0.6,"tone":{"presence":2,"air":3},"space":"outdoor","spaceMix":0.15}
```
That is a mech. A person: thump at 130 falling to 75 (`decay` 0.08), no plate, the surface decides the
rest (grass: `pink` under `lowpass` 1500 with a soft `attack` 0.004; gravel: `crackle` 220; wood: a
`modal` `wood` knock at 400 Hz; metal: `modal` `plate` at 900 Hz; snow: a slow `pink` crunch). Always
`variations` 2-4.

**Metal hit / clang** (kind `impact`): the object rings, and it also knocks.
```json
{"wave":"modal","material":"plate","freq":520,"modeCount":20,"hardness":0.8,"attack":0.0005,"decay":0.9,"volume":0.8,
 "layers":[
  {"wave":"modal","material":"bar","freq":1750,"hardness":0.9,"decay":0.5,"volume":0.25},
  {"wave":"white","highpass":3500,"attack":0.0003,"decay":0.012,"volume":2},
  {"wave":"pink","lowpass":2500,"lowpassEnd":500,"sustain":0.01,"decay":0.1,"volume":2.2},
  {"wave":"sine","freq":180,"freqEnd":90,"pitchTime":0.03,"decay":0.1,"volume":0.7}],
 "transient":0,"clip":0.8,"space":"outdoor","spaceMix":0.15}
```
`material` is what it is (`plate` armour and sheet, `bar` girders and blades, `bell`, `pipe` tubes and
barrels, `wood`, `glass`, `membrane` hollow thuds); `freq` is how big (lower = larger); `hardness`
what hit it (0.3 a boot, 0.9 a bullet); `damping` how dead (0.1 rings, 0.8 a thud); `decay` how long.
A hand-written `modes` list of two or three partials sounds like a toy bell: use a material.

**Flesh / body hit** (kind `impact`): a crack, a dull thump at 150-250 Hz falling an octave, a slap of
mid noise (`pink`, `bandpass` 700, `decay` 0.1), no ring. `clip` 0.7.

**Mechanism: reload, equip, latch** (kind `mechanism`): events in a row, each a small hit (a `modal`
`bar` tick + `white` click; a `modal` `plate` clunk + thump + knock), with something between them (a
slide: band-passed noise with `attack` 0.03 and `sustain` across the gap; a servo: a `saw` with
`tremoloDepth` 0.4 at `tremoloSpeed` 38) and a hiss to finish. Give every event its `delay`.

**Whoosh, swing, dash, thruster** (kind `whoosh`): a band of noise sweeping past: `pink`, `bandpass`
500 with `bandpassEnd` 3200, `resonance` 2, `attack` a third of the length, plus high air (`white`,
`highpass` 3500, same swell) and a low push (`brown`, `lowpass` 500). 2D: `pan` -0.5 with `panEnd` 0.5.

**Riser: charge-up, power-up, deploy** (kind `riser`): a `saw` with `unison` 5 and a `freqCurve`
climbing one or two octaves, `lowpass` 400 opening to `lowpassEnd` 6000 (`resonance` 2.5), noise whose
`highpass` climbs, `attack` half the length; end it with an impact (crack + thump + body at the same
`delay`) and put it in a `hall`.

**Loop: engine, servo, beam, rumble** (`loop: true`; category `movement`): the main voice sets the loop
length (`sustain` 2, `decay` 0); every held voice gets the same `sustain`. A machine is tone + load +
noise: a `saw` with `unison` 3 and `tremoloDepth` 0.25 at `tremoloSpeed` 40 (gear chatter), an `fm`
whine an octave or two up with `jitter` 6, band-passed `pink` for friction, a `sine` an octave or two
down for the motor. A beam: `unison` 5, `driveType: "fold"`, a `crackle` layer for sizzle, `width`
0.7. Short voices inside a loop are events (a tread link every 0.25 s: `modal` clanks with `delay`
0, 0.25, 0.5...). No `slide`, `freqEnd` or `lowpassEnd` on held voices (a loop cannot drift). The
game changes `PlaybackSpeed` with speed or load. Starts and stops are separate one-shots with a
`freqCurve` (up to speed in 0.2 s, down in 0.4 s).

**UI** (kind `ui`; category `ui`): a tick (`white`, `highpass` 3500, `decay` 0.006) over 20-60 ms of
tone (`sine` 1300 falling to 900, `sustain` 0.005, `decay` 0.07), `clip` 0.5; no space. Hover: half
as long, one layer. Confirm: two notes a fifth apart, 70 ms between. Keep one family of pitches for
the whole interface.

**Tonal: chimes, alarms, pickups** (kind `tonal`): `fm` (`fmRatio` 3.5, `fmIndex` 2, `fmDecay` 0.08)
or `modal` `bell`; notes as layers with `delay`; a `hall` or `room`. In the music's key.

### Ambience beds (audio_ambience) and stingers (audio_stinger)
**A bed** is the sound of a place: a long loop (20-40 s, stereo) under everything, made of what is
always there and of what happens now and then. `audio_ambience` takes the same voice language: the
main voice and every layer without a length of its own are held for the whole loop; a layer with
`scatter: N` plays N times at random moments (each a little different in pitch, level and place).
```json
{"wave":"pink","bandpass":500,"resonance":1.2,"filterLfoDepth":0.9,"filterLfoSpeed":0.11,"tremoloDepth":0.5,"tremoloSpeed":0.07,"volume":1.4,
 "layers":[
  {"wave":"white","highpass":3500,"lowpass":9000,"tremoloDepth":0.7,"tremoloSpeed":0.13,"filterLfoDepth":0.5,"filterLfoSpeed":0.05,"volume":0.35},
  {"wave":"brown","lowpass":160,"tremoloDepth":0.3,"tremoloSpeed":0.04,"volume":0.9},
  {"wave":"saw","freq":58,"unison":3,"detune":14,"lowpass":240,"tremoloDepth":0.25,"tremoloSpeed":0.21,"volume":0.25,"pan":-0.4},
  {"wave":"modal","material":"plate","freq":260,"modeCount":18,"hardness":0.4,"damping":0.4,"decay":1.4,"volume":0.35,"scatter":4,"scatterPitch":0.3},
  {"wave":"modal","material":"bar","freq":1300,"modeCount":10,"hardness":0.7,"decay":0.5,"volume":0.12,"scatter":5,"scatterPitch":0.4},
  {"wave":"pink","bandpass":900,"bandpassEnd":500,"resonance":6,"attack":0.3,"sustain":0.4,"decay":0.8,"volume":0.25,"scatter":2,"scatterPitch":0.25}],
 "width":0.8,"space":"outdoor","spaceMix":0.25}
```
That is a scrapyard: wind that breathes (a band of pink noise whose centre and level move at
different slow rates), high air, a low rumble, a far generator, and loose sheet metal, chain links
and a creak a few times in the loop. The rules of a bed:
- **It evolves**: each held voice gets its own slow `tremoloSpeed` and `filterLfoSpeed` (0.04-0.2 Hz:
  periods of 5-25 s) that do not line up, so no two passes of the loop sound the same moment.
- **It leaves room**: dark and low, little between 2 and 6 kHz (that band belongs to the game's
  effects and voices). Events are quiet (`volume` 0.1-0.4).
- **It surrounds**: `width` 0.6-0.9, a `space`, tonal voices panned off-centre.
- Interiors: a low-passed pink vent, a mains tone (`saw` 100 Hz under `lowpass` 400, a `sine` at 50), a
  hiss on one side, tools and clanks as events, `space: "hangar"`. Caves: `brown` rumble, a band-passed
  draught, drips (`sine` 1800 falling to 900, `decay` 0.12, `scatter` 6) in `space: "cave"`. Alien or
  reactor rooms: `fm` drones with `jitter`, a slow `filterLfo`, `ring`.
- Natural places (rain, forest, sea, city) are better recorded: `audio_find`.
The result's analysis names a bed that is static, short, mono, too bright or without events. Play it
with `Audio.play(name)` when the player enters the place, keep the Sound, fade and stop it on leaving.

**A stinger** marks a moment with a few seconds of music: `audio_stinger` with `mood` win | lose |
start | reward, and the `style` and `key` you gave `audio_music`, so it is in the music's own scale
and instruments (a win resolves on the bright tonic of that scale, a loss on the dark one). Play it 2D
at the moment; for a win or a loss fade the music under it.

### Parameters by what you hear
| You want | Use |
|---|---|
| Weight | a sine falling to 30-55 Hz, `brown` under `lowpass` 200, `weight` 0.4-0.7, `drive` on the thump, `tone.low` |
| Punch | `sustain` 0 on crack and thump, the crack loudest in the first 5 ms, `transient` 0.5-1 |
| Crack, bite | `white` above `highpass` 2500-6000 for 10-40 ms, `hardness`, `tone.presence` |
| Air | `white` above `highpass` 6000 with a longer decay, `tone.air`, noise that starts open (`lowpass` 9000+) |
| Density, loudness | a held noise body, `clip` 0.6-0.8, `drive`, `comp` |
| Size | lower `freq` everywhere, longer decays, a bigger `space`, more `weight` |
| Space | `space` + `spaceMix` (0.1 a hint, 0.25 clearly there, 0.5 far inside), `spaceDecay`, `distance` |
| Movement | `freqCurve`, `lowpassEnd` / `bandpassEnd`, `filterLfoDepth`, `tremoloDepth`, `jitter`, `unison`, `panEnd` |
| Metal, hollow | `modal` + `material`, `comb` (a tuned resonator on any voice: barrels, pipes, hulls), `ring` |
| Grit | `crackle` (grains per second) with `grain` (seconds each): sparks 80/0.004, gravel 220/0.0035 |
| Width (2D only) | `width` 0.5-0.8, `spread` on noise layers, `pan`; lows stay in the middle |

### Listen with the analysis, then fix
```
analysis.judgedAs  what it was judged as (pass kind and heavy to set it)
analysis.heard     805 ms; attack 0.2 ms; front +3.4 dB over body; crack -7.1 dB (first 10 ms above 4 kHz);
                   bands sub -5.9 / bass -7.6 / low-mid -6.9 / mid -6.3 / presence -9.9 / air -14.5 dB;
                   brightness 462 -> 186 Hz; noisiness 1; -20 dB at 311 ms, -40 dB at 596 ms; ...
analysis.improve   what a sound designer would change, most audible first, with the parameters
analysis.notes     parameters that did nothing or were read differently than you wrote them
analysis.takes     how each variation differs from the first
```
Reading `heard`: **front** is the first 10 ms against the 100 ms after (0 = a flat burst, 3-7 a hit,
10+ a tick with nothing behind it). **crack** is how much of the front is above 4 kHz (-6 bright, -20
dull). **bands** are the share of the energy per band in dB (0 = all of it; under -20 = not there):
sub under 60 Hz, bass to 150, low-mid to 500 (boxy when it leads), mid to 2 kHz, presence to 6 kHz
(harsh when it leads), air above. **brightness** start to end should fall for anything in a space.
**noisiness** 0 = pure tones, 1 = noise. **-40 dB at** is the length you hear.

The loop: make it (`upload: false`), read `improve`, change exactly those parameters, call again with
the same name. Two or three passes; stop when `improve` is empty or what is left is what you want
(say so). Typical corrections: "transient weak" → the crack is too quiet or something is held;
"N LU under its loudness target" → the body is too thin, not the front too loud; "no tail" → a
space; "dull" → open the noise and let it close; "boxy" → move the body down. Then upload the final.

Category is the class, not the size: a giant's footstep is still `footstep` and a cannon is `impact`;
make it bigger in the design and balance with `volume`. Use `variations` 2-4 for what repeats.

## Mix
- The categories already put effects, UI and music at sensible relative levels; per-sound `volume`
  0.3-0.7 trims the balance and nothing clips. Music sits under effects (the group is at 0.7);
  ambience lower still.
- 3D for the world (hits, explosions, doors: played at a position or on a part, with a sensible
  range), 2D for UI, music and the local player's own actions. World sounds are mono files (Roblox
  places them itself); `width` / `stereo` are for the 2D ones.
- Loops made with `loop: true` play with `Audio.play(name, part)` and keep playing: keep the returned
  Sound, set its `PlaybackSpeed` and `Volume` from the game (speed, load), `:Stop()` and destroy it
  when the thing stops.
- Don't stack: cap simultaneous identical sounds (e.g. many coins at once → play one).

## Wiring (ShurikenAudio)
```lua
local Audio = require(game.ReplicatedStorage.Shared.ShurikenAudio)
Audio.play("SwordSwing")                  -- 2D
Audio.play("SwordHit", hitPosition)       -- 3D at a Vector3/CFrame, or following a part/attachment
Audio.music("BattleTheme")                -- crossfade to a looping track; Audio.stopMusic()
```
- Play feedback where the action is decided: a client plays its own UI and movement sounds at once;
  the server plays 3D world sounds everyone should hear (a hit, an explosion) — Sounds created on the
  server replicate.
- Music follows state: the hub track on join, the combat track when a fight starts (a server event
  or an attribute the client watches), back to the hub afterwards, with a crossfade (1-2 s).
- Hit sounds belong on the animation's Hit marker (`Anims.onMarker(track, "Hit", …)`), together with
  the effect, at the contact point.

## Verify
In a playtest: listen for missing sounds on every action (roblox_playtest probes can check that
`Audio.play` ran and the Sound exists), check loops don't click or gap at the seam, and check levels
against each other. Report which sounds still need uploading.
