import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuauIndexer } from '../src/core/code/luau-index';
import { DEFAULT_SYNC_MAP } from '../src/core/roblox/luau-toolchain';
import { planSync } from '../src/core/roblox/code-sync';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-code-'));
  const w = (rel: string, body: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body, 'utf8');
  };
  w(
    'src/Shared/Coins/init.luau',
    `--!strict
local Coins = {}
export type Wallet = { coins: number }
local MAX_COINS = 999
function Coins.award(wallet: Wallet, n: number) wallet.coins += n end
return Coins
`,
  );
  w('src/Shared/Coins/Format.luau', `--!strict\nreturn function(n: number) return tostring(n) end\n`);
  w(
    'src/Server/CoinService.server.luau',
    `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectionService = game:GetService("CollectionService")
local Coins = require(ReplicatedStorage.Shared.Coins)
local remote = Instance.new("RemoteEvent")
remote.Name = "CoinCollected"
remote.Parent = ReplicatedStorage
for _, c in CollectionService:GetTagged("Coin") do c:SetAttribute("Value", 1) end
remote.OnServerEvent:Connect(function(player) end)
local store = game:GetService("DataStoreService"):GetDataStore("PlayerCoins")
`,
  );
  w(
    'src/Client/Hud.client.luau',
    `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Format = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Coins"):WaitForChild("Format"))
local remote = ReplicatedStorage:WaitForChild("CoinCollected")
remote.OnClientEvent:Connect(function() end)
`,
  );
  return root;
}

describe('Luau code index', () => {
  it('plans sync entries with correct classes and instance paths', () => {
    const root = project();
    const entries = planSync(root, DEFAULT_SYNC_MAP);
    const byPath = Object.fromEntries(entries.map((e) => [e.instancePath, e.className]));
    expect(byPath['ReplicatedStorage/Shared/Coins']).toBe('ModuleScript');
    expect(byPath['ReplicatedStorage/Shared/Coins/Format']).toBe('ModuleScript');
    expect(byPath['ServerScriptService/Server/CoinService']).toBe('Script');
    expect(byPath['StarterPlayer/StarterPlayerScripts/Client/Hud']).toBe('LocalScript');
  });

  // 12 agents at once: an editor's temporary file ("Remotes.server.luau.tmp.26176.b324bf5f5922", renamed over the
  // real one a moment later) was listed by a sync and gone before it was read: "ENOENT ... stat" failed a vfx_create.
  it("leaves out the temporary files other agents' editors are still writing", () => {
    const root = project();
    writeFileSync(join(root, 'src/Server/Remotes.server.luau.tmp.26176.b324bf5f5922'), 'half written');
    writeFileSync(join(root, 'src/Server/Notes.tmp.1.abc'), 'x');
    const entries = planSync(root, DEFAULT_SYNC_MAP);
    expect(entries.some((e) => /tmp/.test(e.file))).toBe(false);
    expect(entries.map((e) => e.instancePath)).toContain('ServerScriptService/Server/CoinService');
  });

  it('indexes contexts, requires, symbols, remotes, data stores, tags and attributes', () => {
    const root = project();
    const ix = new LuauIndexer();
    const index = ix.build(root, DEFAULT_SYNC_MAP);
    const server = index.files.find((f) => f.file.endsWith('CoinService.server.luau'))!;
    const client = index.files.find((f) => f.file.endsWith('Hud.client.luau'))!;
    const shared = index.files.find((f) => f.file.endsWith('Coins/init.luau'))!;
    expect(server.context).toBe('server');
    expect(client.context).toBe('client');
    expect(shared.context).toBe('shared');
    expect(server.requires[0]!.target).toBe('src/Shared/Coins/init.luau');
    expect(client.requires[0]!.target).toBe('src/Shared/Coins/Format.luau');
    expect(shared.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(['Wallet', 'MAX_COINS', 'Coins.award']));
    expect(client.strict).toBe(false);
    const summary = ix.summary(index);
    expect(summary.remotes['CoinCollected']?.definedIn).toEqual([server.file]);
    expect(summary.dataStores).toEqual(['PlayerCoins']);
    expect(summary.tags).toEqual(['Coin']);
    expect(summary.attributes).toEqual(['Value']);
    expect(summary.nonStrict).toEqual([client.file]);
  });

  it('finds dependents transitively and references by name', () => {
    const root = project();
    const ix = new LuauIndexer();
    const index = ix.build(root, DEFAULT_SYNC_MAP);
    expect(ix.dependents(index, 'src/Shared/Coins/init.luau')).toEqual(['src/Server/CoinService.server.luau']);
    expect(ix.dependents(index, 'src/Shared/Coins/Format.luau')).toEqual(['src/Client/Hud.client.luau']);
    const refs = ix.references(root, index, 'Coins');
    expect(refs.length).toBeGreaterThan(2);
  });

  it('resolves requires through instance aliases', () => {
    const root = project();
    writeFileSync(
      join(root, 'src/Server/Shop.server.luau'),
      [
        'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
        'local Shared = ReplicatedStorage:WaitForChild("Shared")',
        'local CoinsFolder: Folder = Shared.Coins',
        'local Coins = require(Shared:WaitForChild("Coins"))',
        'local Format = require(CoinsFolder.Format)',
        'local Here = script.Parent',
        'local Service = require(Here.CoinService)',
      ].join('\n'),
    );
    const index = new LuauIndexer().build(root, DEFAULT_SYNC_MAP);
    const shop = index.files.find((f) => f.file.endsWith('Shop.server.luau'))!;
    expect(shop.requires.map((r) => r.target)).toEqual(['src/Shared/Coins/init.luau', 'src/Shared/Coins/Format.luau', 'src/Server/CoinService.server.luau']);
  });
});

describe('code index performance', () => {
  it('indexes a file with a very long line quickly (the alias pattern must not backtrack)', () => {
    const root = project();
    writeFileSync(join(root, 'src/Server/Pad.server.luau'), `local pad = "a${' '.repeat(20000)}b"\nreturn pad\n`);
    const t0 = Date.now();
    new LuauIndexer().build(root, DEFAULT_SYNC_MAP);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('script view highlighting', () => {
  it('tokenizes Luau like Studio colors it', async () => {
    const { luauLines, tokenizeLuau } = await import('../src/renderer/src/lib/luau-highlight');
    const src = [
      '--!strict',
      'local Players = game:GetService("Players")',
      '--[[ a long',
      'comment ]] local n = 0x1F + 1.5e3',
      'local s = [==[',
      'raw ]] still]==]',
      'if n ~= nil and s then print(`hi {n}`) end',
      'local t = a .. b',
    ].join('\r\n');
    const lines = luauLines(src);
    expect(lines).toHaveLength(8);
    const kinds = (i: number) => lines[i]!.filter((t) => t.s.trim()).map((t) => `${t.k}:${t.s.trim()}`);
    expect(kinds(0)).toEqual(['com:--!strict']);
    expect(kinds(1)).toEqual(['kw:local', 'txt:Players =', 'glob:game', 'txt::', 'call:GetService', 'txt:(', 'str:"Players"', 'txt:)']);
    expect(kinds(2)).toEqual(['com:--[[ a long']);
    expect(kinds(3)).toEqual(['com:comment ]]', 'kw:local', 'txt:n =', 'num:0x1F', 'txt:+', 'num:1.5e3']);
    expect(kinds(4)).toEqual(['kw:local', 'txt:s =', 'str:[==[']);
    expect(kinds(5)).toEqual(['str:raw ]] still]==]']);
    expect(kinds(6)).toEqual(['kw:if', 'txt:n ~=', 'lit:nil', 'kw:and', 'txt:s', 'kw:then', 'glob:print', 'txt:(', 'str:`hi {n}`', 'txt:)', 'kw:end']);
    // `..` is concatenation, not a member access.
    expect(kinds(7)).toEqual(['kw:local', 'txt:t = a .. b']);
    // Nothing is lost.
    expect(tokenizeLuau(src).map((t) => t.s).join('')).toBe(src);
  });
});
