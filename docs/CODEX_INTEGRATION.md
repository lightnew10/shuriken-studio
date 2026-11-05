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

## One-click Windows updater and launcher

A Windows launcher is included at the repository root: **Lancer-Shuriken.bat**.
Double-click it from a clone of the fork (it will **not** work from a GitHub ZIP).

It performs these operations, in order:

1. Checks Git, npm and Node.js 24+.
2. Stops without changing files if the Git workspace contains uncommitted or untracked files.
3. Fetches your fork, checks out the feature/codex-integration branch, and merges the fork's latest version.
4. Adds the official repository as the upstream remote if needed, fetches the official main branch and merges it **locally** into your feature branch.
5. Runs npm ci only if packages are missing or package.json/package-lock.json changed during the update.
6. Installs Codex CLI if missing and starts the official ChatGPT sign-in only when needed.
7. Launches npm run dev (Electron's binary is prepared by the existing dev script).

Git updates are **not auto-pushed** to your fork. If an upstream merge conflicts,
the launcher aborts the in-progress merge and stops without using reset --hard or
discarding local work. Resolve conflicts manually before trying again.

The console stays open while the development app is running. For the first run,
ensure Git and Node.js 24+ are installed and the fork was cloned with Git.

## Run this branch

1. Check out branch **feature/codex-integration**.
2. Run **npm ci** and **npm run typecheck**.
3. Run **npm run dev**, or build the Windows installer with **npm run dist**.
4. Open **Settings → AI accounts**. The Codex login appears directly below your Claude accounts.
5. Click **Refresh**. Codex must be detected and signed in.
6. If necessary, click **Sign in with ChatGPT** and complete the official login.
7. Use **Make default AI** on the Codex account, or choose **Codex (ChatGPT)** in the agent-provider selector below. You can override individual agent roles as well.

Choices apply to **new runs**, not already-running agents.

### Choose a Codex model for Fast / Balanced / Deep

Go to **Settings → AI accounts → Codex models by task level** after signing in with ChatGPT. Shuriken reads the models advertised by the installed **Codex CLI app-server** (the `model/list` RPC), so names are not hard-coded and no API key is needed.

- **Fast**: model for small/quick tasks.
- **Balanced**: model for routine work.
- **Deep**: model for difficult specialist tasks.
- **Astra is excluded** from the displayed catalog and rejected as a saved model.
- The saved selections are global to Shuriken and persist between restarts.
- Changes affect new Codex runs, including fallback from a limited Claude account; active runs are not switched.
- **Codex CLI default (not pinned)** remains available as a legacy setting. It cannot be verified as non-Astra; select explicit models for all three tiers if you want a strict exclusion.
- The model catalog describes choices but **does not guarantee entitlement** on a given ChatGPT plan. The first real turn confirms availability; an unsupported model can produce an error.
- If the app-server catalog cannot be loaded, update the official Codex CLI with `npm install -g @openai/codex` and use **Refresh models**. No model is silently substituted with a guessed identifier.

**Important:** Shuriken already maps each agent role to a Fast, Balanced or Deep tier. This feature applies that existing tier to the Codex provider; it does not override individual role-tier settings.

### Optional automatic Claude → Codex quota fallback

Under **Settings → AI accounts → Automatic quota fallback**, enable **Use Codex when Claude reaches its quota**. This requires an installed Codex CLI authenticated with a ChatGPT subscription.

- When all Claude accounts registered with Shuriken are blocked by reported quota limits, **new** Claude-assigned agent runs use Codex.
- Existing Claude and Codex runs are never interrupted to change providers.
- The project's task, files, and stored context are preserved, but a Claude-internal chat session **cannot** be resumed inside Codex. A new Codex session reconstructs the task context from Shuriken.
- When Claude's recorded quota block expires, subsequent Claude-assigned runs return to Claude automatically. This is based on quota-reset signals and may not detect an unexpectedly early reset.
- If Codex fails its CLI/login health check or reaches its own limit, no fallback is attempted: Claude-assigned work waits for Claude. There is no bypass of either quota.
- Explicitly Codex-assigned roles stay on Codex.
- This setting is opt-in and does not automatically increase the number of concurrent agents.

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

- Codex → Claude fallback when Codex reaches its quota (only Claude → Codex is supported).
- Direct cross-provider session transfer.
- Multiple Codex account profiles.
- Exact Codex quota and reset-time display.
- Per-command Shuriken approval for Codex CLI shell/file commands.
- Automatically assigning different Codex models based on estimated task complexity (the configured role tier still controls selection).
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
