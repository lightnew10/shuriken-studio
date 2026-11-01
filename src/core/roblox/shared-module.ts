import { DEFAULT_SYNC_MAP, type SyncMap } from './luau-toolchain';

/**
 * Where a module Shuriken generates for the game lives: with the game's shared code (the sync map's folder that goes
 * to ReplicatedStorage), so the server and the client both require it. `file` is the path in the project,
 * `requirePath` the Luau expression that reaches it.
 */
export function sharedModuleLocation(syncMap: SyncMap | undefined, name: string): { file: string; requirePath: string } {
  const map = syncMap && Object.keys(syncMap).length ? syncMap : DEFAULT_SYNC_MAP;
  const shared = Object.entries(map).find(([, inst]) => inst === 'ReplicatedStorage' || inst.startsWith('ReplicatedStorage/')) ?? ['src/Shared', 'ReplicatedStorage/Shared'];
  const segs = shared[1].split('/').slice(1);
  return {
    file: `${shared[0].replace(/\/$/, '')}/${name}.luau`,
    requirePath: ['game.ReplicatedStorage', ...segs.map((s) => (/^[A-Za-z_]\w*$/.test(s) ? s : `[${JSON.stringify(s)}]`)), name].join('.').replace(/\.\[/g, '['),
  };
}
