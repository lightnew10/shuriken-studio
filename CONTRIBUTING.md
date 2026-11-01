# Contributing to Shuriken Studio

Thanks for helping. Bug reports, fixes, new skills, tools and workshops are all welcome. By contributing you
agree that your work is released under the project's [MIT license](LICENSE).

## Before you start

- Open an issue first for anything bigger than a small fix, so we can agree on the approach.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before structural changes, and update it in the same pull
  request when structure changes.
- Never commit personal data: no API keys, Open Cloud keys, cookies, tokens, account ids, Roblox user, group,
  universe or place ids of your own, local paths with your user name, or logs and screenshots from your
  sessions. Use placeholders in tests and fixtures (`C:\Users\me\...`, `12345`).

## Setup

Windows 11 and Node.js 24 or newer.

```powershell
npm ci
npm run dev          # the app with hot reload
```

`SHURIKEN_DATA_DIR=<folder>` keeps a development run's settings, accounts and logs apart from your installed app.

## Layout

- `src/core/`: the headless engine. It runs in an Electron utilityProcess in the app and under plain Node in
  the tests. **Never import `electron` here.** Composition root: `core.ts`; RPC surface: `rpc/router.ts`.
- `src/main/`: Electron main: the core supervisor (restart on crash), windows, the IPC bridge, secrets, the updater
  and smoke mode.
- `src/preload/`: the only bridge to the renderer (`window.shuriken`).
- `src/renderer/`: the React 19 + Tailwind 4 UI. Views read everything through RPC (`lib/rpc.ts`: `useRpc`
  refreshes on core events).
- `src/shared/`: domain types and event contracts used by core and renderer.
- `resources/`: bundled skills (`skills/<name>/SKILL.md`), seed knowledge (`knowledge/*.json`), the Blender
  bridge and plugin examples.
- `tests/`: Vitest unit and integration tests (a fake provider through the real MCP server); `tests/renderer/`:
  renderer logic in Node (typechecked with the web tsconfig, DOM stubbed); `tests/e2e/`: live runs against real
  Claude and real Studio.

## Rules that keep the architecture intact

1. **Provider independence.** Only `src/core/providers/<id>/` may know a provider's SDK, message formats, tool
   names or model names. Everything else uses `providers/types.ts`.
2. **Every tool call goes through `ToolRegistry.invoke`** (visibility, availability, zod validation, policy,
   audit, handler, reliability stats). Add agent tools in `capabilities/app-tools.ts` (or a sibling
   `*-tools.ts`), each with a capability id and a permission class.
3. **Agents report through MCP tools** and the structured output schemas in `agents/roles.ts`, never by prose
   parsing.
4. **Project state lives in Shuriken's stores** (`global.db`, `<project>/.shuriken/project.db` and its markdown
   mirrors). Never depend on provider session history: a session is a cache, never the record.
5. **Integrations degrade, they don't crash.** Adapters report health through `HealthService`, record their
   limitations in the capability registry and return errors as values.
6. **Don't pretend a capability exists.** If Studio or Claude cannot do something, record the limitation
   (`KNOWN_LIMITATIONS` in `roblox/studio-adapter.ts`, the capability registry) and escalate to the user.

## Conventions

- `node:sqlite` (built into Electron 44 / Node 24) behind a synchronous `Store` wrapper, with forward-only
  migrations in `db/schema.ts`: add a new numbered migration, never edit an applied one.
- IDs come from `newId(prefix)` (time-sortable); timestamps are ISO strings.
- Studio Luau reaches Studio through `RobloxStudioAdapter` only. Never open another port or write another file
  into Studio's Plugins folder. Tests and smoke runs must not create the Studio link (`SHURIKEN_NO_LINK=1`
  switches it off in a real run).
- Dock copilots work in their own field and draft first (`COPILOT_TOOLS` in `core/copilots/copilot-roles.ts`;
  `tests/copilot-domains.test.ts` fails when one reaches outside its workshop). A workshop tool a draft turn can
  call must honour `caller.drafts`.
- Every project window runs its own core on the shared data folder, and a project is locked to one core at a
  time (`<project>/.shuriken/open.lock`). Never open a project the running app has open from another core
  (tests, e2e).
- Bundled skills carry a `version` in their frontmatter: bump it when you change a skill, or installed apps keep
  the old copy.

## Checks before a pull request

```powershell
npm run typecheck    # both TypeScript projects (TypeScript 7, strict)
npm test             # unit + integration: no network, no Studio, no model calls
npm run build
```

Keep `npm test` green. A few tests compare against software installed on your PC and skip themselves when it
isn't there (Blender for `tests/blender.test.ts`, Roblox Studio's own scripts for `tests/ui-lab-devices.test.ts`);
if one of those fails, check whether your installed version changed before changing the code.

### Live end-to-end checks (optional)

`tests/e2e/` runs against real Claude and a real Roblox Studio. These cost Claude usage and need Studio running
with its MCP server on, so they are never part of `npm test`. Each file says what it needs at its top; they are
started with an `E2E` variable, for example:

```powershell
$env:E2E = "probe"; npx vitest run -c vitest.e2e.config.ts tests/e2e/live.e2e.ts
```

Only point them at throwaway places (`STUDIO_MATCH=<an open scratch place file>`), never at a real game. The
tests that write the Studio plugin refuse to run while the installed app runs.

### UI smoke run

`npx electron . --smoke --smoke-out <folder>` (after `npm run build`) screenshots every view and writes a
`report.json`; its per-view renderer errors and `uncaught` list must both be empty. Use `SHURIKEN_DATA_DIR` to
keep it isolated.

## Pull requests

- One topic per pull request, with a short description of what changed and why.
- Add or update tests with behaviour changes.
- Keep user-facing text in plain words: the app explains itself to people who are not programmers.
