# Codex (ChatGPT) integration — experimental V1

This fork adds an optional Codex CLI provider to Shuriken Studio. Claude Code stays the default.
The existing Roblox Studio MCP server and Shuriken workshops remain in place.

## Prerequisites

- Windows 11 and Node.js 24+ (same as Shuriken Studio).
- A working Claude setup if you want to continue using Claude.
- The official Codex CLI installed on the **same PC** as Shuriken:

~~~powershell
npm install -g @openai/codex
codex login
codex login status
~~~

**Subscription only:** the V1 rejects Codex CLI sessions logged in through an API key,
to avoid accidental pay-per-token billing. No OpenAI API key is created by Shuriken.

## Run this branch

1. Check out branch **feature/codex-integration**.
2. Run **npm ci** and **npm run typecheck**.
3. Run **npm run dev**, or build the Windows installer with **npm run dist**.
4. Open **Settings → AI accounts**. The Codex login appears directly below your Claude accounts.
5. Click **Refresh**. Codex must be detected and signed in.
6. If necessary, click **Sign in with ChatGPT** and complete the official login.
7. Select **Codex (ChatGPT)** as the default provider or override individual agent roles.

Choices apply to **new runs**, not already-running agents.

## Sandbox and permissions

**Experimental: test on a duplicate Roblox project first.**

- In project **Ask** mode, Codex runs with a **read-only** CLI filesystem sandbox.
- In **Autonomous** mode, Codex runs with the **workspace-write** sandbox.
- Shuriken MCP tools retain their server-side approval rules.
- Codex's shell and file commands do **not** currently use Shuriken's per-tool
  interactive approval dialog. Do not enable autonomous runs on production games.
- Shuriken registers its loopback MCP server with the Codex host process. It
  does **not** enable network access for model-generated sandboxed shell commands.
  The MCP handshake on Windows still requires a real-device integration test.
- Do not bypass the Codex sandbox.

## Included

- Optional Codex CLI provider with independent ChatGPT subscription login.
- Default provider choice and optional per-role overrides.
- Agent event streaming, MCP tool registration, file-change audit, and token counts.
- Best-effort resume of Codex sessions with Codex.
- Existing Claude support preserved.

## Not implemented / not guaranteed

- Automatic Claude → Codex or Codex → Claude quota failover.
- Direct cross-provider session transfer.
- Multiple Codex account profiles.
- Exact Codex quota and reset-time display.
- Per-command Shuriken approval for Codex CLI shell/file commands.
- Codex tier mapping: its CLI-configured default model is used.
- Kiln's separate Claude backend: it is unchanged.
- Proof of end-to-end operation with the user's Roblox Studio and Windows login.

## Recommended local test

1. Use a **duplicate** Impulse Simulator project.
2. Keep project permissions in **Ask** mode.
3. Assign Codex only to a review/research role.
4. Request an inspection of the UI and confirm MCP calls in Shuriken's timeline.
5. Verify no unauthorized project files were changed.
6. Try one small isolated edit in **Autonomous** mode on the duplicate project.
7. Check the generated diff, then retest Claude roles, Kiln and Roblox Studio.

Automated checks:

~~~powershell
npm run typecheck
npx vitest run tests/codex-provider.test.ts
~~~

Source locations: src/core/providers/codex/codex-provider.ts,
src/core/core.ts, src/core/orchestrator/agent-runner.ts,
src/core/rpc/router.ts, src/renderer/src/pages/settings.tsx.

Codex CLI is **not bundled** with the Shuriken installer; install it separately.
