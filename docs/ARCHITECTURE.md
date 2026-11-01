# Shuriken — Architecture

Shuriken is a Windows 11 desktop application that makes AI agents dramatically more capable at
building Roblox experiences. **The application owns orchestration and state; AI providers are
replaceable workers.** This document is the authoritative architecture. Every agent (human or AI)
working on this codebase reads it before making structural changes, and updates it when structure
changes.

## 1. Process model

```
┌──────────────────────── Electron main (src/main) ────────────────────────┐
│ windows · menus · single-instance lock · crash supervisor · IPC bridge    │
│ secure credential storage (safeStorage) · auto-update · logs              │
└───────────────┬───────────────────────────────────────┬──────────────────┘
                │ MessagePort (typed RPC + events)      │ contextBridge IPC
┌───────────────▼──────────────── core (src/core) ──┐  ┌─▼──────── renderer (src/renderer) ─┐
│ utilityProcess; plain Node, NO electron imports   │  │ React UI; talks to core through    │
│ db · projects · tasks · orchestrator · providers  │  │ main (window.shuriken.invoke/on)    │
│ context compiler · knowledge · research · skills  │  └────────────────────────────────────┘
│ capability registry · health · MCP host + server  │
│ roblox adapter · verification · git · audit       │
└──────┬───────────────────┬────────────────────────┘
       │ spawns            │ spawns (stdio MCP client)
┌──────▼───────────┐ ┌─────▼──────────────┐
│ claude.exe (via  │ │ StudioMCP.exe      │──► Roblox Studio
│ Agent SDK)       │ │ (Roblox built-in)  │
└──────┬───────────┘ └────────────────────┘
       │ Streamable HTTP MCP (127.0.0.1, bearer token)
       └──────────► Shuriken MCP server (inside core)
```

* **Core is headless.** `src/core` never imports `electron`. It runs in an Electron
  `utilityProcess` in the app and in plain Node under Vitest. If core crashes, main restarts it;
  the renderer shows a reconnect banner; SQLite (WAL) guarantees durable state.
* **Main is thin.** It supervises processes, hosts the window and bridges messages. It holds OS
  integration that needs Electron (safeStorage, dialogs, shell, updater).
* **Projects are connected windows.** An app window (`Frame` in `main/index.ts`) has a bar along the
  top — its own page, `components/tab-strip.tsx` loaded with `?strip` — with the Projects menu at the
  far left and then the project windows docked in it, each filling the bar's height with a light
  (needs your answer = open escalations / working / paused / idle). Every project window (a "tab" in
  the code) is a `WebContentsView` below the bar running the app (`?tab`) with its own core, so the
  ones behind keep building. Clicking the one in front opens its options; the bar's menus render in
  that page right under the bar (`components/strip-menus.tsx`, IPC `strip:menu`), because the bar's
  page is only 36 px tall. A project window moves between app windows without reloading
  (`moveTab` re-parents its view): drag it along the bar to reorder, off the bar to pull it into an
  app window of its own (`detachTab`), onto another app window's bar to dock it (`dropTab`; the bar
  sends the release point relative to itself, main adds that bar's screen origin), or use its menu.
  An app window left empty closes; closing one closes its project windows (asking first while agents
  work); the last one closing quits and records every app window with its project windows for the
  next launch (`windows.json`; 1.3's single list and the older one-window-per-project list come back
  docked in one). Main handles Ctrl+T / Ctrl+W / Ctrl+Tab / Ctrl+1…9 per app window
  (`before-input-event`).
* **Open blank.** The Projects menu's Open blank creates "Untitled game" with `extras.blank` and
  nothing started — no plan, no Studio place, no agents — in the project window when it is on the
  start page, otherwise in a new one whose core creates it while starting (`openProject: 'blank'`).
  The director reads every message, the first one too (small talk starts nothing); when the user
  describes a game, `new_goal` goes through `Director.beginBuild`, which calls `Core.prepareBuild`
  (the start page's setup: the project takes the game's name, its sandbox place is written and
  Studio opened) and starts the build with the director's full description plus the user's own words.
* A core announces a project it opened while starting (restored windows, "last", "blank") again right
  after `ready`, with its orchestrator state (`core/index.ts`): events sent during `init` have no
  listener yet, and main keys window titles, lights, the one-window-per-project rule and the saved
  windows on them.
* **Logs.** Every core appends JSON lines to `logs/core-<day>.jsonl` in the data folder, one file for all project
  windows, so each line carries the core's `pid` and the open project's name (`project`; `Logger.setProject` when a
  project opens, is renamed or closes). On 2026-10-07 two windows' health checks, one passing and one failing, sat
  side by side in that file with nothing to tell them apart.
* **Renderer is a view.** It never owns state; everything is read from core via RPC and live events.

## 2. Layering inside core

```
Orchestrator (executive loop, scheduler, autonomy engine)
  └─ uses TaskGraph, ContextCompiler, AgentRegistry (roles), Verification, Critic
       └─ AgentRunner → IAgentProvider (Claude adapter today; others later)
             └─ the agent calls tools through MCP → Shuriken MCP server
                   └─ CapabilityLayer (permission check → audit → adapter call → observation)
                         ├─ RobloxStudioAdapter (MCP client to StudioMCP.exe)
                         ├─ Filesystem / Git / Process / Luau toolchain (selene, luau-lsp)
                         ├─ Knowledge / Research / Skills / Tasks (project state)
                         └─ ExternalAdapters (future: Blender, CAD, image/audio tools)
Persistence: GlobalStore (%APPDATA%/Shuriken/global.db) + ProjectStore (<project>/.shuriken/project.db)
```

Rules:
1. **Provider independence.** Nothing outside `src/core/providers/<provider>/` may reference a
   provider's message formats, tool names, model names, auth or session semantics. The rest of core
   speaks the normalized `AgentEvent` / `AgentRunRequest` types in `src/core/providers/types.ts`.
2. **Agents report through MCP, not prose.** Results, evidence, research claims, knowledge proposals
   and critic verdicts are submitted via Shuriken MCP tools with schemas, so they land in project
   state regardless of provider. Free text is kept for audit only.
3. **Every tool call goes through the capability layer**: permission decision → audit record →
   adapter → observation. The same path serves MCP calls from agents and calls from the UI.
   What an agent sees is part of its run token: roles with a tool list (director, planner, researcher,
   critic) see exactly that; specialists see everything except other workshops' building tools
   (`WORKSHOP_TOOLS` / `hiddenToolsFor` in `agents/roles.ts`: animation, effects, audio, Blender
   modeling, research, planning), which keeps ~9k tokens of tool definitions off every turn (a level
   designer: 51 tools instead of 78) and the division of labour clear. Runs are bound by output speed
   and about two thirds of an agent's output is thinking: each role has an effort (the director low,
   the rest high), and Settings → Agents → "How deeply agents think: Faster" runs the high ones at
   medium (`AgentRunner.effortFor`).
4. **The project store is the source of truth.** Provider session history is disposable. An agent
   run can always be reconstructed from its context package + tool-call audit + reported results.
5. **Adapters are repair boundaries.** A broken integration degrades only its capabilities. Health
   checks set capability status; the orchestrator plans only with healthy capabilities.

## 3. Persistence

* `global.db` (per user): providers, capability registry, integration health, global/roblox/domain
  knowledge, skills index, projects index, settings, usage/rate-limit observations.
* `<project>/.shuriken/project.db`: tasks, dependencies, runs, tool calls (audit), events timeline,
  project/task/session knowledge, research sessions/sources/claims, decisions, tests & results,
  checkpoints, assets, spec sections, architecture model.
* Portable, inspectable artifacts live next to the DB and are the canonical copies for documents:
  `<project>/.shuriken/spec/*.md`, `decisions/*.md`, `skills/<name>/SKILL.md`,
  `context/<runId>.md` (every compiled context package), `snapshots/*.json` (DataModel snapshots),
  `evidence/*` (screenshots, logs). Global skills live in `%APPDATA%/Shuriken/skills/`.
* SQLite via Node's built-in `node:sqlite` (verified in Electron 44: SQLite 3.53, FTS5, JSON1),
  WAL mode, forward-only numbered migrations.

## 4. Knowledge model

Scopes: `global`, `roblox`, `domain`, `project`, `task`, `session`.
Categories (never mixed): `authoritative`, `research`, `experimental`, `project`, `agent`.
Each entry has sources (URL/file/tool-call ids), confidence 0–1, version applicability (e.g. Studio
version, SDK version), timestamps, relationships (supports / contradicts / supersedes / relates),
and a validation history. Promotion task → project → domain → roblox/global requires a recorded
validation (test evidence or authoritative source) and is always a new row that links to its origin.

## 5. Task graph & autonomy loop

A task: objective, reason, parent, dependencies, required knowledge/skills, role, tools, files,
Roblox systems, acceptance criteria, verification method, status, attempts, failures, evidence,
result. Status machine:

```
proposed → ready → running → implemented → verifying → reviewing → verified → done
                     ↓            ↓             ↓            ↓
                   failed ←───────┴─────────────┴────────────┘ (repair task spawned, attempt++)
                     ↓ (attempts exhausted / capability missing)
                  escalated / blocked
```

Crash recovery: on start, runs left `running` become `interrupted`; the task returns to `ready` if
no side effects were observed, or to `verifying` if files/DataModel changed (verify before redoing).

Dependencies (`tasks/task-graph.ts`, `dependencyMet`): a dependent starts when its dependency's work EXISTS
(`tasks.landed_at`, set at `implemented`: the agent finished, the result is on disk), while the dependency's checks
and review go on, and it stays startable while a sent-back dependency is reworked. A strict dependency
(`task_deps.strict`; the planner's `strictDependsOn`, for final test and QA tasks) needs `done`. A dependency that is
cancelled, escalated, blocked or out of attempts unlocks nothing (`landed_at` is cleared): what has not started is
blocked as before, what already runs carries on. When a sent-back dependency lands its rework, the dependents at work
get a note on their record ("Prerequisite reworked") and in their agent's next Shuriken tool result
(`CallerContext.notes`, `Orchestrator.noteRework`), and their reviewer is told. The finish estimate
(`director/eta.ts`) counts only the work share of a dependency (75% of a task, measured) before its dependents start.

Pause and stop are honoured after every await: a scheduler tick spans minutes (the objective wrap-up awaits
the regression suite), so `Orchestrator.tick()` recomputes "manual" after `finalizeObjectives`, and the
finalizer itself (`halted()`) creates nothing once paused, stopped, closed or switched. A stop aborts the suite
(`Verifier.regression(…, {signal})` stops between tests, `report.aborted`): the objective goes back to `ready`
with nothing recorded and the suite runs again on resume. A suite that finished across a pause records its
evidence but makes no repair task until the user resumes. A run set up with an already-aborted signal starts
aborted (`AgentRunner.run`), and `doWork` starts no agent for a stop that arrived during its checkpoint/snapshot.

Checks that match the code (`verification/probe-lint.ts`, `check-edits.ts`, `Verifier.rehearse`). The planner writes
Luau probes before the code exists, and half of one build's failed verifications were the probe's fault. Three
things answer that. (1) A probe runs on one side: `luau_assert` has `datamodel` edit/server/client (server and
client in a short playtest), a `playtest` has `luau` (server) and `clientLuau` (client). Where checks are
registered (`plan_add_task`, `test_register`, `task_update_verification`, `task_fix_probe`) `lintCheck` refuses a
probe that uses what only the other side has (`Players.LocalPlayer`, `workspace.CurrentCamera`, `UserInputService`,
`:FireServer(` on the server or in Edit; `ServerScriptService`, `ServerStorage`, DataStores, `:FireClient(` on the
client; comments and string contents don't count), and the message says how to register it. The batch plan path
(`Orchestrator.addTasks`) is not linted. (2) `task_run_checks`: the task's own worker runs its automated checks
now, through the same code path as verification (`runTaskChecks` with `record: false`: same sync, same probes,
same result text), with nothing recorded (no evidence, no tests registered, no results) and nobody asked;
screenshot, manual and Open Cloud checks are named, not run. Workers are told to run it before finishing
(`COMMON` in `roles.ts`). (3) `task_fix_probe {check, luau | client_luau | datamodel, reason}`: the worker of a
task corrects the probe of a check of ITS OWN task when the probe, not the game, is wrong. The check keeps its
name and kind; it can't be removed or emptied (`isEmptyProbe`), a reference to someone else's test can't be
touched, three corrections per check at most, and acceptance criteria are not reachable through it. The reason
and both probes are recorded as evidence (`PROBE_AMENDED`) and on the timeline, and the critic's directive shows
the old and the new probe (`amendmentNotes`) with the rule that a weakened probe is a defect.

What a playtest check costs beyond its own play time (`Verifier.playtest`, `watchSession`; `tests/regression-speed.test.ts`).
A check with a probe keeps a play session of its own: its probe may change anything, so nothing can be shown about
the check after it. What was cut is everything else. A regression run and a rehearsal take no picture during play
(nobody looks at it, and a Studio that isn't drawing made each capture cost 63 s: 45 s, a pause, 15 s more); a
recorded task check takes one `quick` capture (one try of 10 s). `setPlaying` polls every 250 ms, not 750. And the
checks of a suite that only watch the game — a playtest without a probe ("play N s, no errors") and a perf budget,
whose probe reads the Stats service and counts instances — share ONE session when there are several: it plays as
long as the longest asks, each perf budget is measured at its own mark, the errors are read once at the end. That
is sound because none of them does anything to the game, and only for what it proves: a clean output over the
longest window is clean over every shorter one, so each watching playtest passes with the text its own run gives;
with any error in the output (or no typed history, or a failed measurement) the session decides nothing for that
check and it runs alone, as before. Against a Studio stand-in with the timings of the logged build (start 3.5 s,
stop 2.5 s, 27 checks of the suite's shape, 784 s of play asked for): 1060 s → 824 s with Studio drawing and
1541 s → 823 s with the display off; per check beyond its play time 10.2 s / 28.0 s → 1.5 s on average, 8.8 s
for a check with a probe (Studio's own start and stop). Not measured in a real Studio.

Regression tests and the wrap-up (`orchestrator/regression-policy.ts`, `regression-wrapup.ts`, `verification/test-service.ts`).
Every automated check a task verifies becomes a registered test (`tests` table, named
`<task id tail>:<kind>:<check>`); the regression suite re-runs the enabled ones. A test can be **retired**: disabled
with a record (`retired_reason/at/by`, migration 8) of why, by whom and when. Retirement happens (a) when the task
that registered it is cancelled or replaced (`TaskGraph.setStatus` → `cancelled`; the reason carries the
planner's "replaced by"; coming back from `cancelled` restores what the cancellation retired; the suite also
sweeps tests of cancelled tasks in older projects), (b) by an agent: `test_retire {test, reason}` (id, registered
name, or the check's own name — every copy) and `task_update_verification {task, remove, add, reason}`, with
`test_list` to find them; visible to the planner and `qa-engineer` only (`WORKSHOP_TOOLS.verification`), the reason
goes on the timeline and on the caller's task, (c) at the user's answer to a question: "Retire road_not_green"
retires it, "Drop it from this task's verification" drops the check from that task
(`applyTestAnswer` in `onEscalationResolved`; a repair task that only had that check is cancelled), (d)
quarantine. A check that references a registered test by id (`VerificationMethod.testId`, used by repair tasks)
runs that test's *current* spec and is skipped once it is retired (a note on the task says so) — no frozen copy.
The wrap-up of an objective: a failing suite gets **one** repair task ("Fix regressions", role `qa-engineer`, which
can settle a contradiction between checks itself) whose checks are references to the failing tests; a test that
still fails after a repair task is quarantined (retired with a timeline/chat note) instead of getting another
task; at most one repair task is open per objective, at most three in all, then the user is asked once ("The
regression suite keeps failing"), and after that answer the remaining failures are quarantined. A quick
iteration's wrap-up runs only its own tasks' registered checks (no static analysis, no global suite); a main
objective's full suite waits while another objective's (or a stand-alone) task is running or about to start, or a
plan change is under way, in the same place.

Getting it right the first time (1.14). A study of the builds on record found that most tasks that redid
finished work did so for the same few misses: work that didn't read from the camera players use (a drone feed, the spawn view), blown-out lighting and
colour casts, a world that ends in view, UI that overlapped on phones or crossed a TV's edge, models that showed
grey in the game, collision and ground that didn't match what players see, effects in the wrong place or size,
type errors left behind, fixes on disk that weren't in Studio. The answers are in the agents' instructions, not in
more review: COMMON's "Get it right the first time" (look from the player's views on the real map, check it in
the game that runs, own files clean, delete previews), the planner's contract (the player's views, screen zones,
who plays which sound and effect, collision by role, the map's edge and the lighting's exposure in the first
pass's criteria), a "First pass, right" list per role (level, environment, gameplay, UI, sound, effects, models)
and the critic judging visuals from the contract's views. A static_analysis check of a task that changed no Luau
file answers for none (the project's errors are the regression suite's): a modeler's task failed three times in
one build on an error in a finished client script it never touched.

Follow-ups and defects (`orchestrator/proposal-triage.ts`). Agents file what they find outside their task as
`followUps` (worker and critic results); each becomes a `proposed` task. A real defect (the text starts
"DEFECT:", which the output schemas and COMMON ask for, or reads like one) is recorded as a defect proposal
(`reason` "Defect reported by …", priority 55), optional polish ("POLISH:" or anything else) as a plain one.
Defects are triaged **continuously**: `Orchestrator.triageDefects` (every tick, never while paused or manual) makes
one "Triage defects (n)" planner task per objective — goal or quick iteration — once three are waiting or the oldest
has waited ten minutes, and never while another triage of that objective is waiting or running. The run is short
(`maxTurns` 10, medium effort, brief "add tasks for the real defects, cancel every listed proposal, at most
three turns"): real defects become tasks for the right role, the rest are dropped, and whatever listed proposals the
planner leaves are cancelled so none is parked or triaged twice. Optional polish is triaged in **rolling batches while
agents have spare capacity** (`Orchestrator.triagePolish`: no ready task is waiting and one more could run; "Triage
polish (n)" once ten are waiting or the oldest has waited thirty minutes; goals only). **No proposal is left `proposed`
when an objective closes**: the wrap-up triages what remains, a proposal a triage run was
shown and did not take up is closed with a reason, and what is still waiting at the end is closed with a reason and
listed on the timeline (`closeProposals`).

**Follow-ups have a budget** (`FOLLOW_UP_BUDGET`, app preference `polish`: none, light, standard, thorough,
unlimited; Settings, Agents, "Polish"). Without one the loop fed itself: every finished task proposed about five
follow-ups, a planner run turned the ones "a player would notice" into tasks, and each of those proposed five more. In
two builds of 14 hours the plans were 24 and 33 tasks; polish triage added 119 and 85 (52 and 36 planner runs) and
defect triage 18 and 43, three quarters of each build's cost, and neither goal could close.
- The budget is a share of the plan's own size (`followUpBudget`). The default is light (`DEFAULT_POLISH`): polish
  tasks up to a quarter of the plan (at least 2) and defect tasks up to three quarters (at least 6); standard is half
  and the whole plan. Light is the user's choice: a build should spend its time getting the plan's own tasks right,
  not on rounds of follow-ups. What a goal has taken on is counted from the
  recorded `plan_add_task` calls of its planner tasks, by the planner task's title (`readFollowUpCounts`: a call is
  recorded as pending while it runs, so calls made side by side see each other; builds from before budgets count too).
- A triage run is told what is left ("BUDGET: this goal may still get N polish tasks, in all. So choose…") and
  `plan_add_task` refuses more. With nothing left no planner run is made: the proposals are closed with that reason
  (`closeForBudget`), the timeline lists them, and the chat says once what happened and where the setting is.
- The wrap-up is the rolling triage's last pass (by kind, under the same budgets), so a goal ends when its tasks
  are done: the budgets are what stops it. `unlimited` keeps the earlier behaviour ("Triage follow-ups (n)", twice).
- At the source: a run's optional ideas beyond its first two are not filed (`MAX_POLISH_PER_RUN`; defects always
  are), and the result schemas say so. **A reviewer files none**: it judges and reports defects only (its schema
  and instructions say "you judge; you do not design"). In two builds the reviewer filed 211 and 206 follow-ups in
  160 and 145 reviews, the largest source of the polish, while rejecting 10 and 14 tasks.

**What a review costs, and who gets one.** A review is a fresh run: about $0.70, nearly all of it its briefing and
the evidence it loads being written into the model's cache (the judging itself is a few thousand output tokens).
So: its briefing leaves out the list of the game's sounds, effects and models (it has the `*_list` tools); and a
code role's change of up to four files that a check which runs the game has proven needs no separate review
(`review-policy.ts`, `SMALL_FIX_FILES`; was two: the reviewer looked at 47 finished tasks of the code roles in those
builds and rejected none). Looks, levels, models and UI always get a reviewer: that is where its rejections were.

**The director can speak to agents that are working** (`Orchestrator.tell`, the director's `tell` in its reply): the
message reaches each running agent with its next tool result (the mechanism of a reworked prerequisite's note,
`pendingNotes`), is recorded on the task, and with `finishInMinutes` is a kept limit: the agents are told the time,
and a run still going `TELL.graceMs` after it is stopped and its task paused. (A user asked for "finish within 5
minutes" and was told the director could not reach running agents.) A plan update that only cancels work, or finds
nothing to change, is done, not "the planner did not add any tasks" (`UPDATE_PLAN_PREFIX`).

The orchestrator loop: UNDERSTAND → RESEARCH → PLAN → DECOMPOSE → DELEGATE → IMPLEMENT → OBSERVE →
TEST → CRITIQUE → REPAIR → VERIFY → DOCUMENT → CONTINUE. "Done" requires verified acceptance
criteria plus a passing independent critic review, recorded as evidence (a code fix of up to four files by an
engineer whose playtest or assert check passed needs no critic run: `orchestrator/review-policy.ts`).
Parallelism is automatic by default (`orchestrator/concurrency.ts`, `autoAgentLimit`): an agent for every ready
task plus the running ones, at least 3, at most the cap: 8 in one build by default (`DEFAULT_AGENT_CAP`), 32 at most
on Settings → Agents' slider (`AppPrefs.agentCap`, `PROJECT_MAX_AGENTS`; a project may set its own), and 96 across
every project window of the app as a safety net (`APP_MAX_AGENTS`; main tells each core how many agents work in the
other windows: `Core.setAgentsElsewhere`, from `OrchestratorState.working`). **Few agents per build, working
steadily.** A big team in one place spent its tokens queueing for the one Studio and re-reading what the others
changed, and runs cut off while they waited never finished; more builds side by side use an account better than a
bigger team in one build. 1.16.1 raised the limits after a long build showed why that was too strict: playtests are rare
there and its agents mostly write code. 8 per build by default (32 at most), 4 in Studio (16 at most), Kiln builds up to 32
(their own limit), 96 across the app; saved defaults move up (`agentCapV` 3). Playtests still go one at a time, and an agent
gives up its place in that line after `STUDIO_WAIT.maxMs` × `lineFactor` (9.6 min) and is told to work elsewhere and come
back. So:
- At most `STUDIO_AGENTS` (4) of a build's running tasks work in Studio (`studioBound`); a ready task that needs Studio
  waits unstarted, at no cost, while code-only, audio and modeling tasks start (`studioHeld`). This holds for a number
  fixed in Settings too. It is Settings → Agents' "Agents in Studio at once" (`AppPrefs.studioAgents`, 1 to
  `MAX_STUDIO_AGENTS` = 16). Measured over about 12,000 Studio calls: with 1 or 2 in Studio a playtest took 25-26 s (the
  slowest tenth 63-70 s) and 3-4% failed; with 3, 31 s, 106 s and 7%; with 4, 36 s, 128 s and 10%; with 5-6, 49 s,
  265 s and 13%.
- Planning holds a place like any agent, and goes first in line when one frees up (`tick` sorts the user's run-now
  tasks, then plans, then the rest).
- Defect triage waits for 5 reports or 20 minutes (`TRIAGE_BATCH`, `TRIAGE_AFTER_MS`; were 3 and 10): every triage is
  a planner run.
- A cap saved by an older version above 4 (the old default of 20, written back by any change in Settings) is read as 4
  (`AppPrefs.agentCapV`).
Usage does not hold work back (the same work costs the same usage fast or slow; runs pause at the limit and resume at
the reset; the reason line mentions a window from 85%), Kiln builds do not (their own limit, `kilnBuildsAtOnce`), and
the number of open windows does not. Agents that are only waiting hold no place (a tool marked `waits` in its
`ToolDefinition`: `kiln_request`, `kiln_builds`, `wait_for`; the registry tells `Orchestrator.park`, and the
semaphore's limit is raised by the parked count). The choice carries its reason (`OrchestratorState.agents.why`,
shown in the top bar and in the director's state). The planner, the workers and the critic run on the deep tier by default
(`DEFAULT_PROJECT_SETTINGS.modelTier`); the planner thinks at `max` (1.15.3, every plan and triage: its misses
cost far more than its minutes before the first task; `AppPrefs.plannerEffort`) and every other agent that takes an
effort at `high` (`AppPrefs.agentEffort`: specialists, critic, research, the director's passes, copilots), both set in
Settings → Agents and applied in `effortFor`; the planner's
prompt has it write one short contract, then every task that can start, then the rest
(`agents/roles.ts`). The contract's defaults for every new game include controls on every device, the game moving
players between phases itself, one settings menu, a mood per place, nothing purposeless, a movement test per area,
and (1.15.3) a hand-held first-time tutorial on skill `roblox-onboarding`'s Guide module: a spotlight on the one
thing to press with the rest dimmed and unclickable, world steps with an outline and marker, first time only,
skippable, replayable (checked in real Studio by `tests/e2e/guide.e2e.ts`). A project's tiers are saved only when chosen (`ProjectContext.updateSettings`); the default set
1.9 wrote into every project's saved settings is not a choice and is dropped on read (`savedSettings`).

**At the usage limit (1.15).** A run learns of its account's limit only on its next request, and what it already
asked for still runs: a build drove Studio for four minutes after its limit (checks and playtests that had waited
5-8 minutes in Studio's line, the rest of a batch of four placements), for answers no agent could read. When a run
ends cut off by the limit, `AgentRunner.limitReached` refuses every further call from a run on that account
(`AT_LIMIT`, through the run's `refuses`, until a run starts where there is room again or one succeeds) and
interrupts the team's runs on that account that are waiting on a call: closing a run's MCP session aborts its calls,
so their waits in Studio's line end. Those runs end as cut off by the limit (`errorKind: 'rate_limit'`: work kept,
attempt given back, continued in their own session after the reset); a run that is writing its answer is left to
finish it. With no account left (`AccountService.anyCanStart`), `Orchestrator.standDownForLimit` also stops the tasks
running their checks in Studio (they run again before the review anyway), and `critique` starts no review that would
only fail. The periodic place save still runs (it keeps the agents' last edits). Only the account's own limit does this
(`isUsageLimit`: a session, weekly or plan limit with its reset), not an overload or a stray 429; and a run that
started before the limit and finishes after it lifts nothing. Test: `tests/usage-limit-standdown.test.ts`.

Repairs continue the agent's own session (`orchestrator/continuation.ts`): a task that comes back —
rejected by the critic or the checks, out of turns, interrupted (pause, stop, restart), cut off by
the usage limit, or finished without its structured result — runs as a
continuation of its implementer's last provider session (`resumeSessionId`, recorded as
`runs.continues_run_id`) with a short brief (the defects, "continue where you stopped", "re-check
what others changed"), instead of a cold run that re-reads and re-explores everything; the critic
re-reviews a repair in its own earlier review session. A session older than 24 h, from another
provider or app version (`runs.app_version`: its tools may be gone), three continuations deep, or
one the provider can't find (fails in ~2 s)
falls back to a fresh run with the compiled context and the "Previous attempts" section. A session
belongs to the account that ran it (Claude Code keeps it in that account's config directory), so after
a switch of accounts every continued run started fresh: four agents in twenty minutes of one build, one
of them 62 turns into its task. A continued run now has its session's files copied to the account that
runs it (`IAgentProvider.carrySession`, `providers/claude/session-carry.ts`, asked by `AgentRunner.run`;
a `run.notice` says so). Not run against two real accounts: if the provider refuses a session another
account wrote, the run fails with no turns and starts fresh as before. A run's
cost and tokens are its own, not the session's: the Claude SDK's totals run on across a resumed
session (a repair's result reports the task's running total, not its own), so the adapter (`claude-runner.ts`,
`RunAccounting`) reads the session's usage when a resumed run starts and books the difference
(without a reading: an estimate from the run's own tokens). A run has one completion: the result the
SDK yields before it throws "returned an error result" is kept (it used to be replaced by an empty
failure, so limit hits and max-turn stops cost $0 and 0 turns), and a run that never reports (stopped,
crashed) books its stream's turns and tokens, and the cost last read (every 45 s). A run that only met
an API error (a transcript it refuses) reports no turns, which is what makes the task start fresh. The
planner adds independent tasks together (parallel `plan_add_task` calls in one turn) so the first
wave starts after one or two turns. Its brief teaches wide graphs (a dependency only when a task
consumes another's output; assets are made independently of code; wiring tasks attach through hooks the
contract spec defines and list exact files; lighting, atmosphere, audio and effects don't wait for the layout
and decoration waits only for its file; a game that opens in a menu, lobby or garage gets a Studio-only
test hook in its first gameplay task; only final test and QA dependencies are strict; chains at most 3 deep) and the
tool checks it (`orchestrator/plan-checks.ts`, pure and unit-tested): `plan_add_task` adds the task
anyway but answers with a WARNING when a dependency only adds waiting — a chain of more than 3
unfinished tasks, an asset task (sound-designer, vfx-artist, animator, ui-engineer) waiting for code
(roblox-engineer, luau-engineer), QA waiting for QA — and `plan_drop_dependency` removes a dependency
of a task that hasn't started. A dependency on a cancelled task is refused. The batch path
(`Orchestrator.addTasks`: the planner's structured result, the director's iterations) puts the same
warnings on the timeline (`plan.warning`).

A change the user asks for mid-build is the director's to enforce, not the planner's to get round to:
when the message narrows or retracts ("only X", "drop the rest", "never mind") the director cancels the
tasks the new scope rules out with its own task controls in the same reply (its state lists the
planner's unfinished work with ids, so a plan update the user takes back can be cancelled too; a
cancelled plan update ends its chat card). While a plan update from a user change is ready or running,
the scheduler holds the objective's older not-yet-started tasks, because the planner may cancel or
reshape them (`orchestrator/plan-gate.ts`; running work, tasks the planner adds, other objectives'
tasks and tasks the user runs now are not held), and releases them when it finishes, fails or is
cancelled. A reply never claims the plan changed while its plan update is pending (its brief says so;
`director/plan-claims.ts` appends a note when it does anyway), and finish estimates come from the
longest chain of remaining tasks (`director/eta.ts`), not from tasks left ÷ agents.

The director looks before it answers. Every message gets the quick pass (`ROLES.director`: the chat
tier at low effort, no file tools, a few seconds), which routes instructions and answers what its state
settles. Its state carries the game as built (`director/game-digest.ts`: what every finished task of
every goal delivered, one line each by specialist; what was reviewed without a look; open problems; the
regression suite; cached until the tasks, tests or visual notes change) and Studio's link
(`director/place-link.ts`). A question about the game the state doesn't settle comes back as intent
`look`, and the looking pass answers it (`director/look.ts`, `DIRECTOR_LOOK`: the deep tier whatever the
chat tier, medium effort, Read/Glob/Grep from the project folder and the read-only tools of
`LOOK_TOOLS`, among them `capabilities/director-tools.ts`: `evidence_search`, `test_results`,
`decided_list`, `studio_place`, `ui_snapshot`; no `ui_audit`, which starts a playtest). Its result is
handled like the quick pass's; when the message says "don't take any actions" (`noActionsAsked`),
whatever would start or steer work is dropped and the reply says so. A status line says it looked
("Looked into 4 things before answering."); what it read, from its recorded tool calls, is that line's folded
detail (`lookNote`: `data.trail`), never chat text. `PlaceLink` reads Studio's open windows every 30 s: when the place
file isn't open and exactly one window is Studio's auto-recovery copy of it
(`<place>_AutoRecovery_<n>[_<date>_<time>].rbxl`), the project is linked to that window in memory (the
saved setting keeps the place file), auto-save is off and `ensureStudio` doesn't open the place file
next to it, and the chat says once to save the copy over the place file with File > Save As; the link
returns by itself when a window has the place file again. Several copies, a published place's copy or
another place open are reported, never linked.

**The chat's story, honest and in plain words (1.15.8; `director/narration.ts`, `@shared/plain-words`,
`director/plain-words.ts`).** Audits of the user's projects found 208 "Done:" lines and 39 "Another pass" lines in one
chat, ~31 triage plan cards in another, cards overwritten by a later planning run or stuck at "Updating the plan…",
"checks and review passed" where `review.skipped` shows no review ran, a rejected review summed up by its first sentence
("Most of this works and looks good."), "built and verified" 15 s after five failing checks were quarantined, "3190
min" counted across a night's pause, a phone bow "passed" five times from Studio alone while the user re-reported it
broken five times, goals named "Ugh the Group Rewards Label", and ids, paths, coordinates, tool names and raw errors in
cards. The `Narrator` (wired by `Director`, outside its message handling) now tells it this way:
- **Progress messages.** A finished task's line, a send-back and a triage run's outcome are lines of one status message
  (`data.digest`, `data.items`), updated in place for `DIGEST.windowMs` (5 min) and until the user or the director says
  something, then a new one starts; a task's later line replaces its earlier one (`passes` counts the send-backs). A
  done line says the time *worked* (`activeMs`: running, checked, reviewed; not waiting, paused or overnight, from the
  task's status changes), what checked it (`checkWords`: "checks and review passed", "checks passed, review skipped",
  "review passed, no automated checks"; a static analysis counts only when it covered files of the task, its evidence's
  `data.files`), and "not checked on a real device" for work about phones, touch, tablets,
  gamepads or feel (`deviceSensitive`) with no real-device evidence. A send-back names the failing point: a rejected
  review's most serious defect or first unmet criterion (`reviewPoint`, from the `critic_review` evidence), the file
  that doesn't compile, the failed checks, or a raw error's meaning. A triage run is one line ("3 reported problems
  looked at: 2 became tasks."), never a plan card.
- **Plan cards: one per planning run.** A card carries its run's `planTaskId` and only that run finishes it: done
  (its summary and `taskIds`, the tasks its `plan_add_task` calls made, which is all the card lists), cancelled,
  interrupted, failed or stopped for a decision (the plan task's own status changes settle it, whichever code path set
  them). The director's `planTaskId: ''` right after `amendPlan` is that goal's newest open update; the start page's
  card is the first plan's. When a project opens (`project.changed`, after recovery) every card still planning is
  checked against its run, and one no run can finish says "This planning run ended without a report." A "next
  milestone" goal is named after the milestone its plan chose (`isNextMilestone` knows it by its brief), and
  `nextMilestoneTitle` never nests.
- **A finished goal** says "built and verified" only when no check was quarantined since it began; otherwise "**X** is
  built; N checks are still failing (…)" (`data.failing`, a warning card).
- **Plain words.** Question cards, auto-resolved decision lines, timeline lines and goal titles go through
  `plainText` (ids, Studio instance ids, paths → "the Combat client script", coordinates, tool and test names, raw
  errors → their meaning); option buttons get `labels` (`plainOption`) while the option itself is still what an answer
  sends; the escalation keeps its own words for the director and agents, and the card keeps them folded
  (`data.technical`). A fast model (`ROLES['plain-words']`, one small `AgentRunner.quick` call, only where the start
  page's ideas may call one) rewrites each card, any line the rules had to change, and a goal named from the user's
  own words (`titleFromPrompt`, which now drops filler: "ugh", "also,", "Not bad!", "can you"; `goalTitle` is the
  rules-only version for change requests); its answer goes through the rules again. `ChatService` turns a raw error in
  an error or system line into one plain clause (`scrubRawErrors`), keeping the line as it was in `data.technical`. The
  follow-up budget's notice is plain and correct when the count is past the limit (`budgetNotice`), once per goal and
  kind also across restarts.

**A user's "it's still broken" reopens the task (`Orchestrator.reopen(taskId, report): { ok, message }`,
`orchestrator/reopen.ts`).** The director calls it when the user reports that a finished task is still broken. The task
keeps its history (runs, evidence, failures, attempts used; it gets a fresh allowance on top), the report goes on it
(a `Reopened: …` note, and a `review`-stage failure so its next run sees it under "Previous attempts" and in a
continued session's brief), a "Reproduce first:" acceptance criterion goes first, it is set back to ready and a
finished goal it belongs to is reopened. Its next attempt is told to make the failure happen in Studio before changing
code; its work counts only when the task has a failing result recorded after the report (`reproduced`: a check that
failed — `task_run_checks` records its failing run for a reopened task — or `task_add_evidence` with `passed: false`),
otherwise it is sent back before its checks (`NOT_REPRODUCED`); its review is never skipped and the critic is told the
report. A task still being worked on gets the report and the requirement, and a running agent reads it with its next
tool result. Cancelled tasks, goals and planning steps are refused with a plain reason.

**A file that doesn't compile blocks passing (`verification/compile-limits.ts`).** Studio's compiler refuses a function
with more than 200 locals alive at once ("Out of local registers"), which selene and luau-lsp don't report: in the Pit
build Combat.client.luau stopped compiling and the tasks touching combat kept passing. The static analysis adds what
`localLimitOverruns` finds (a small tokenizer that follows blocks, if-expressions included; checked against 1,233 of the
user's scripts) for the task's files, or every synced script in the regression suite, and `luau_check` reports it too.
A task that changed Luau files gets the static analysis even when its checks didn't list it (a director's side task has
only the critic), and the files its agent reports in `filesChanged` count as its own (`Verifier.verify`'s `alsoCheck`;
they don't change the rehearsal's stamp). A failing analysis names the broken file first ("Broken: The Combat client
script (src/Client/Combat.client.luau) doesn't compile (line 2199: too many local variables in one function)"), and the
chat's send-back says it in those words.

**What a build costs, in one number (1.16; `costs/build-cost.ts`, `@shared/costs`).** The Claude SDK reports an
API-price cost for every run, on a subscription too, and it is on the run's row (`runs.cost_usd`; a resumed run books
only its own share, see above). Kiln's builds are runs with role `kiln` whose cost comes from Kiln's own transcript
(`capabilities/kiln-tools.ts`). The project's small fixed-model calls (`AgentRunner.quick`: plain words, the thumbnail
judge) were counted only in the account's usage; given a `project`, `quick` now books them in `cost_entries` (project
migration 11: id, at, source = the role, label, cost_usd, task_id). The start page's idea writer belongs to the app, not
a build, and is booked nowhere. `costOf(rows)` adds the runs and the booked calls up: the total, the groups (Building =
every specialist with a `work` output; Planning = `executive`, `architect` and any plan role; Reviews = `critic`,
`image-checker`, `ui-phone-reviewer`, `thumb-judge`; Director & chat = `director` in all its passes and `suggester`;
Copilots = `copilot-*`; Kiln models; Research = `researcher`, `reference-analyst`, `analyst`; Small helpers = plain words
and any role it doesn't know), each goal (a run's task followed up `parent_id` to its objective) and the first and last
time counted. `buildCost(root)` reads another project folder through a read-only connection (`DatabaseSync(…, {readOnly:
true})`: nothing is written, a project another window has open is read beside its writer, and a missing database or
table is a cost of nothing). RPC `costs.build` (the open project, through its own store) and `costs.forRoot({root})`.
The top bar's cost chip (`components/topbar.tsx`, `CostChip`) shows the total and opens the groups as bars, the goals
and the line that it is what the build would cost at API prices, Kiln included, and comes out of the plan's usage on a
subscription; it reads again on `run.updated` and `kiln.builds`. Test: `tests/build-cost.test.ts`.

## 6. Roblox integration

* `RobloxStudioAdapter` spawns the newest `StudioMCP.exe` over stdio (never a hardcoded version
  folder), discovers tools, records them in the capability registry with schemas, Studio version,
  reliability stats and known limitations, and runs integration probes.
* Code lives on disk (git-versioned) and syncs into Studio without ever overwriting an edit made in
  Studio (§12); the DataModel (map, UI, assets) is observed and changed through Studio MCP,
  snapshotted for before/after evidence. Studio cuts one `execute_luau` result at about 100,000
  characters, so `RobloxStudioAdapter.snapshot` reads a place page by page (`LUAU_SNAPSHOT`: each call
  walks the roots in the same order and writes the next few hundred nodes; a page Studio cut halves the
  page size; pages that disagree on the instance count mean the place changed and restart the read).
  A task's evidence file (`.shuriken/snapshots/<task>-<attempt>.json`) keeps only the nodes its diff is
  about (`diffEvidence`): two whole-place snapshots per task and attempt would be megabytes each.
  A snapshot cut at its instance cap, or taken while the place changed, makes its diff `unreliable`:
  the large-removal approval ("Safety nets", §9) stays quiet for it.
* Static checks: selene + luau-lsp. Runtime checks: `execute_luau` probes and MCP playtests with
  console capture and screenshots.
* Agent-written Luau (`roblox_run_luau`, registered asserts, playtest probes, world builders) runs
  through `runAgentLuau` / `withErrorLines`: Studio's own errors name no line of the code (and a
  syntax error is only "Failed to parse command code"), so the code is wrapped in an `xpcall` whose
  handler reads the chunk's lines from `debug.traceback` ("… (line 12)"), and code Studio can't compile
  is parsed offline by selene (`LuauToolchain.parseErrors`) for the line and reason. `loadstring` is
  unavailable in playtest DataModels, so it isn't used. Valid code that only compiles at the top level
  (`export type`) falls back to running unwrapped. Studio's plugin-path prefixes are stripped.
* `roblox_call` answers a rejected argument with the Studio tool's input schema (from the capability
  registry, long enums cut to their first values), so an agent doesn't spend a turn looking it up. Before the
  call it fills in what the schema leaves no doubt about (`roblox/studio-call-args.ts`): `datamodel_type`
  (the one value an input tool takes, else Studio's current mode), a wait's length as `wait_time_ms`,
  `steps` → `actions`, `key` → `key_code`; the result says what was filled in.
* Contention for the one Studio is handled in the adapter, not by the agents (failed Studio calls cost
  ~120 agent-minutes in a 4.6-hour build). The tool registry runs every handler in `withStudioCaller`
  (`roblox/studio-context.ts`), so a Studio call made inside an agent's tool call that needs the Edit
  DataModel while another agent's playtest holds Studio — or Server/Client before its own playtest is up —
  waits (`STUDIO_WAIT`: 6 min, 230 s for an MCP client that sends no progress notes; progress notes say who
  holds Studio and since when) and then runs; only a wait that runs out fails, with that message.
  "Target is not reachable" (Studio switching modes) is retried; a playtest nobody leased (started by hand)
  is waited out by polling Studio's mode; calls outside a tool call (verification, auto-save, the app's own
  views) are never held back. Playtests are time-boxed (`PLAYTEST_LIMITS`, since 1.15.7: an agent's playtest, a "run" too, plays
  `playMs` = 60 s from the moment Studio has it up (`PlaytestLease.markPlaying`; the load is not counted, but a start
  still not up `loadMs` = 5 min after it took Studio gives Studio back), with no extension; an agent's
  hand-started one gives way after 30 s without a Studio call of its own while others wait; the world's rebuild and a
  reopening of the place (`healer`, `refresh`) keep Studio until they are done, up to `healMs` = 30 min (since 1.15.8:
  on 2026-10-07 a 13-minute rebuild was cut at 3 and agents played a half-built map; everyone else waits in line
  meanwhile, as behind any holder); anyone else holding Studio
  has `maxHoldMs`, and Shuriken's own checks (`verifier:`) at most `ceilingMs` = 15 min. Every start and stop of play
  has a deadline (`ENFORCE`, `inShotLine`), the stop of a playtest past its limits is waited for `ENFORCE.stopMs` and
  Studio goes to the others after it whatever Studio did, a Studio that went takes its playtest's turn with it
  (`PlaytestLease.forfeit('crash')` and `resetPlayLine` from `StudioRecovery.reopen`), and the user frees Studio from the
  Agents page or through the director (`Core.freeStudio`, `freeStudio` in the director's output, checked against the
  user's words): on 2026-10-06 a start whose Studio hung held every agent out of Studio, and every code sync, for 90
  minutes. Before 1.15.7: 3 min, or 90 s once others waited, extendable once; verification is
  exempt). The line for play mode goes shortest first (since 1.13.8; `LINE_ORDER`, `PlaytestLease.next`): each caller says how long it will hold Studio when it asks (`want(owner, estimateMs)`: `playtestTurnMs` for a `roblox_playtest` call, `checkTurnMs` summed for a check run), the shortest goes next and of equal ones the earliest, and one that has waited `agingMs` (3 min; a check run, owner `verifier:`, `checkAgingMs`, 1 min, since 1.14.1: shortest-first had put check runs, which finish tasks, behind every playtest, a median 134 s in the first 1.14 build) goes before anything shorter that came later, so nothing waits forever; screenshots (`shot:`) still go before every playtest. A long turn lets the screenshots that wait in between two of its playtests (`PlaytestLease.yieldToShots`, `Verifier.letShotsIn`): it hands Studio over, they draw, and it takes Studio back before any other playtest (`resuming`). In the two 14-hour builds of 2 October playtest calls averaged 108-113 s and check runs 175-268 s, nearly all of it in line, and an environment artist's one-second screenshot waited 90 s on average behind check runs. A playtest check that passed when the task's checks last ran (`task_run_checks`) stands for the next run, the worker's own or the verification, when the task's files are unchanged and it is under ten minutes old (`REHEARSAL_REUSE`, `Verifier.codeStamp`; four minutes and the verification only before 1.13.8): in a 12-agent build Studio started 91 playtests in half an hour, 42 of them agents' own, most of the rest each task's checks played twice. A playtest an agent drives by hand ("start") is refused while two or more others use or wait for Studio (`HAND_START`, 1.14.1; four UI designers opened five such sessions in ten minutes of the first 1.14 build). A `roblox_playtest` of a place in which nothing changed since the same agent's previous one (`roblox.changed` events other than playtests and connections, within `REPLAY_NOTE.withinMs`) ends with a note that it played the same game again and that its questions belong in one run: a third of all playtests in those two builds did. The way to play is one call: `roblox_playtest` "run" carries the whole plan of a check as `steps`
  (server and client probes, key presses, mouse actions, short waits, up to four pictures) and does them at
  Studio's speed, 10-30 s, where sessions driven by hand held Studio 35-98 s in a measured 12-agent build. The limits are enforced by
  `RobloxStudioAdapter.enforceLease` — at once by every caller waiting for the lease, and by the core's
  10 s watchdog. `wait_for` (`studio_edit` | `upload` | `kiln_turn`, `capabilities/wait-tools.ts`) is the
  server-side wait that replaces shell sleep loops. A screenshot of a Studio that isn't drawing is retried
  once (a minimized window is first restored behind the user's windows without focus), then reported as the
  environment condition "Studio isn't drawing (minimized, the display off, or its screen capture stopped answering)": a plain result
  for `roblox_screenshot`, a skipped "can't check visually" for verification, never a rejection (the critic's
  instructions say so). A task that passes that way is marked **visual check pending**
  (`orchestrator/visual-checks.ts`: the review's `visualCheck: "not_possible"`, or a not-drawing screenshot and
  no picture since its checks began; a note on the task and a line in its result). When a `roblox_screenshot`
  comes back with a picture again, one critic run looks at the objective's pending tasks together
  (`Orchestrator.lookWhenStudioDraws`), at the latest right before the final regression suite; a task that looks
  wrong gets a "Fix the look of …" task the objective waits for. If Studio still isn't drawing then, the objective
  closes, its summary lists the tasks nobody looked at and the director's chat says so (`visual.unchecked`).
  **Saving the place** (`PlaceGuard.saveNow`; Studio's MCP has no save command). Through Studio's File menu
  (`pressSaveInMenu` in `roblox/studio-window.ts`): the window's accessibility interface (UI Automation) opens
  File and presses "Save to File". No key is sent; it does not depend on Windows letting Studio come to the
  front; during a playtest it saves the place being edited and the playtest plays on, so a save takes no turn in
  Studio's line. Opening the menu makes Studio the foreground window, so the window that was in front is put back
  0.15 s after the press (Studio has the focus for 0.11-0.16 s; 0.3 s once in twelve); with someone at the PC the menu is opened only after 1.5 s without a key or a mouse move (a key pressed
  while it is open would choose an entry), and with someone working in another app only for changes 20 minutes
  old (`PLACE_SAVE`). A place unsaved for 30 minutes is said once in the project's activity, with what holds the
  save back (`place.save.late`). A problem with saving is said in the chat once per kind (`PlaceGuard.tell`: Windows
  refusing Studio the focus, a dialog in Studio, no window with the place while the team works, anything else; a
  failure after three in a row), and the same kind again only after a save worked in between and `tellAgainMs`
  (12 h) after it was said, never with a promise to stay quiet. No Studio window with the place while nobody works
  and nothing reopens it (the user closed Studio with the team paused) is no failure: said once in plain words,
  without "press Ctrl+S" (before 1.15.8 the chat said it every hour, fifteen times in one day). A place file whose
  content is the other format than its name (`placeFormatMismatch`: binary data in an `.rbxlx`, what 1.15.7's
  recovery copies left) is said once with the fix (in Studio's Save As dialog keep the folder and the name, pick
  "Roblox XML Place (*.rbxlx)", confirm the overwrite), when the place opens (`Core.ensureStudio`, after a reopen) and
  at save time, and the menu is not pressed until the file is fixed: Studio answers every save of such a file with a
  Save As dialog. Measured: `tests/e2e/save-menu.e2e.ts` (12 of 12 presses saved). The menu's
  entries are looked for under the menu's own entry only (a search of the whole window took a second, with the
  focus in Studio all the while), and a menu that did not open is asked again, up to three times. A Studio without those menu entries (another language) is saved with Ctrl+S as before,
  with everything that guards the keys: a turn in Studio's line, Edit mode, Studio in the foreground, never while
  the user works in another app. For the keys, auto-save tries three times to bring Studio forward, then reports
  once and backs off for 10 minutes; Studio's own recovery copies are backed up meanwhile.
  With nobody at the PC (`IdleTracker` in `roblox/studio-window.ts`: no input for `UNATTENDED.idleMs`, 3 min, by
  `GetLastInputInfo`; "can't tell" counts as someone being there) the window may be moved and is put back: for a
  capture Studio goes above the other windows without activation (`showForCapture`, `raiseStudioWindow` /
  `lowerStudioWindow`) and a sleeping display is woken when `keepScreenOn` is set (the wake is not taken for the
  user coming back); for a save Studio comes to the foreground by sharing the foreground thread's input state
  (`ShurikenWin.Front`, where a plain request is often refused) and the window that was in front returns after it.
  With someone there none of it happens. A save whose keys changed nothing names the dialogs Studio shows
  (`docs/STUDIO-BACKGROUND.md`; not yet run against a real Studio window).
* **Roblox's login lock** (`roblox/studio-login-lock.ts`). Studio refreshes its login under a Windows mutex
  (`www.roblox.com-oauth2RefreshToken-Studio`). A Studio sometimes takes it on one thread and releases it from another,
  which Windows refuses ("~NamedMutex::unlock(…) failed: Attempt to release mutex not owned by caller"): it holds the
  lock until its process ends, and every Studio started after it hangs at its automatic login, forever. Seen 2
  October 2026 in 1 of 27 Studio starts on record; behind it hung four play windows, a scratch Studio, a plain Studio
  and the next project's own Studio. A Studio that did it says so in its log within a second or two of starting.
  - Every Studio Shuriken starts (`RobloxStudioAdapter.openPlace`) is looked at `LOGIN_LOCK.checkAfterMs` (4 s) in,
    also when its place has opened already (it opens in about 5 s; 1.13.6 looked only while still waiting, and missed
    it): its log is found by its start time (Studio names its logs after it) and read. One that kept the lock is
    ended and started again at once (nothing is in it yet), up to twice. Both Studios that kept it on 2 October were
    the first one started after every Studio had been closed (they refreshed the login at start); the one started
    again finds the login fresh.
  - One that hangs at its login (not responding, no place in its title, for `stuckAfterMs`) is reported with the
    Studio that holds the lock (`onLoginLock`: the chat names the window), and is ended when it never opens, not left
    behind.
  - A project's own Studio that holds the lock while another Studio hangs behind it saves, closes and reopens its
    place (`StudioRecovery.letGoOfLoginLock`, every 20 s while agents work, at most every `LOCK_RESTART.cooldownMs`;
    never without a save). The lock is let go when its process ends, and the Studios that waited carry on.
* A Studio that closes during a build (a crash) is reopened by the app, not by an agent asking for permission
  (`roblox/studio-recovery.ts`, owned by `PlaceGuard`). Every 20 s while agents work or a verification runs, and
  at once when a Studio call finds no instance (`RobloxStudioAdapter.onGone`), it asks Studio's MCP for the bound
  place; when that is missing it asks Windows (`studioWindowState`: a window titled with the place, or a Studio
  process younger than two minutes) so that a Studio that is only loading, or has its MCP server off, is never
  opened twice. Gone: `openPlace` on the project's place file, up to 3 tries of 180 s (and at most 6 launches in
  30 minutes), one status line in the chat that is updated as it goes, then the place is checked for its world
  (`PlaceGuard.heal`, again for the new Studio session) and the code is pushed. Tool calls made meanwhile wait
  (`RobloxStudioAdapter.reopening`, the same budget and progress notes as the wait for play mode) and run when
  Studio is back; a reopen that failed comes back as an error that sends the agent on with other work. A
  verification whose checks met a Studio that was gone waits for the reopen and runs once more
  (`Verifier.overCrash`). A Studio closed while nobody works is left closed.
  - **What a real crash showed (2026-10-02).** Studio ended itself at the
    start of one window's 256th playtest ("RBXCRASH: Ran out of remap ids", read from the end of its log:
    `studioCrashReason`, said in the `studio.gone` event and the chat). The place came back as its last save,
    167 minutes old, while Studio's own recovery copy was 19 minutes old; the syncs that followed wrote old scripts
    over eight newer files and trashed four, checks failed on things that were gone, and the team spent an hour
    putting the work back.
  - **The place opens from Studio's recovery copy** when Studio left one newer than the place file and in the place
    file's own format (`PlaceGuard.recoverCopy`, before the reopen; Studio writes its copies in its binary format, so
    this is for `.rbxl` places): the copy takes the place file's stead, and the file as it was saved is kept as
    `.shuriken/backups/saved-<time>.<ext>` (five of them). A copy that is not a whole place file is not used; one
    that does not open is put back and the place opens as it was saved. An `.rbxlx` place opens as it was last saved
    (as before 1.15.7) and a crash with unsaved work is put back from the files: 1.15.7 put the binary copy in the
    `.rbxlx` file's stead, Studio opened it (it reads the content), but answered every save, Ctrl+S and File > Save to
    File alike, with a Save As dialog (2026-10-07).
  - **Then the place is put back from the files** (`PlaceGuard.restore`, after a crash, when work was unsaved or a
    copy was used): every world builder runs, the code is pushed (after a reopen the files win:
    `SyncBase.isSuspect`), the team is held meanwhile, the place is saved, and the chat says it in one line.
  - **A window that turned into another place is not a crash** (since 1.15.8): the process that had the place file
    now shows another place (`movedTo`: the user published from it, or opened another place in it), or the core was
    told so (`afterMove`, from `Core.followPlace`). The local file is reopened (from a same-format recovery copy, or
    as it was saved), `reopened` is told `moved`, and PlaceGuard runs `heal` only (a rebuild only when the world is
    missing) and pushes the code from the files the way every sync puts it; nobody is held. The one status line says
    it is not a crash and nothing was rebuilt. On 2026-10-07 a publish was taken for a crash: the world was rebuilt
    from 35 build scripts for 13 minutes, the team held, over a recovery copy ten minutes old and whole. The move is
    forgotten once handled: Studio going after it is a crash again.
* **Play windows** (1.13.3 to 1.13.7: extra Studio windows with a copy of the place that only ran playtests, so
  agents didn't stand in line for one play mode) are gone: dropped in 1.13.8
  and their code removed in 1.14. Every one was another Studio start, and a Studio start is where Roblox's login
  lock (above) hangs every Studio after it; in the first two real builds with them they hung twice, and a fix above
  95 % reliable was not in reach. Studio plays one game at a time, made faster by the line's order and reuse (§6,
  "The line for play mode"). An old `playWindows` app setting is forgotten when the preferences are read.
* Studio's screen capture can die for good, and the app repairs it. Measured 2026-10-02 in scratch places
  (`tests/e2e/capture-focus.e2e.ts`): a capture in flight when its playtest stops is answered "Target is closed",
  and that Studio answers no capture after it (each times out; in Edit and in later playtests; over a new MCP
  connection too; Luau goes on working) until the place is closed and opened again. A window that is covered,
  unfocused or beside another Studio is NOT the cause: every such capture answered in about 0.3 s, in Edit and in
  play. So (1) starts and stops of play stand in the captures' line (`inShotLine`): neither meets the other; (2)
  "Target is closed", or `CAPTURE_DEAD_ROUNDS` rounds of timeouts, marks the tool dead (`capturesDeadSince`): one
  clear message, no retries, a short look every `SHOT_RETRY.pauseMaxMs`; (3) `StudioRecovery.refresh` saves the
  place inside its own turn in Studio's line (`PlaceGuard.saveNow` with `held`), closes its window the way the X
  button does (`closeStudioWindow`; only a window titled with exactly that place file, ended as a process only
  after the save), opens it again and checks that a capture answers: 21 s in the measurement, with a part made
  just before it present afterwards. Never while someone uses the PC (said once in the chat instead, done when
  they have been away for `UNATTENDED.idleMs`), never when the save failed, never while nobody works on the
  project, at most every `STUDIO_REFRESH.cooldownMs`, and once only for captures that merely time out (a display
  that is off looks the same). Agents' Studio calls wait as they do for a crash.

## 7. UI

- **Start page** (`pages/start.tsx`): one question, one box, game ideas as bubbles. The idea being typed is kept
  (`shuriken.startDraft`) across a visit to Settings and a restart. The ideas are written for the user
  (`director/start-ideas.ts`, since 1.14): one call of the `ideas` role (fast model, no tools, no project:
  `AgentRunner.quick`) writes 12 new games from the user's projects (about a third near what they build, every
  one a whole new game with a 60-110 word first message), kept in the data folder's `start-ideas.json` and written
  again when the projects change or a day has passed (at most every 10 minutes; "More ideas" shows the next six
  and then asks for a new set, at most every 30 s). Until then, and without the model, hand-written ideas
  (`director/suggestions.ts`, 28 games, about a third near the user's genres, in a daily order). Before 1.14 the
  start page also offered changes to games the user had ("Add rebirths to my tycoon"); it never does now.
- **Project windows** along the top bar, each with its own core; the **dashboard** of containers (the Studio
  viewer, the director's chat, agents, models, animation, effects, audio, UI, Kiln, quality) that can be moved,
  resized and hidden; each title opens its full page; docks (animation, effects, audio, UI) have their copilot
  beside them, open whenever the page opens (closing one lasts until the app closes; a draft it makes opens it).
- **Appearance** (`lib/appearance.ts`, 1.14): the colour theme (Orange, Teal) and the calm dashboard, kept in
  localStorage, which every window shares; a change in one window reaches the others by the storage event.
  Every colour is a token in `styles.css` (`html[data-theme='teal']` redefines them); canvas and WebGL drawing
  read them (`themeColor`). The theme switch is on the start page and in Settings → Appearance. Calm dashboard
  (the dashboard's top bar and Settings): the dashboard's effect, animation and model previews hold one still
  frame (`EffectsView.setStill`, `MannequinView.setStill`, `RigPlayer.setStill`, no turntable); their pages and
  opened containers still play.
- **Settings** in six sections: Appearance, Claude accounts, Agents (permissions, the team, polish), Roblox &
  Studio (the default account, community and key for uploads; the open project's own community or account and key; saving, the plugin, the screen), 3D models & Kiln, App (connections, logs).

## 8. Technology choices (and why)

| Concern | Choice | Reason |
|---|---|---|
| Shell | Electron 44 | IDE-grade desktop apps (VS Code) ship on it; the Claude Agent SDK and MCP reference SDK are TypeScript-first; one language across the stack keeps it maintainable by agents. |
| DB | `node:sqlite` | Built into Electron's Node 24; no native build toolchain needed (none is installed); FTS5 + JSON1. |
| Claude | `@anthropic-ai/claude-agent-sdk` | Official programmatic Claude Code; uses the local Claude login; capability-probed at runtime. |
| MCP | `@modelcontextprotocol/sdk` | Reference implementation; Streamable HTTP server + stdio client. |
| UI | React 19 + Tailwind 4 | Well-known to agents; fast to build dense UIs. |
| Build | electron-vite + electron-builder (NSIS) | Standard, supports utilityProcess entries and Windows installers. |

## 9. Components added after the first slice

| Component | Where | Purpose |
|---|---|---|
| Plugin boundary | `core/plugins/plugin-service.ts`, `docs/PLUGINS.md` | External MCP servers, skills and knowledge become capabilities without core changes (`external_tools` / `external_call`). |
| Code intelligence | `core/code/luau-index.ts`, `code_query` tool, Code view | Static Luau index: client/server/shared context, requires and transitive dependents, symbols, remotes (defined/fired/handled), DataStores, tags, attributes. |
| Open Cloud Luau | `core/roblox/open-cloud-luau.ts`, `cloud_luau_run`, `cloud_luau` verification | Headless Luau on a published place (CI backend). API key stays encrypted in main (DPAPI) and is requested by core on demand. A project may have its own key (`@shared/roblox-keys` `projectOpenCloudKey(id)`, set by the renderer from Settings, the start page or Open a game): `roblox/project-keys.ts` gives it instead of the default to uploads, the store push and cloud Luau while that project is open, and `uploads.owner` says which key is in use. Its community or account (`ProjectSettings.robloxGroupId` / `robloxUserId`) comes first in `roblox/upload-owner.ts`. |
| Playtest lease | `core/roblox/playtest-lease.ts` | One owner of Studio play mode at a time (agents and verifier), taken in line (waiters wait, abortable) rather than refused; leaked playtests stopped when a run ends (the lease is kept until the stop goes through: a stop that meets "Start play hasn't finished yet" is asked again, 5 × 2 s, by `setPlaying`), and play mode is time-boxed (`PLAYTEST_LIMITS`: an agent's playtest plays 60 s once it is up, loading not counted, no extension; an agent's hand-started playtest with no Studio calls of its own for 30 s is stopped while others wait; the world's rebuild and a reopening of the place keep Studio until done, up to 30 min; a crash or the user freeing Studio ends the turn too; the agent is told why on its next call; see §6). Agents check behaviour with `roblox_playtest` "run" — start, wait for the character (not in a game that opens in a menu: with `Players.CharacterAutoLoads` off, or after a playtest of the project that got none (`.shuriken/playtest.json`, `roblox/playtest-character.ts`), it only waits for the player to join and says "This game doesn't spawn a character on join; probes ran without one"; `expect_character` overrides either way), `seconds` of play, Server/Client probes, optional screenshot, output errors, stop — in one call, so play mode is held for seconds instead of the 16–163 s multi-turn sessions of the logged runs. `roblox_run_luau` refuses fixed sleeps over 5 s (Edit) / 20 s (play): Studio runs one request at a time for everyone. |
| Asset library | `core/assets/asset-service.ts`, Assets view | Records assets inserted/generated through Studio with source and generation parameters. |
| Provider version guard | `Core.verifyProviderVersions` | A changed provider version is re-verified by a live probe; runs are blocked while a provider is unavailable. |
| Project lock | `.shuriken/open.lock` in each project (`projects/project-lock.ts`) | One core per project; a stale lock is taken over (its process is gone, or its PID now belongs to a process that started after the lock was taken: Windows reuses PIDs). Several cores share the data dir: every project window runs its own core, and main tells each how many are building so they share the agent budget. A window switching to another project (`Core.switchProject`, a prompt from the start page through `Core.leaveFor`) takes the other one's lock first, so a refusal leaves the current project open; then it interrupts the current project's agents and waits for them (`Orchestrator.letGo`) before its store closes, so their tasks come back as interrupted and carry on in their own sessions when it opens again. The UI asks first when agents are working. A project whose folder (its `.shuriken/project.json`) is gone is refused before the lock is taken, never made again empty; registering its new folder re-points the listed project. |
| Safety nets | orchestrator | Two tasks that claim the same file never run concurrently (`orchestrator/file-claims.ts`: a folder in `files` keeps nobody out; each agent's directive lists the files in its folders that other running tasks claimed or are editing, `roblox_sync_push` leaves those out, and `plan_add_task` answers with FILES when two tasks claim one folder, fixed with `plan_set_files`); large DataModel deletions (25+ instances gone from the place) escalate as destructive — looked at again a few seconds later so a kit another agent was rebuilding doesn't count, and never for a task that shared the place with other running tasks (its diff is labelled as possibly theirs) or whose snapshot was cut; world changes end with a save-place request. |
| Learning loop | orchestrator + knowledge | Knowledge recorded during a task is validated when the task passes verification + review; validated project knowledge is offered for promotion. |

Verification of the foundation: `npm test` (unit + integration with a fake provider through the real MCP server),
`tests/e2e/*.e2e.ts` (live Claude + Studio), and `electron . --smoke --smoke-crash` (every view + core crash recovery).

## 10. Later additions

| Component | Where | Purpose |
|---|---|---|
| Integrated terminal | `core/terminal/terminal-service.ts`, Terminal view | ConPTY sessions via node-pty's prebuilt N-API binaries (no compiler needed); output streamed as events. |
| 3D preview | `roblox.scene` RPC, `views/scene3d.tsx` | Read-only three.js viewport of the bound place from live DataModel snapshots (parts with real transforms/colors). Every three.js view draws on demand: when something changes, while its camera moves or the user touches it, every frame only while it animates (a turntable at 30 frames a second, a clip, an effect), and nothing while unseen (`components/scene/visibility.ts`: the window hidden or covered, the element off screen). |
| Performance tests | `perf` verification method | Server heartbeat/physics/instance budgets measured during a playtest; regression-tested like other tests. Memory is reported and never judged: in Studio `Stats:GetTotalMemoryUsageMb` is the whole Studio process (3.6–5.2 GB with nothing of the game's running), so `maxMemoryMb` in an existing check is ignored and the check's output says so once. |
| Studio session | `Verifier.withStudio` | A verification owns Studio (mutex + play-mode lease) for its whole Studio phase, which lasts about as long as its checks: its Studio calls are never held back and its code sync goes ahead of the agents' (see "Code sync keeps Studio's side"); agent Edit-mode tools wait while another owner plays. |
| Project report | `core/projects/report.ts` | Markdown report from the project's own records in `.shuriken/reports/`. |
| Continue step | orchestrator | After an objective completes, a human-gated offer to plan and execute the next roadmap milestone (autonomous mode starts it by itself, see §13). |
| Notifications | main | Native Windows notifications for escalations and finished objectives when the app is not focused. |
| Asset analysis & reuse | `core/assets/asset-capture.ts`, `asset_*` tools, Assets view | Studio asset tools (insert/generate/segment/texture, async jobs via `wait_job_finished`) are captured: placements found from reported paths, CollectionService tags or a before/after child diff; each placement is tagged `ShurikenAsset_<id>` for usage tracking and analyzed in Studio (geometry, materials, textures, polycount via EditableMesh where permitted — otherwise reported unmeasured — collision, LOD, dependencies, scripts with backdoor markers, procedural parameters). History records generation, reuse, modification and analysis. Live check: `E2E=assets`. |
| Structured geometry | `core/geometry/geometry.ts`, `geometry_apply` / `geometry_read` | Models as data: parts, parametric generators (array, grid, ring, stairs, arch, wall with openings) and CSG (GeometryService). A spec is validated and expanded, saved as `world/<Name>.geometry.json`, compiled into an idempotent `world/<Name>.luau` builder (fixed interpreter + embedded data), built in Studio, and recorded/analyzed in the asset library; existing models read back into specs (unions/meshes reported as opaque). Live check: `E2E=geometry`. |

## 11. Workshops (1.2)

Each workshop follows the same shape: **data files in the project are the source of truth**, a
generated idempotent builder under `world/` puts them into the place (so `world_rebuild` and
PlaceGuard's heal restore them), a generated runtime ModuleScript in the synced shared folder plays
them from game code, agent tools write the data, and a page + dashboard tile show them.
While other agents are working, an agent's `world_rebuild` without files runs only its task's own
builders (a full rebuild would re-run the others' builders in the middle of their edits).

| Workshop | Data | Builder → place | Runtime module | Tools |
|---|---|---|---|---|
| Animation | `animations/<Name>.anim.json` (`@shared/animation` clip: keys per R15 joint, easing, markers; hands may give `reach` (a point, solved by IK) and `aim` (blade direction, solved at the wrist)) | `world/Animations.luau` → KeyframeSequences + Animation objects in `ReplicatedStorage.ShurikenAnimations` (id: the uploaded asset when the clip has a current upload — the Animation's `AssetId` — else `KeyframeSequenceProvider:RegisterKeyframeSequence` in Studio) | `ShurikenAnimations` v5 (`play`, `onMarker`, `markerTime`, `length`, `hitStop`, `useMovement` for idle/walk/run/jump/fall/climb/swim) | `animation_presets/create/build/list/view/check/upload/remove` |
| Effects | `effects/<Name>.fx.json` (`@shared/effects`: emitters and a timeline of `tracks`, trail, beam, light; `variantOf`: made from another effect by a recipe), textures in `effects/textures` + `assets/vfx`, cutscenes in `effects/cutscenes` | `world/Effects.luau` → templates in `ReplicatedStorage.ShurikenEffects` + a relay RemoteEvent | `ShurikenEffects` v4 (`play`, `attach`, `trail`, `beam`, `projectile`, `lightning`, `telegraph`, `shake`, `hitStop`; server calls relayed to clients because `Emit` doesn't replicate and cameras are client-side) with `ShurikenCurves`, `ShurikenScreenFX`, `ShurikenCutscene`, `ShurikenWeather` + a client listener script | `vfx_presets/create/measure/texture/build/list/play/cutscene/runtime/use/remove` |
| Audio | `audio/<Name>.sound.json` (+ `audio/CREDITS.md` for imported tracks and the samples songs play); generated MP3s in `assets/audio` (synth + lamejs) with each song's score next to it (`<name>.song.json`), imported files in `assets/audio/imported`, the samples a song plays copied to `assets/audio/samples` | `world/Audio.luau` → Sound templates in `ReplicatedStorage.ShurikenAudio` + SoundGroups | `ShurikenAudio` (`play` 2D/3D with random pitch/takes, `music` crossfade) | `audio_sfx/music/music_edit/score/find/import/add/use/upload/list/remove`, `audio_sample_find/sample_add/samples` |
| 3D models | `models/<Name>.blend` (the Blender scene; versions in `.shuriken/blender/<Name>/history`) → per material a Roblox part: `models/<Part>.glb` + `.mesh.json` + `.model.json` (stats, look `color`/`material`/`transparency`, upload, placements; a model with several materials is an `assembly` of parts with `origin`s) | `world/Models.luau` → re-inserts uploaded meshes at their placements | — | `model_build/view/place/list` |
| Custom rigs (1.8) | `models/<Model>.rig.json` (joints with pivots, axes, limits; legs; attachment points) and the model's parts by segment; clips with `rig` in `animations/` | `world/Rigs.luau` → templates in `ReplicatedStorage.ShurikenRigs` (HumanoidRootPart, an invisible part per segment at its pivot, Motor6Ds named like the joints, the meshes welded on, Attachments, AnimationController + Animator); rig clips go through `world/Animations.luau` with their joints' parents | `ShurikenAnimations` (plays on any model with an AnimationController) | `rig_build`, `animation_create {rig, motion | clip}`, `animation_check`/`view` |
| Gear (1.8) | `models/gear.json` (item, model, tool or accessory, the grip or body point) | `world/Gear.luau` → Tools / Accessories in `ServerStorage.ShurikenGear` (or StarterPack) | — | `model_gear` |
| UI (1.5) | `.shuriken/ui/snapshot.json`: the ScreenGuis last read from Studio (`@shared/ui-layout` nodes, UI* modifiers folded into their parent) with their audit; image thumbnails in `.shuriken/ui/images`; mockups in `.shuriken/ui/mockups/<name>.json` (1.9.1); icons and shape images in `ui/icons` | — (the UI lives in the place and the team's scripts; this workshop reads it, and mockups stay in Shuriken) | `UiIcons`, `UiShapes` (generated) | `ui_audit`, `ui_mockup_create`/`_update`/`_list`/`_audit`/`_render`, `ui_reference`, `ui_icon` |

**The effects player** (`shared/fx/`): one implementation of how ShurikenEffects plays an effect, for everything that
draws one outside Roblox. `compile.ts` turns a spec into emitters and tracks (also what the builder writes);
`sim.ts` (`EffectSim`) plays them with Roblox's rules (emitter spread, drag, acceleration, flipbooks, squash as
powers of two; each track's curves over its duration; looping tracks; spawned effects) and describes a frame as
sprites, strips, solids, decals, lights and screen cues; `mesh.ts` (`tessellate`) turns a frame into triangles in
draw order, blended as LightEmission does (colour × alpha added, the background kept by 1 − alpha × (1 − emission));
`stage.ts` is the floor, sky, bloom numbers and the camera framed on what the effect shows. Two renderers draw those
triangles: the app's preview (`renderer/components/anim/effects-view.ts`, three.js) and the core's software rasteriser
(`core/effects/render.ts`), which makes the contact sheets `vfx_create` and `vfx_measure` return and measures them
(`critique.ts`: how much of each layer shows by day, against a bright sky and in the dark, white-out, overdraw).
Textures come from `core/effects/preview-textures.ts`: the project's PNGs for `tex:<Name>`, generated look-alikes for
Roblox's built-in particle textures. Approximate on purpose, and said so in the preview and in `look.notes`: scene
lighting, Bloom, Roblox's own textures, sounds. A change to the Luau runtime's behaviour is a change to `sim.ts`.
Saving an effect never waits for another playtest (`pending`; `EffectStore.builtInStudio` knows whether the place
has the effects as they are now, and `vfx_build`/`vfx_play` build what is pending).

**The audio engine** (`core/audio/`): every generated sound is mastered the same way (`dsp/master.ts`): DC removal,
a 16.5 kHz zero-phase low-pass (the MP3 encoder does it anyway; it keeps true-peak detection exact), end fades, a
BS.1770-4 loudness meter, per-category loudness targets in one table (`LOUDNESS_TARGETS`: music -16 LUFS-I, ambience
-24, impact -12, pickup -16, ui -20, footstep -22, plus movement -18 and stinger -14 LUFS-M) and an 8x-oversampled
lookahead true-peak limiter at -1.5 dBTP. MP3s are 192 kbps (at 128 lamejs overshoots that ceiling by up to 3.5 dB).
`checkAudio()` is the gate every `audio_sfx`/`audio_music` result carries (peak, loudness against its target, DC,
start silence, loop seam, stereo). Looped MP3s keep `loop {start, length}` in the sound entry (lamejs writes no
gapless tag, so a decoder plays the 1105-sample encoder delay first) and `world/Audio.luau` sets
`Sound.LoopRegion`/`PlaybackRegionsEnabled` from it inside a pcall: **not checked in Studio yet**. Effects
(`sfx.ts`, `sfx-presets.ts`) are layered voices (band-limited oscillators, noise colours, modal banks, FM, grains)
through resonant filters, a small room and soft clipping; songs are written by `compose.ts` (a `SongSpec` from a
style: voice-led chords, a developed melody, bass, drums with fills, swing and human feel, A/B sections) and
rendered by `music.ts` (reverb and delay as sends, kick sidechain, mono bass, tails folded onto the start so the
loop is seamless; a song may have an intro that plays once, `introBeats`: the `phonk` style, whose MP3 loop region
starts after it, is mastered hotter through `SongSpec.loudness`). Parts may play samples, and a song's score is
edited rather than composed again (below: "Samples, score editing and the mix analysis"). Tests: `audio-dsp*.test.ts`,
`audio-sfx.test.ts`, `audio-music.test.ts`, `audio-phonk.test.ts`.

**Sound-effect engine 3** (1.10; `sfx.ts`, `sfx-design.ts`, `dsp/analyze.ts`, `dsp/space.ts`, `dsp/modal.ts`, `dsp/fx.ts`).
The 23 effects of the first full build were measured (scratch analysis, kept as `dsp/analyze.ts`): every weapon and
explosion was a flat burst (first 10 ms 0 dB over the body, because a voice held at full level for 0.1 s unless told
otherwise), dull at the front, 40 dB down within 130-850 ms with no place around it, mono, its "loops" faded at both
ends, and custom sounds inherited the blip preset's rising pitch. What the engine does about it:
- **A front edge mastering does not flatten.** `shapeTransients` (two energy followers, 1 ms and 22 ms; the sound is
  raised while the fast one leads, brighter too) is `transient` (default 0.5 for impacts, 0.4 for footsteps), applied
  after the soft clip. `master()` takes `clipDb` for those two categories: on the way to the loudness target the lows
  give the highs up to 3 dB (`clipLows`), then `clipTruePeaks` clips against the true-peak envelope, and the limiter
  is left a fraction of a dB (it used to take 6 dB from short hits and hold them down for its release). Targets and
  the -1.5 dBTP ceiling are unchanged. Under a ceiling, front and loudness trade: a short sound cannot have both a
  10 dB transient and -12 LUFS-M, so the critique asks for body, not for a flatter front.
- **Voices**: struck materials (`material`: plate, bar, bell, pipe, wood, glass, membrane as 4-32 modes with their own
  ratios, damping and strike position; takes hit the same object in another spot), `freqCurve` / `levelCurve`,
  `unison` + `detune`, `jitter`, `tremolo*`, `ring`, `filterLfo*`, `sweepTime`, `comb` (a tuned resonator),
  `driveType`, `pan` / `panEnd` / `spread`. `crackle`/`grain` written as "amount, rate" (a layer that never sounded)
  is read as a rate; `lintSfx` reports unknown fields and misread units.
- **The whole sound**: `weight`, `tone`, `space` (`SPACE_MODELS`: early reflections into an 8-line Householder
  feedback delay network, decay per band; `spaceMix` is the energy of the place against the dry sound), `distance`,
  `width` / `stereo` (noise layers rendered twice, the side signal under 150 Hz removed; default mono, since sounds
  played at a position are spatialised by Roblox: **how Roblox plays a stereo file in 3D is not checked in Studio**),
  and `loop: true`: held voices are moved to whole cycles in the loop, noise is crossfaded over the seam, shorter
  voices wrap as events, and the entry carries `looped` + the MP3 loop region (the same unchecked `LoopRegion` path
  as music).
- **Defaults by engine**: sounds made from 1.10 on are stamped `engine: 3` and their voices are hits unless they hold
  (attack 0.001, sustain 0); stored parameters without the stamp keep attack 0.003 / sustain 0.1, so every saved
  sound outside the impact and footstep categories renders sample-identical (a test holds five samples of the 1.9
  render). Custom parameters no longer start from the blip preset.
- **The feedback loop**: `designSfx` (what `AudioService.sfx` saves) returns the takes, the gate and `SfxFeedback`:
  `analyzeSound` (front edge against the body, share above 4 kHz in the first 10 ms, six bands early / body / tail,
  brightness start to end, noisiness per octave, decay, movement, stereo, loop seam against the loop's own movement)
  and `critiqueSound` for the sound's kind (shot, explosion, impact, step, mechanism, ui, tonal, whoosh, riser, loop;
  guessed from the name when not given): the few things a sound designer would change, each with the parameters that
  do it. `audio_sfx` returns it as `analysis {judgedAs, heard, improve, notes, takes, next}`; skill `roblox-audio`
  ("Designing sound effects") holds the anatomy and the recipes, and a test runs its recipes through the critique.
  The reference ranges are first-principles targets, not measured from a library. Tests: `audio-sfx-engine3.test.ts`,
  `audio-sfx-tool.test.ts`.
- **Ambience beds and stingers** (`audio_ambience`, `audio_stinger`; tests `audio-ambience-stinger.test.ts`). A bed is
  the effect engine's loop, up to 60 s for the ambience category: `bedParams` holds every voice that has no length
  of its own for the whole loop, a layer with `scatter: N` becomes N events at random moments (one in each Nth of
  the loop, varied in pitch, level and pan), filters run with the loop's end as their lead-in (`settled`), and the
  critique judges it as a bed (`swellDb`: how far the level travels from second to second; static, short, mono, too
  bright, no events). Saved under `assets/audio/ambience` as a looped `ambience` entry with its loop region. A
  stinger is a 2-6 beat `SongSpec` from `stinger.ts` (win, lose, start, reward) written in the scale and with the
  instruments of a music style (`styleKey`; a win resolves on the scale's bright tonic, the relative major of a
  minor key, a loss on its dark one) and rendered by `renderSong(..., { oneShot: true })`: nothing is folded back
  onto the start, the tail is kept until it is 60 dB down, mastered as a stinger.

**Procuring instead of synthesizing** (`audio/sourcing.ts`, `audio/probe.ts`): a finished song or a realistic recording beats a synthesized one, so `audio_find` searches the Creator Store (Studio's `search_asset`; the licensed libraries are cleared for any game) and Openverse (keyless; Freesound, Jamendo, Wikimedia) together. Openverse is asked for `license_type=commercial` and its answer is filtered again: only cc0, pdm, by and by-sa are kept, never nc or nd (`COMMERCIAL_LICENSES`). Two things about Openverse were measured on 2026-10-01 after the first full build lost its search to an HTTP 403: its firewall answers any query containing "outdoor" with a Cloudflare challenge page whatever the client (`FIREWALL_WORDS`: replaced before asking; after a refusal the last word is dropped, twice at most), and it matches every word of a query, so descriptive queries find nothing (a search with no result is made again with its first three words, then two, and the result says which matched). Anonymous use allows 20 searches a minute and 200 a day (its `x-ratelimit-*` headers); a refused query no longer ends `audio_find`'s other queries. `audio_import` takes an Openverse id, looks the license up again (what is recorded comes from Openverse, not from the agent) and downloads it: https only (every redirect re-checked, no private or local hosts), at most 20 MB and 7 minutes, a stall limit instead of a short timeout, and the bytes decide the format (`probeAudio` reads mp3 frames, Ogg Vorbis, WAV and FLAC headers, so a web page or Opus never gets in). The file is saved as it came under `assets/audio/imported`, the entry (`source: 'imported'`) carries `credit` (title, creator, license, source page, a ready credit line), and `SoundLibrary` keeps `audio/CREDITS.md` in step with the imported sounds on every save and remove. Then it goes the way generated audio does: a draft from the dock, uploaded and built into `ShurikenAudio` when added. A bare `url` is accepted only with a stated license, title, creator and source page. The Audio page shows the license on the sound. Tests: `audio-sourcing.test.ts` (fake fetch, no network).

**Samples, score editing and the mix analysis** (1.14; the Music & sound copilot's own list of what would make it
better at drift phonk: real samples first, then editing a song instead of re-rolling its seed, effects, an
analysis to listen through, arrangement control).
- **Decoding** (`audio/decode.ts`, `mp3-decode.ts`, `flac-decode.ts`, `mp3-tables.ts`): WAV (PCM and float), AIFF/AIFC,
  FLAC and MP3 (MPEG-1/2/2.5 Layer III: bit reservoir, mid/side stereo, short blocks, a LAME/Xing tag's delay and
  padding trimmed; intensity stereo and mixed blocks are implemented but untested: no encoder at hand writes them)
  in plain TypeScript, no new dependency; then a Kaiser-sinc resampler
  to 44.1 kHz. The MP3 tables (Huffman codes, scale-factor bands, the synthesis window) are the standard's numbers,
  read once out of the lamejs encoder the app ships and checked (complete prefix codes; the window symmetric, in
  multiples of 1/65536). Ogg Vorbis/Opus are refused with a reason (Freesound's previews are MP3). Tests encode
  with lamejs and rewrite its streams into mid/side, the reservoir and a LAME tag (`audio-decode.test.ts`).
- **The sample library** (`audio/sample-library.ts`, `sample-analysis.ts`): web samples in the app data folder
  `samples/web` (`<id>.wav` + `<id>.sample.json` with title, creator, license, page, Openverse id), the user's own
  files in `samples/My samples` (ids `my-…`) or a project's `assets/audio/samples` (ids `proj-…`), prepared on first
  use into `samples/.prepared` / `<project>/.shuriken/samples` and again when the file changes, and built-ins
  (`tr808-cowbell/clap/hat/openhat/kick/snare/rim`, `vinyl-crackle`, `tape-hiss`: synthesized, the fallback).
  **License rule: web samples are CC0 or public-domain only** (`SAMPLE_LICENSES`), stricter than whole imported
  tracks (CC BY / BY-SA are allowed there with a credit), because a sample becomes part of a new song that is
  uploaded, and a credit or share-alike would follow every song made with it. `audio_sample_add` looks the license
  up again on Openverse, never takes it from the agent. Preparing: cut (start/end), 44.1 kHz, mono when both
  channels are the same, DC off, silence trimmed (not from loops: their length is their tempo), peak -1 dBFS; then
  the pitch of a one-shot (YIN in the role's range with what is under it filtered out; cowbells and bells by
  their lowest strong partial), a loop's tempo and beats (a tempo in the name wins, else onset self-similarity at
  a whole number of beats), a named key, loudness (LUFS-M max for one-shots, LUFS-I for beds) and where the energy
  is. A song that plays a sample gets a copy in its project, and its sound entry lists the samples
  (`SoundEntry.samples`, also in `audio/CREDITS.md`).
- **Playing them** (`audio/sampler.ts`, `music.ts`): a track with `sample` plays it instead of its voice, matched to
  that voice's loudness (`voiceLoudness`: one note of the voice at velocity 0.8, measured once) and keeping its mix
  defaults. One-shots are pitched by the notes against their root (Hermite interpolation) and gated with a release
  unless they are drum hits; loops are fitted to the song's tempo (WSOLA time-stretch, three copies so the seam is
  smooth) and key, and played from beat `o` for as long as a note lasts; textures are made seamless once.
  Sample-only instruments: `sample`, `vocal`, `texture`; new voices `riser` and `impact`.
- **Effects and arrangement**: per track `crush`, `slide` (the 808's glide length), `mute`, `auto` (low-pass,
  high-pass and gain curves in beats, also on the whole mix), song-level `delayTime`, `duckRelease`, and `tape`
  (wow and flutter with whole cycles in the loop, hiss, crackle, warmth, all seamless). Composers now name their
  parts and record `style`, `key` and `chords` (one voicing per bar); the render seed is saved in the score.
- **Editing** (`audio/score-edit.ts`, `audio_score`, `audio_music_edit`): a strict list of operations (set, clear,
  thin, notes with a repeated pattern, transpose, velocity, add from the chords or a rhythm, remove, copy, insert,
  delete, sections, song, riser, impact; bars count from 1, a section by name), rendered with the same seed so the
  untouched parts are sample-identical. A draft is edited in place; a game song edited from the dock becomes a new
  draft; the team's edits replace the song and drop its old asset id. Note order is kept (a voice's random detail
  follows a note's place in its track).
- **Listening** (`audio/music-analysis.ts`): `renderSong(..., {onReport})` measures each part and the master per beat
  in three bands with filters: shares of energy and of what is heard above 150 Hz, low-end clashes between parts
  loud at once (a kick on its bass excluded), section loudness and bands, the pump of the held parts the kick ducks.
  `audio_music` / `audio_music_edit` return `analysis {heard, sections, improve, next}`; thresholds are set so the
  styles' own songs come out clean except where a change would help. Tests: `audio-samples.test.ts`,
  `audio-score-edit.test.ts`, `audio-music-analysis.test.ts`, `audio-sample-tools.test.ts` (fake Openverse and
  download through the core: `CoreOptions.webFetch`).
- **UI**: RPCs `audio.samples` (the list, as `audio_samples`), `audio.sampleFile` (a sample's WAV as a data URL, to
  play it), `audio.score` and `audio.edit` are there for the Audio page; the page itself does not use them yet.

Sounds made in the Audio dock — by the user on the page or by its copilot — are **drafts** (1.8.1,
`draft: true` in the entry): kept in `audio/` to listen to, but not built into the place
(`SoundLibrary.inGame()` feeds `world/Audio.luau`) and not uploaded, until "Add to game" / `audio_use`
(which can also replace a game sound with a better take: `as`). A draft never takes a game sound's name
(`freeName`: Jump → Jump2). The team's sounds go straight in. "In game" means the game's code plays it:
`SoundLibrary.usage()` scans the synced scripts for an audio/sound/sfx/music call with the name, the name in
a script that requires ShurikenAudio, or the asset id; the dashboard and the Audio page show each sound as
draft, in game (with the scripts), unused (in the library, nothing plays it) or not uploaded. Both play
through one player (`renderer/lib/sound-player.ts`, one sound at a time): a click plays a sound and a
second click stops it, the arrow keys move through the list and play (Space plays/stops; never while
typing), and nothing starts on its own. The page keeps the list, the selected sound and the copilot (open
unless closed); numbers, code and Remove are under Details, preset/style drafts under "Make one yourself".

The UI workshop is the one that reads rather than writes. `core/roblox/ui-capture.ts` serializes every
ScreenGui under StarterGui (Edit), or — when scripts build the UI as a player joins, as the HUD kit
does — the playing client's PlayerGui during a short playtest (`core/ui/ui-workshop.ts: captureUi`,
under the play-mode lease; Roblox's own Freecam/TouchGui/chat/prompt screens left out). It reads page by
page (`readUi`, `uiCapturePageLuau`: depth-first nodes with their parent's id, 80,000 characters a page,
halved when Studio still cuts one, read again when the UI changed between pages): in one piece, any UI over
about 300 elements came back cut off at Studio's ~100,000-character limit, the JSON didn't parse, and
`ui_audit` said "The playing client didn't answer" (9 times in one build, once the garage menu existed). A read
that keeps failing now reports its last reason.
`@shared/ui-layout.ts` lays it out the way Roblox does (UDim2 + AnchorPoint, the 58-point top bar
inset and ScreenInsets, UIPadding, UIListLayout with flex — HorizontalFlex/VerticalFlex, Wraps,
ItemLineAlignment, UIFlexItem — UIGridLayout, UIPageLayout, aspect/size/text-size constraints, UIScale,
AutomaticSize, ScrollingFrame canvases, ClipsDescendants, Sibling/Global ZIndex, TextScaled) on a phone
(844×390, notch insets), tablet, laptop and desktop. Rules measured in Studio 0.740/0.741 (pinned in
`tests/ui-layout.test.ts`, "measured in Studio"): a ScreenGui's UIScale multiplies every offset below it
while scale sizes still take fractions of the real screen; size constraints count before UIScale; a
GuiObject's own UIScale scales it about its AnchorPoint; AutomaticSize includes UIPadding and is sized
before a list places the item; flex Fill/Grow/Custom share the free space by ratio, Shrink takes the
overflow; SpaceBetween/Around/Evenly share what the items leave (the list's Padding doesn't count);
Wraps breaks lines with Padding between them; Stretch makes items as thick as the line's thickest; a
UIPageLayout shows one page (the others are checked "when shown"). A UIScale that a script fits to the
screen declares its rule in `FitReference` (Vector2) / `FitRange` (NumberRange) attributes (both kits
do) and is refitted per device; without them the audit warns that Studio's window value was used
everywhere. Text widths are estimated from character shapes fitted to BuilderSans TextBounds (the
renderer measures real fonts). `tests/e2e/ui-kit.e2e.ts` builds the roblox-ui-design shop in a scratch
place and matches every element's AbsolutePosition/Size within 2 px. The same layout draws the UI page and
dashboard tile (`components/ui/ui-canvas.tsx`, CSS; text measured in the fonts drawn) and drives
`auditUi`: things off the screen, buttons too small to tap or covering each other, top-level pieces
running into each other, text too small, cut off (TextTruncate: its end not showing) or low in contrast,
small content drawn under a button (a skinned button by its art's reach, `UiNode.skinned`), content spilling
past the bottom or right of the panel it sits in, a ScrollingFrame grown by AutomaticSize (it never scrolls), buttons
under Roblox's top-bar buttons — a button over half the screen is a modal's backdrop, not a target;
something off every device's screen is "parked" for a slide-in (a warning), not misplaced —
screens a script enables later, hidden menus and other pages are checked as if shown, each on its own
("when shown"). Images come from Roblox's thumbnails API as data: URLs (the page's CSP allows no
remote images). The UI designer runs `ui_audit` before finishing, the critic uses it on UI work, and
the director sees the screens and audit counts and can link to the page.
UI icons (1.13, `ui_icon`, `core/ui/ui-icons.ts`, `@shared/icon`): the art in shop cards, counters, tabs and rail
buttons is drawn from the game's own models. The app's render page draws a model alone on a transparent
background (`ModelView` with `bare`: no floor grid, a room environment so metals reflect, a brighter exposure),
crops to what was drawn (`alphaBounds`), fits it into a 512 px square (`iconFit`) and stamps a dark outline
around its silhouette; a PNG. The tool saves it under `ui/icons` (`icons.json` lists them), uploads it as a
Decal through Open Cloud, reads the decal's image id in Studio, and writes the generated module
`<shared>/UiIcons.luau` (`Icons.Coin = "rbxassetid://…"`, `""` until the upload is known), synced by itself.
A copilot's draft turn saves pictures only. The UI designer's prompt and skill `roblox-ui-references` ("The
bar") say where icons belong; the planner plans the models the UI needs and a small icon task after them.
`ui_icon` also makes, without Studio or the app (2026-10-02): line-art glyphs (`core/ui/ui-glyphs.ts`: Lucide's
set, ISC, bundled as `resources/ui-glyphs/lucide.json` with its licence; `search` by name, alias and a table of
game words; drawn by the core as white lines to tint, with an optional outline or glow) and the images of a
mockup element's panel shape (`core/ui/ui-shapes.ts`: a white fill and an outline per stroke, two pixels per
point, 9-sliced; listed with their slices in the generated `<shared>/UiShapes.luau`, built by the Ui kit's
`Ui.shape`). Why images: Roblox has no shape property, Path2D draws lines only, and clipped rotated frames can't
carry a translucent gradient fill. Entries carry `kind` (model, glyph,
shape); a mockup shows an icon as `"icon:<Name>"` and a glyph as `"glyph:<name>"` (the board gets both from
`ui.images`, drawn by the core).
The audit's device matrix (`auditDevices`): a landscape phone, a tablet, a desktop and a TV (1920×1080 with
`tenFoot`: a UIScale that declares `FitTenFoot` fits that much bigger, and screens that declare it are warned
about text and buttons in the outer 5% a TV may crop), plus an upright phone (390×844, 47-pt status bar and
34-pt home bar) when the capture's `ScreenOrientation` is Portrait or Sensor; snapshots record `audited`. UI
the game builds animates through the Motion module (skill roblox-ui-motion, which the Ui and Hud kits
require): its looping animations set a `MotionLoops` attribute on their element, so the audit warns about
loops still running under a disabled screen or a hidden frame (`tests/e2e/ui-motion.e2e.ts` checks Motion and
the showpiece screens of skill roblox-ui-showpieces in a playtest).

**UI mockups** (1.9.1; `@shared/ui-mockup.ts`, `core/ui/ui-mockups.ts`, `capabilities/ui-mockup-tools.ts`). A
mockup is a design tried in Shuriken, not in the game: ScreenGuis written in the layout engine's own node terms
(colours may be hex or theme tokens, `kit: "ui" | "hud"` gives a screen Ui.screen's or Hud.screen's UIScale fit
and insets), so it is drawn and audited exactly as the game's UI is, and the kits can build the same screen. A
screen may have a layout per device form (`forms`: phone, phonePortrait, tablet, desktop, tv — the forms
`Ui.onDevice`/`Hud.onDevice` build; `formOf` applies the kits' breakpoints; an upright phone falls back to the
phone's layout, a TV to the desktop's), as its own children or as changes by path. Versions A, B, C… are only
added: a revision is a version made `from` an earlier one (or from the game's UI as last read, `"game:HUD"`)
with `set` changes by path. `motion` names the Motion module's moves; the UI page plays open, close, enter,
pulse, float, spin, shimmer, punch, shake, count and transition with CSS animations on the drawn elements (Reduce
Motion too) and says which it can't (swap, fly, flipbook, keyframes). `auditVersion` runs `auditUi` per device
(devices that share a layout together); `compareWithGame` matches the game's UI as last read against a version,
element by element by path (within 4 points), after it is built. The UI page has two views, In the game and
Mockups (`pages/ui-mockups.tsx`: the versions as tabs, the devices side by side at their true shapes —
`lib/mockup-board.ts` picks rows, or a column for the upright phone — or one big, element selection, findings,
Pick this one, Put it in the game); the dashboard's UI container shows the newest mockup and lists them.

After the UI builder's review of 2026-10-02 (it couldn't see its mockups, guessed field names from a description cut at the MCP
client's 2,048 characters, and saw a form layout in a format the tool ignored "silently do nothing"):
- *The format is strict and whole.* `MOCK_FORMAT` (`@shared/ui-mockup.ts`) is the entire format in under 1,900
  characters, carried in `ui_mockup_create`'s description (a test holds every description of the UI tools under
  2,048 and every property the checker knows in the format) and repeated with every refusal; `ui_mockup_list
  {format: true}` adds how the pieces behave (`MOCK_GUIDE`). `checkVersion` refuses what Roblox would ignore or
  refuse: unknown or misplaced fields (with where they belong: `dir` → "inside list or grid", `BackgroundTransparency`
  → `bgT`), text or image properties on classes that don't draw them, screen properties below the screen,
  transparencies outside 0-1, gradient keys not running from 0 to 1, states changing layout, moves on paths no
  layout has, unknown icons and glyphs (with close names), and every form layout's `set` (paths start below the
  screen and must land; they used to be applied with their errors dropped). Version input fields are checked the
  same way (`forms` on a version says it belongs on a screen). Tools may be `strict` (`ToolDefinition.strict`:
  the registry and the MCP server refuse arguments a tool doesn't name instead of dropping them).
- *Richer pieces, all buildable*: several strokes by ZIndex with a
  position (Outer by default, Inner, Center) and their own gradient, text outlines, UIGradient types and
  transparency-only fades, UIShadow (`shadow`; offset 0 is a glow), per-corner radii (`corners`), panel shapes
  (`shape {cut, slant}`, `shapePolygon` in `@shared/ui-layout.ts`), badges (`badge`: a child "Badge", `badgeNode`),
  `states` (hover, press, selected, disabled: property changes and a UIScale; `withState`) and `appear`
  (`motionOf` turns it into Motion.enter). The Ui kit (skill roblox-ui-design, Kit v4, "Building a mockup" with a
  worked example) builds each: `Ui.gradient`, `Ui.stroke`, `Ui.glow`, `Ui.badge`, `Ui.shape`, `Ui.react`.
- *Pictures.* `core/ui/ui-render.ts` draws a version on a device in software (`core/ui/ui-raster.ts`: exact
  anti-aliased coverage by signed-area accumulation, strokes as bands round an outline, blurred masks for
  shadows), laid out by `layoutScreen` with the audit's text estimate: everything above, rotation inherited by
  children, ClipsDescendants, images (cached thumbnails, project icons, glyphs; Fit, Crop, 9-slice), text in a
  stand-in system font (`core/ui/ui-fonts.ts` reads TrueType outlines from Windows' Fonts folder, picked like the
  page's CSS stand-ins; blocks where there are none), rich text (bold, colour, strike, underline, stroke),
  Roblox's top bar, the notch, a TV's safe area, rulers in points and a caption. `ui_mockup_create`/`_update`
  return a picture of each new or fixed version (phone and desktop for one or two versions, the phone for more);
  `ui_mockup_render` draws any device, one element big (`focus`), every element in its states side by side, hidden
  elements shown, and a bright or the game's backdrop. Tests check pixels at known places (`tests/ui-render.test.ts`).
- *Versions are fixed in place and retired.* `revise` keeps a version's letter and counts its revision (`rev`,
  shown as C·2; the last five earlier revisions in `history`); `retire`/`restore` (also the page's Retire button,
  RPC `ui.mockup.retire`) hide superseded versions, never the user's pick, what is in the game or the last one;
  `check: true` checks and draws without saving. A fix to the version in the game says it must be built again
  (`applied.rev`).
- *A reference.* `ui_reference` reads a picture the user attached (`core/ui/ui-reference.ts`): its main colours and
  the small loud accents, a theme to start from, the Enum.Font families by look, and with a mockup that version
  drawn on the device nearest the picture's shape beside it, with where they differ (colours it lacks, lighter or
  darker, greyer or louder, busier, region by region).
- *The board answers the pointer.* `UiCanvas` draws the same pieces with CSS and SVG (shapes), and elements with
  states hover, press (held) and show selected when picked, scaling about their anchor with a spring ease.

**UI Lab** (1.15.10 prototype; `core/ui/lab/`, `capabilities/ui-lab-tools.ts`). A mockup version or the game's UI as last read, checked as Roblox shows it on
14 real devices with no Studio call (`labCheck`, about 1–20 s). The parts:
- *Roblox's own fonts* (`roblox-fonts.ts`, `cff.ts`): the font files in the Studio install (`content/fonts`,
  families JSON; TrueType and CFF outlines, GPOS/kern kerning, fallbacks), mapped from Enum.Font and FontFace names.
  Measured in Studio: Roblox fits a face's hhea ascender−descender to TextSize (not its em), each glyph advance plus
  kerning moves a whole-pixel pen (`floor(pen + step + 0.9)`), TextBounds.Y = lines × TextSize, the baseline is the
  ascender down from the line's top, Legacy is drawn 1.5×. `robloxMeasure` replaces the estimate in layout, audit
  and pictures (`lab-text.ts`: `robloxFontPicker`, `LAB_KIT`); the renderer takes `fonts`, `measure`, `baseline`,
  `overlay` options and any screen size (`RenderScreen`).
- *Devices and Roblox's own UI* (`devices.ts`, `core-overlays.ts`): `LAB_DEVICES` (phones with their real safe
  areas, portrait phones when allowed, tablets, laptop, 1080p/1440p, a console TV with its 87-pt top bar) and the
  touch jump button, dynamic thumbstick (area and resting ring), top bar (menu button, unibar), hotbar, player list
  and chat placed by the formulas in Studio's own scripts (`ExtraContent/scripts`; every cited line re-checked by
  `checkCoreScripts`; the player list and chat sizes are estimates, warnings only). `overlayFindings` reports game UI
  under them; `coreGuiFromSource` reads what a game turns off.
- *Interaction and stress* (`interact.ts`, `stress.ts`): gamepad focus graphs (overrides, groups, a directional search
  approximating the engine's; its odd jumps and one-way moves are notes until calibrated), touch targets in mm by the
  device's ppi, thumb reach, and longer text, bigger numbers, longer names, other list lengths (translations are
  notes: they matter to games that localize).
- *Motion and feel* (`motion-sim.ts`, `feel.ts`, `filmstrip.ts`, `motion-luau.ts`): TweenService easings and the
  Motion module's math ported 1:1, a timeline sampled per frame, filmstrips and onion skins agents can look at, 20
  feel rules with sources; `luauFeel` reads a game's own tweens.
- *Design critic* (`critique.ts`): legibility by rendered pixels over a bright and a dark scene (the phone only;
  text failing only over a bright scene is a warning), spacing grid, alignment, type scale, colour, hierarchy,
  consistency, HUD density; a 0–100 score from defects (~3 in 4 findings real when checked by eye, so only
  unreadable text is a problem). Each Lab phone is judged on its own size, safe area and points per inch (the
  pixels on the smallest), and a form's score is its worst phone's (`CritiqueOptions.screens`).
- *Phone checks* (`phone.ts`), tuned on the designs blind judges marked down on phones (`tests/fixtures/ui-judged`):
  labels the phone layout drops while what they name stays (a menu's item names, a caption over its controls),
  lists showing under 3 whole items on the iPhone SE, frames reaching past the safe area; the audit warns words
  under 13 pt on a phone. `ui_lab_check` draws the SE and the notch phone big first.
- *Exact build* (`ui-luau.ts`): the nodes as JSON read by a fixed Luau interpreter (ShurikenUi) — the capture
  inverted, so the audited design is what ships (`ui_lab_build`); states and fitted UIScales play by themselves
  (a state's colours, scale, art, label, strokes, gradient and shadow; the normal look puts the element's own back).
  Panel shapes (cut corners, leaning sides), which Roblox has no property for, are worn as forged art (`forge/shaped.ts`:
  the fill, UIGradient and outlines on the cut outline, a "custom:shape-…" skin in the atlases; measured in Studio: the
  cuts and slants show as designed). TextSize stops at 100 in Roblox, and the layout engine lays text out at that cap.
  Measured while building it: TextWrapped set false after TextScaled turns TextScaled off (set TextWrapped first);
  UIGradient.Type's enum is Enum.GradientType (Linear, Radial, Conical, Elliptical) and Studio draws the non-linear
  ones as linear (the Lab warns).
- *Proof* (`calibration.ts`, `fidelity.ts`, `tests/e2e/ui-lab-fidelity.e2e.ts`, `tests/e2e/ui-lab-verify.e2e.ts`):
  calibration screens and real screens built in a throwaway Studio, their boxes, TextBounds and screenshots against
  the Lab's, saved for offline re-runs. `layoutScreen` now lets ScreenInsets decide over IgnoreGuiInset
  (DeviceSafeInsets keeps a screen out of the notch), and `auditUi` takes any screen (`AuditScreen`) and an exact-text
  mode.
Tools: `ui_lab_check`, `ui_lab_view`, `ui_lab_motion` (the UI copilot's design turns, the UI designer, the critic),
`ui_lab_build` (put-it-in-the-game turns). `ui_lab_review` (`capabilities/ui-lab-review-tool.ts`; the UI copilot's design
turns and the UI designer) is a second opinion for what the rules pass and blind judges still saw on phones: the fast
model (role `ui-phone-reviewer`, output `phone_review`: a verdict and at most 8 findings by phone) looks at the version
on the small and notch phones at 2 px per point with Roblox's touch controls, the desktop beside them as a reference;
one run per version's content per session, and without a model it says so ("rely on ui_lab_check").

**UI Forge** (1.15.10; `core/ui/forge/`, `capabilities/ui-forge-tools.ts`).
Game UI art drawn the way a UI artist layers it in an art tool, with no model call and no upload until the game needs it:
- *Engine* (`canvas.ts`, `shapes.ts`, `style.ts`, `forge.ts`, `textures.ts`): premultiplied float canvases, exact
  Euclidean signed distance fields, running-sum blurs, noise; shapes (rounded and cut boxes, pills, shields, hexes,
  bursts, ribbons, tabs, bubbles, gems, frames, stars, hearts, leaves, rings, drips, torn edges…, Lucide glyphs —
  solid or line — and text in Roblox's own fonts; lengths in design points); layer styles in an artist's order (drop
  shadow, outer glow, 3D base, outside strokes, fill, 18 procedural textures with colour ramps and relief, ~25
  patterns, grain, overlays, inner shadow and glow, rim light, bevel with specular, gloss band/spot/glass, sheen,
  wear, sparkles, inside strokes); pixel art (`ForgeSpec.pixel`). Each layer is drawn only over its own region. `forge({size, layers})` returns 2× art with its margin (shadows and glows outside the
  box), a computed 9-slice centre, and where content sits (a pressed face is lower). Images stay within 1024 px a
  side (measured: Studio shrinks bigger ones and a 9-slice then loses its right and bottom edges).
- *Art directions* (`directions.ts` registry, `kit.ts` contract, `looks/<id>.ts`): 14 — candy, ember, neon,
  parchment, frost, toybox, grunge, aqua, forest, royal, pixel, kawaii, tactical, motorsport (arcade racing: carbon
  under smoked glass, slanted candy-paint buttons, chrome gauges, slanted speed meters, italic chrome titles; its
  templates show a racing garage) — each a palette, Roblox fonts, text
  inks per surface (`inkFor`; every button label ≥ 4.5:1 on its face, tested), a backdrop and a recipe per element
  kind (window, header, button, tab, card, slot, badge, ribbon, bars, pill, icon frame, close, title, divider,
  tooltip, icon, coin) in variants (roles, rarities) and states (hover, pressed, disabled, selected; `withState`
  gives every direction generic ones). Kinds that resize (bars, dividers, pills, headers, ribbons) keep their middles
  uniform along the stretch. `fx.ts`: light for any direction ("fx:glow|rays|halo|sparkles|shine|vignette|spotlight
  #rrggbb") — round glows as images, since Roblox draws radial UIGradients as linear.
- *Props* (`props/`): 120 game objects drawn as filled, shaded art (eggs, chests, potions, gems, coins, cash, keys,
  crowns, trophies, scrolls, gifts, swords, shields, food, paws, rockets, bombs, ×2 boosts; guns, a grenade and a
  launcher; pets and mounts — cat, dog, bunny, wolf, slime, horse, unicorn, dragon, phoenix; vehicles side on —
  sports-car, race-car, kart, truck, motorbike, boat, plane, helicopter (`vehicles.ts`, `wide`: in an element wider
  than tall the art's own bounds fill it, so a garage card's car spans the card); the diner — burger, fries, soda,
  donut, chef-hat (`diner.ts`); survival gear — flashlight, battery, key-card, bandage, syringe, crowbar, torn-note,
  medkit (`gear.ts`)), with designs for the
  common ones (`variants.ts`: egg-1…6 and themed eggs such as dragon-egg and galaxy-egg, potion-1…4, chest-1…3,
  sword-1…4, gem cuts and ruby/emerald/sapphire/diamond/topaz, each in its own colours when no variant is asked
  for) — recipes of parts in a
  100-unit frame (`geo.ts`), each part a shape, a material (gloss, metal, gem, glass, liquid, wood, paper, matte,
  glow, shine/shade decals) and a tone; `kit.ts` builds them in a direction's way (`looks.ts`: outline inks and
  widths, base, gloss, bevel, textures, glow, palette shift; neon as holograms, pixel as sprites at ≥ 44 pt): the
  silhouette parts traced into one outline layer (`silhouette.ts`: marching squares over one raster; rings and
  holed unions part by part), then the faces. Variants tint the object (rarity: common grey → mythic magenta with
  a holographic shimmer and glints; roles; the accent); food keeps its colour and glows. `directions.ts` wraps every
  direction with `withProps`: an icon whose glyph names a prop (its own name, an alias in `names.ts`, a plural, or a
  catalogue game word whose glyph is a prop's — "pet-egg", "loot-crate", "heal") and a coin whose glyph names a
  currency prop (gem, cash, coins, money-bag, ticket) draw the prop; other glyphs keep the direction's sticker.
- *GPU* (`renderer/src/lib/forge-gl/`, plan in `@shared/forge-plan`): a WebGL2 port of the engine, pixel-identical
  to the CPU (parity script `scripts/forge-gl-parity/`, mean 0.001/255 over 499 elements), 13–65× faster; the core
  plans (layout, contours), the GPU draws. `setForgeBatch` registers it with the core and `warmSkins` forges a screen
  set's missing art in two batches before the synchronous wear; the CPU forges whatever the GPU can't.
- *Skins* (`spec.ts`, `resolve.ts`, `skins.ts`): a design asks for art with one string on any element,
  `skin: "<direction>:<kind>[:<variant>[:<state>]]"` (icons `:<glyph>`, titles `:<TEXT>`, `#rrggbb` accents; game
  words like "rebirth" resolve through `resources/ui-glyphs/game-icons.json`). `SkinForge` forges at the element's size
  on demand, cached in memory and in `<project>/.shuriken/ui/skin-cache` (keyed by `FORGE_VERSION`). Wearing a skin
  (`applySkins`) adds a child ImageLabel "Skin" under the content, grown by the margin — Stretched when the element is
  drawn at the size the art was forged at (offsets, a grid cell, uniform UIScale), else 9-sliced at SliceScale
  1/scale with art re-forged around a ~2-pt centre (measured: Roblox crops a 9-slice centre rather than shrink
  it); the art covers the element's whole box through its UIPadding (Roblox pads every child), the element's fill
  turns off and its text moves into a child "Label" in the direction's ink where the design leaves it unset. A state
  may wear other art (`states: {press: {skin: "…:pressed"}}`): the state patch carries `skinArt` (the Skin child's
  image, slice, rect and reach) and `label` (the Label's box — a pressed face is lower —, text colour and outline),
  applied by `withState`, the renderer and the builder alike; `state: "selected" | "disabled"` is the state an
  element starts in. Skin children are `decor`: layout, overlap and stress checks look past them (their glow
  reaches outside the box) and the critic counts them as the element's fill. An element that lays out its children
  (list, grid, pages) gets its art and text in a Folder "Art" — measured: a Folder's GUI objects draw in the nearest
  GUI ancestor's padded area and stay out of its layout; the layout engine, critic and builder skip folders in paths.
- *Reskin* (`reskin.ts`): a mockup version `{from: "game:Shop", reskin: {direction}}` reads each element for what it
  is (windows, headers, titles, buttons by colour role, tab rows, close buttons, cards by rarity, bars, pills, slots)
  and dresses it with state art, clearing what the art replaces and inking the labels on it; `set` fixes the rest.
- *Screens that own the screen*: a ScreenGui's `hides` ("chat playerList backpack touch") — the builder turns
  Roblox's own UI off while it is open and back on after; the Lab stops drawing and flagging those regions.
- *Critic*: labels under 20 pt in a display face (Michroma, Jura, novelty and pixel faces) are flagged.
- *Everywhere the Lab looks*: mockup pictures, states sheets, `labView`, `labMotion` and `labCheck` wear skins
  (`wornSubject`); the design critic judges text over the real art. `ui_reference` ranks directions by a reference
  picture's colours (`match.ts`, OKLab).
- *Into the game* (`publish.ts`, `ui_lab_build`): the art is shelf-packed into atlases of at most 1024 px
  (`ui/skins/atlas-<hash>.png`, edges extruded; atlases.json keeps upload ids — the same pixels are the same upload)
  and every skin becomes a sprite (`rect`: ImageRectOffset/Size; measured: SliceCenter is relative to the rect), one
  decal upload per atlas when uploads are on (image ids read in Studio), else `rbxasset://shuriken-forge/<atlas>`
  with the PNG copied into the local Studio content folder — Studio shows it, players never do (the tool says so).
  The builder swaps a state's art, rect, text box and outline (`showArt`, `showLabel`) and starts each element in
  its `state`.
- *Proof* (`tests/e2e/ui-forge-studio.e2e.ts`): forged screens built in a throwaway Studio from the content folder,
  photographed and compared with the Lab (`compareVerify` resolves the images): boxes 100% within 2 pt, pixels
  1.1–2.1% off, state swaps (selected tab, pressed, disabled) identical; four whole template screens 544 elements
  100% within 2 pt, 0.9–4.5% of pixels off; the atlas build path 0.8% off; a coordinate-gradient image read back
  point by point measured the 9-slice centre crop and ImageRect slicing, now modelled in the renderer (`sliced`,
  `cropImage`; 0.2–0.3% off).
- *Screen templates* (`templates/`): `TEMPLATES[id].build({direction, accent, content})` returns whole screens in
  the mockup format (a layout per device form), their motion and notes for the builder — 17, among them shop,
  inventory, collection, combat and simulator HUDs, daily rewards, battle pass, round end, quest log, leaderboard,
  profile, codes, settings, title, dialogue, toasts and confirm. A mockup version may start from one
  (`{note, template: {id, direction, accent, content}}`, then `set`). `genres.ts` reads
  `resources/ui-glyphs/genres.json` (Roblox genres → a direction, an accent, currencies, items with rarities and icons,
  tabs, the screens such a game has): `template: {id, genre}` starts a version as that genre's game.
- *The Forge view* (UI page → Forge; `renderer/src/pages/forge/`, RPCs in `forge/forge-rpc.ts`, types in
  `@shared/ui-forge`): the directions as live cards, a genre picker (`forge.genres`: picking one sets its look and
  accent, and the templates are filled with its currencies, items and tabs), an accent picker, every element (click copies its spec), each
  template in the chosen look on phone, tablet, desktop or TV with Roblox's controls and the game's backdrop, "Make a
  mockup" (or add the look as another version) and "Ask the designer" (the pick and picture to the UI copilot).
  With the game's UI read, "Your game's UI" previews it dressed in the look and "Dress my game's UI in <Look>" makes
  a mockup of it reskinned (`forge.game`, `forge.dress`).
  Pictures are drawn in worker threads (`forge-worker.ts`, electron-vite `?nodeWorker`; the core's own thread when
  workers can't start), cached in memory and in `<dataDir>/cache/forge` keyed by the screens, a fingerprint of the
  look's recipes, the device and `PREVIEW_VERSION` (bump it when the renderer changes).
Tool: `ui_forge` (directions, a direction's sheet, one element and its spec, custom recipes as `custom:<name>`,
templates).

Custom rigs in motion (`core/animation/rig-motion.ts`): a rigged model's geometry (mesh vertices per
segment), forward kinematics identical to its Motor6Ds (`@shared/rig`), IK for legs and chains (coordinate
descent with knee-distance matching; flat feet plant the ankle and stay level), `checkRigClip` (ground,
planted-foot sliding, air time, limits, hinge axes, loop seams, attachments and reach at markers) and
procedural templates — walk/run for any number of legs, slither, idle, lunge, sting, slam or stomp, hit,
death. They are templates: custom, context-heavy animation is authored in Kiln, and Shuriken imports and
implements it. The Animation page and filmstrips play rig clips on the rigged model itself (`RigPlayer`
on the Models page's view).

Facts measured in Studio that the code depends on (keep them when changing it):
- Pose CFrames apply like `CFrame.Angles(x, y, z)` per joint on the default R15 rig facing −Z; the
  shared forward kinematics (`solveRig`) reproduces rig part positions to ±0.05 studs, and
  `groundClip` uses it to keep feet out of the floor (bends legs; locomotion moves the hips).
- Legacy `PoseEasingStyle.Cubic` runs In/Out backwards (Cubic In starts fast); `CubicV2`, Elastic and
  Bounce match TweenService, so clips say "Cubic" and export CubicV2. `Constant` jumps to the next
  key's pose at the start of the segment.
- Rotations between keys go the shorter way round, but not the same way for every style: **Linear**
  poses blend the quaternions linearly and renormalize (nlerp — 0→150° reads 33.0° at a quarter, not
  37.5°), **eased** poses (CubicV2, Elastic, Bounce) turn at a constant rate on the eased progress
  (slerp). `sampleClip` does the same, so previews match Studio to about 0.03 studs (≈0.1 on a few
  multi-axis shoulder in-betweens) — tests pin the measured values. Keys under 180° apart can chain
  past ±180° (the roll keys the root at −30 … −360).
- R15 rigs (player characters and `CreateHumanoidModelFromDescription`) join parts with
  `AnimationConstraint`s (kinematic, MaxTorque 3000) and carry 14 limited `BallSocketConstraint`s — no
  Motor6Ds. Animations drive them the same way (`.Transform`); ragdolls disable the animation joints
  (skill `roblox-ragdoll-knockback`, checked in a playtest). R6 characters can't play the R15 clips
  (the runtime warns).
- While ragdolled, every limb is its own assembly (only the root and lower torso stay one): a velocity
  on the root alone moved a body 4 studs, the same on every part 28–29 (45 studs/s + 25 up). A
  standing Humanoid cancels a velocity set once (1 stud); a `LinearVelocity` on the root for 0.2 s
  pushes it 14–17 studs upright. Same for NPCs and players (whose own client must apply it).
- Runtime: `RenderStepped`/`BindToRenderStep` don't run while Studio's window isn't being drawn (display
  asleep, or the window minimized — its viewport shrinks to 1×1), so camera effects can only be checked
  with the window drawn; the server→client relay can be checked any time. Screenshots and game input
  need it too: `RobloxStudioAdapter.ensureVisible` restores a minimized bound window *behind* the
  user's windows without activating it (`studio-window.ts`), which is enough for Studio to render.
- Custom rigs (`rig_build`): a segment part per joint at its pivot, Motor6D `C0` = the pivot in the
  parent segment's (axis-aligned) frame, `C1` = identity, the root joint under the HumanoidRootPart; a
  KeyframeSequence whose Poses nest along the rig's joints then moves every segment exactly as
  `@shared/rig`'s `forwardKinematics` says: an 8-legged rig's stinger, bite point, leg tip and mandible
  tip landed within 0.01 studs of the offline positions for a clip turning and moving the root, a tail
  chain, a hip ball, a knee hinge and a mandible (2026-09-29, scratch place). So `checkRigClip`, the
  filmstrips and the Animation page show what Studio plays.
- Bloom: a new `BloomEffect` starts at intensity 0.4, size 24, threshold 0.95; Studio's Baseplate template
  ships Lighting.Bloom at 1, 24, 2. Once neon is placed (model_place, rig_build, world/Models.luau),
  `tameBloom` (`BLOOM` in `modeling/model-store.ts`) keeps it gentle: intensity ≤ 0.5 (else 0.4),
  threshold ≥ 1.8 (else 2, so only glowing things bloom), size ≤ 28 (else 18); a disabled Bloom stays
  off, the old values go in its `ShurikenBloomWas` attribute (behaviour checked in a scratch place).
  Bloom itself isn't drawn in a background Studio window at Automatic editor quality (not even at
  threshold 0; ColorCorrection is), so screenshots can't judge glow there. `Lighting.LightingStyle` can be
  set from scripts (Technology can't).
- Gear (`modeling/gear.ts`, `model_gear`): a Tool's Handle takes the hand's RightGripAttachment exactly
  (Handle = grip · Tool.Grip⁻¹), and in the default hold (ToolNoneAnim) that frame is upright and faces
  where the character faces (+Y up, −Z forward, 1.93 studs in front of the root). So Tool.Grip = the grip
  point's offset from the Handle holds a weapon exactly as modeled: in a playtest the grip point landed
  0.00 studs from the hand's grip and the blade stood upright, facing forward. An Accessory's attachment
  named like a body attachment follows it: a helmet modeled 0.634 above the reference head sat 0.66 above
  the test player's (avatars differ a little). The default R15's attachment points and body parts at rest
  (`R15_ATTACHMENTS`, `R15_PARTS`, feet on y = 0, height 5.457) were measured the same day.
- `AssetService:CreateEditableMesh` + `CreateMeshPartAsync(Content.fromObject(mesh))` works from the
  MCP/plugin context for temporary model previews (not saved with the place).
- Gamepad selection (observed in Studio 0.741): a LocalScript setting `GuiService.SelectedObject` to a
  button inside a ScrollingFrame as a playtest started crashed Studio twice (its window undrawn); the
  same UI without that line ran every time. The UI kit selects only for gamepad players (as it should:
  mouse and touch players would get a selection box).
- Script sources (measured in Studio 0.741): assigning `Script.Source` refuses 200,000 characters or
  more; `ScriptEditorService:UpdateSourceAsync` took 380,000 and 1,100,000, so the sync writes through
  it (the `.Source` fallback only runs when the editor call fails). A game-sized pull (`E2E=adopt-big`,
  429 scripts, three 6,000-line modules) took about 11 s, and the sync after it 3 s with no false edits.
- Textures (measured in Studio 0.741): `AssetService:CreateEditableImage` + `WritePixelsBuffer`,
  `EditableMesh:AddUV` / `SetFaceUVs`, and a SurfaceAppearance's `ColorMapContent` / `NormalMapContent`
  / `RoughnessMapContent` / `MetalnessMapContent` (and `MeshPart.TextureContent`) set from
  `Content.fromObject(image)` all work from the plugin context; `_G` and `shared` persist between
  execute_luau calls. The Blender export (`roblox_export.py`) finds a material's image maps the way
  Kiln wires them (Base Color ← image; Roughness ← image through Separate Color; Normal ← Normal Map ←
  image; Metallic), writes them as `<model>__<material>.<map>.png` (≤ 1024 px, colour sRGB, the rest
  gray; a number becomes a small constant map; Closest-sampled pixel art is enlarged by whole pixels),
  gives the mesh UVs with a top-left origin (split at seams), embeds colour, normal and a packed
  metallic-roughness map in the part's GLB, and colours the part with its colour map's average (what
  shows wherever the maps can't). A Principled Coat (Coat Weight / Coat Roughness, Blender 3's Clearcoat) is
  folded into the roughness map (r + (coat roughness − r) × weight: a creature's wet look); Sheen, Subsurface,
  a Bump with no normal map and an Ambient Occlusion node can't be shown and come back as export notes,
  which blender_python lists once when they first apply; a custom material property `roblox_emissive_tint`
  ("#rrggbb") tints a textured glow. Temporary meshes get the mesh JSON's normals (`EditableMesh:AddNormal` +
  `SetFaceNormals`, guarded: without them the vertices split along UV seams are shaded from their own side
  only — a visible line) and a SurfaceAppearance tagged `ShurikenTextured`
  listing its maps (file + content hash); `core/modeling/texture-staging.ts` sends each map once per
  Studio session in 160 KB base64 chunks (colour RGBA, normal RGB, roughness and metalness gray: ≤ 512 px each; a gray map that is one value everywhere, a number the material had, a few pixels) and
  attaches it to every SurfaceAppearance waiting for it (`E2E=textures`: exact pixels arrive; placing
  again sends nothing). Uploaded models carry the maps in their GLB; whether Roblox's importer applies
  them to the uploaded MeshParts is not verified yet (no upload made). EditableMesh UVs have a top-left
  origin — (0, 1) is the image's bottom-left, as in glTF (a DevForum answer the asker confirmed:
  devforum.roblox.com/t/issues-creating-texturable-editable-meshes/3647090) — so the export writes
  (u, 1 − v); a picture in Studio will confirm it once the display is on.
- Uploaded GLB meshes are turned 180° about Y by Roblox's importer (measured 2026-09-30 by three modeler
  agents in the user's live build): glTF's front is +Z and Roblox's −Z, so the importer maps (x, y, z) →
  (−x, y, −z), and since a MeshPart's geometry is centred on its own box every uploaded part ends up turned
  about its own centre while its position (the model.json origin) is right — a street-light arm pointing +Z
  with its lamp at −Z, chevrons reading "<" from behind, a car trim's top at the bottom. The temporary
  EditableMesh path (mesh.json) is not affected, which is why previews looked right and the uploaded Griever
  did not. The export writes its GLBs in Roblox space, so `modeling/glb.ts` (`glbTurned180`) writes the copy
  that is uploaded with x and z negated in POSITION and NORMAL (TANGENT xyz; the bounds follow) and the
  importer turns it back; `models/<part>.glb`, which the Models page and model_view read, stays as exported.
  An upload made this way is marked in the part's record (`upload.facing: 2`); a record without it is a
  legacy upload (still valid: nothing re-uploads) whose mesh arrives turned, so the Luau Shuriken generates
  — `world/Models.luau` and model_place (`place`, `turn`), rig meshes welded to their segments, model_gear's
  parts and its Grip / Attachment frame — turns it back with `CFrame.Angles(0, math.pi, 0)` about its own
  centre (`ModelStore.legacyUpload`); marked uploads and temporary meshes get nothing.
- Animation uploads use Open Cloud assetType "Animation" with an .rbxmx written by
  `core/animation/rbxmx.ts`; Studio's own deserializer loaded that file and produced poses identical to
  the builder's (`game:GetObjects` on a copy in Studio's content folder — `LoadLocalAsset` and
  `SerializationService` aren't usable from plugins). Sequences are authored at hip height 2.1924
  (the default R15 rig) so root motion isn't rescaled.

Uploads go through `core/roblox/open-cloud-assets.ts` (Open Cloud Assets API, the same encrypted key
as Open Cloud Luau; needs the Assets read/write permission; creator = the Studio user unless set in
Settings). The multipart body is built as one Buffer (`multipartBody`), never a `FormData`: undici
pumps a FormData into the request from an async function nobody awaits, so a request aborted before or
while it runs left an unhandled "Invalid state: ReadableStream is already closed" per upload (thirty
when a batch of runs was stopped). An upload whose run was stopped sends nothing. The core's
`unhandledRejection` handler (`core/index.ts`) reports that class once per burst
(`util/rejections.ts`) instead of as errors.

How a model's (or a creature's clips') uploads run (`roblox/upload-queue.ts`, `modeling/model-uploads.ts`,
`animation/animation-uploads.ts`): an upload belongs to the part or clip, not to the run that asked for it.
It is never given the run's AbortSignal, so it finishes and records its asset id even when the run stops
(the 29 of 58 parts that failed with "This operation was aborted" when a run was interrupted); Roblox
still processing it after the wait (3 minutes for a mesh, polled with a growing pause) is not a failure but
a pending Open Cloud operation kept in the record (`ModelMeta.upload.operation`, `AnimationFile.uploading`):
the next model_place / rig_build / model_gear / animation_build asks about that operation instead of
uploading again. Only parts whose mesh or maps changed upload (`ModelMeta.hash` covers the mesh and every
PNG map), up to six at a time; an upload another call has under way is joined, never sent twice; a call
waits at most about 4 minutes (10 with MCP progress, 15 for the user's own buttons) and then answers
"still uploading, call again" while the uploads carry on. Tool calls can report progress
(`ToolInvocation.progress`, which the MCP server turns into `notifications/progress` for a client that sent
a progress token): an MCP client gives up on a call that is quiet for about 5 minutes. rig_build builds from
what is uploaded and stages only the parts without an asset as temporary meshes (a part whose uploaded asset
Studio can't load yet is shown as one in a second pass, one with no mesh at all is left out and reported),
never all-or-nothing and never leaving the older template standing; `world/Rigs.luau` only holds rigs whose
parts are all uploaded and its pruning knows every rig of the project. Creature clips (custom rigs) whose
content isn't uploaded go up with every animation_build (also the one after a Kiln clip import and the one
rig_build triggers) and the place is built again so their Animation carries the `AssetId`: Studio-local ids
exist only in the DataModel that registered them, so a track a server script plays on a creature reaches the
players with an id they can't resolve (nothing plays, or another clip). The runtime prefers the uploaded asset
everywhere and warns once per clip when a server has to use a Studio-local id for a rig that isn't a
player's character.

Clips that change in the project's files (Kiln's while the user animates, kiln_clip, kiln_import) leave the
place stale until the animations are built again: `recordClips` regenerates `world/Animations.luau` whenever
it would differ (clips, or the rig their poses nest along) and flags `animations.changed {stale}`; the
`AnimationRebuilder` (`animation/animation-rebuild.ts`, started with the Kiln tools) turns that into one
animation_build in Studio a moment later, and kiln_import / kiln_clip say in their result's `studio` whether
Studio was updated. The Blender export's change check notices a texture retuned under the same names
(`roblox_export.maps_fingerprint`: the pixels, not the node names; for models built in Kiln the engine asks
Kiln's Blender for it after a script Kiln called no change); keyframe reduction judges frames against
nlerp, how Roblox blends Linear keys.

Models are made in headless Blender, the design of the user's Kiln app (`core/blender/`): each model
the agents work on is a `ModelWorkspace` with its own `blender.exe -b --python resources/blender/
bridge.py` (Kiln's bridge: JSON lines on stdin, marked replies on stdout, a persistent Python
namespace, Kiln's `kiln` helpers), so several modelers build at once without queueing. `BlenderModeling`
starts at most N Blenders (Settings → Agents; an idle one gives way to a new model, its scene reopens
from disk when needed), keeps one spare warm while modeling goes on, closes Blenders idle for five
minutes, and gives each model to the run working on it (another agent is refused until that run ends).
Every change is saved (`models/<Name>.blend` + a history snapshot for undo) and exported by the
bridge's `roblox` op: the visible geometry grouped by material into MeshParts — Y up, studs, the
model's Blender front (−Y) turned to face Roblox's forward (−Z), each centred on its own box with its
origin in the model — with a look from the material (emission → Neon, metallic → Metal, alpha → Glass,
or a `roblox_material` custom property); the parts land in the model store as an assembly, so the
Models page, `model_view`, uploads and `model_place` use them. Blender is found in the places Kiln
looks (Desktop\Blender, Kiln's copy, Program Files, Steam) unless Settings names one; `tests/blender.
test.ts` runs the real thing wherever Blender is installed. The engine sits behind one seam,
`modeling/backend.ts` (`ModelingBackend`: workspaces per model with owners, exec/scene/render/check/
undo, status): the tools, the Models page RPCs and the core use only that. `core.ts` builds a
`KilnModeling` (`modeling/kiln-modeling.ts`) around `BlenderModeling`. The user's Kiln app (found through
`%APPDATA%\Kiln\runtime.json`) builds every model: it is asked for results with `kiln_request` (below), and
the modeler's own `blender_python` in Shuriken's Blender is the fallback for when Kiln can't be reached. Only when Settings → Agents → "Let Shuriken's modeler work inside Kiln's
Blender (advanced; …)" (`modelInKiln`, unset counts as off; an explicit on keeps working) is on and Kiln runs,
each model of the modeler is a Kiln project in studs the user can watch live in Kiln's viewer. The agents' Python runs
through Kiln's local API (with Kiln's newer helpers), and after every change Kiln's `ext` op loads
Shuriken's own Roblox export (`resources/blender/roblox_export.py`, the module the local bridge imports too)
into Kiln's Blender; the parts are recorded by `modeling/publish.ts` (shared by both engines) and the
`.blend` is copied back to `models/`, so without Kiln (or when it closes) the same model carries on in
Shuriken's own Blender. Kiln's API is documented in Kiln's `docs/INTEGRATION.md`. Tests never use a running
Kiln (`SHURIKEN_NO_KILN=1` in the vitest configs); `tests/e2e/kiln.e2e.ts` checks the link against a test
Kiln (`E2E=kiln KILN_RUNTIME=<its runtime.json>`). While a run works on a model, KilnModeling holds a
lock in Kiln (Kiln's own chat and undo on it wait) and releases it when the run ends; it keeps Kiln within
"models at once" by closing the longest-idle model's Kiln project; and if Shuriken's own Blender changed a
model while Kiln was away, it imports that newer `.blend` into Kiln before the next step. The `kiln`
helpers (`resources/blender/kiln*.py`) are the same files in Kiln and here, so both engines offer the same
generators (terrain, scatter, the building kit, trees, rocks, blobs) and rig tools. A rig-ready model
(joints made with `kiln.rig`: `joint`, `bind`, `leg`, `attach`, `pose_test`) exports by segment then
material (each part carries its `segment`) plus `models/<Model>.rig.json` in Roblox space (studs, Y up):
`{ version, model, root, joints: [{ name, parent, part (= segment), pivot, axis, kind: hinge|ball|fixed,
limits }], legs: [{ joints, foot }], attachments: [{ name, part, position }] }`, exported at rest (a pose
test on the joints is muted).

Kiln is also docked in Shuriken (`main/kiln-host.ts`, `main/kiln-dock.ts`, the Kiln page): each project
window can show Shuriken's own `WebContentsView` onto the user's running Kiln — its embedded UI
(`/auth?t=<token>&next=/?embed=shuriken[&project=<id>]`, port and token from runtime.json, a
`persist:kiln` session, Kiln's origin only, other links to the browser) — laid over the Kiln page (top
bar: the flame), hidden with the page, when its project window isn't in front, or while one of
Shuriken's menus or dialogs is open over it (`lib/overlays.ts`). Undock moves the same view into a
window of its own with a Dock back bar (`?kiln-window`), without a reload; closing that window docks it
back. The view's preload (`preload/kiln.ts`) gives Kiln `window.kilnHost` { app, useModel(kilnProjectId,
name), dockState(), toggleDock() }; useModel is the core's `models.fromKiln` → `importFromKiln` on the
modeling seam: the user's Kiln project (meters) is copied into the model's own linked studs project,
scaled 1/0.28, and published like any model (a project Kiln built for one of this project's models is
just published). Kiln is only started (`Kiln.exe --background`, the path from Settings, install.json or the
Desktop shortcut) when no Kiln process runs, outside Shuriken's process tree; a live one is waited for,
never relaunched; the view follows Kiln to a new port or token and says so when Kiln closes. Settings →
Agents → Kiln: its location, "Start Kiln with Shuriken", "Dock Kiln". The Models page's flame / Watch in
Kiln opens the Kiln page on a model's Kiln project. Test runs never start Kiln (`SHURIKEN_NO_KILN=1`;
a smoke run connects to a running one only with `--smoke-kiln`). Checked against Kiln 0.6.0 (2026-09-29,
`--smoke-kiln`): the view lands exactly over the page, Kiln's embedded UI loads (`embed=shuriken`),
`kilnHost.app` is `shuriken`, and `dockState()` follows undock/dock back with the page kept (no reload).
Since 1.8.1 the dashboard has a Kiln container too (`KilnView` in `pages/kiln.tsx`, shared with the page):
one area at a time owns the view (the container, its expanded copy, or the page), it steps aside while
the layout is edited or another container is expanded, and it follows the model being built in Kiln
right now (`models.workspaces`). Since 1.9.x it is off by default (the Models and Animation containers
show what Kiln makes, and the Models container has one line on the Kiln build running: model or family,
Kiln 0.8.2 progress, what waits); Edit layout turns it, or any container, on and off
(`renderer/lib/dashboard-layout.ts`): a hidden container's room goes to the containers along one whole
side of it, and it comes back to its old place when that room can be carved out again, else where it fits
(Kiln: under a tall director chat, else the right of the viewer). A layout saved with Kiln gives its room
to the containers new in 1.9.x (`applyChoices` / `fillRect`), else to its neighbours. The Effects container
(`containers/effects-mini.tsx`, `effects.list`) plays the game's effects in turn in the particle preview
with the list under it; expanded, it is a small workshop with the effects copilot (`CopilotPanel`), and its
title opens the Animation page on its Effects tab (`navigate('animation', 'effects')`). The Quality
container (`containers/quality.tsx`, `lib/quality.ts`) is what to check after an overnight build, which no
other container shows: the tests by last result (failing ones by check name, copies folded; `tests.list`),
the finished tasks whose result still carries "Visual check pending:" (nobody saw them), and "Decided
without asking" (`escalations.list` auto_resolved); each line opens its task or the decisions on Agents.

Kiln's own copilot is briefed with `kiln_request` (the animation workshop's and, since 1.8.1, the
modeler's): every model goes to it (see "Kiln first" below), because it models, rigs and animates better
than hand-written bpy and researches reference images on the web
(Kiln's research phase: WebSearch + a `reference_images` contact sheet). For Kiln before 0.7.3 `kilnBrief`
makes that explicit (from 0.7.3 Kiln owns that text, see "Kiln 0.7.3" below): `references` ("the Griever from The Maze Runner films") asks for the research before the
blockout; without it, a line asks Kiln to research whenever the brief names a specific existing thing.
`images` (project files or https URLs, ≤ 6, ≤ 8 MB) go along as data URLs in the chat request, and
`from` names the role that asked ("Shuriken 3D modeler"). The planner knows whether to plan for it: every
agent's context carries a modeling line (`context/environment.ts`, from `Core.kilnFacts`) saying whether
Kiln's copilot is available for `kiln_request` (the test the tool makes: Kiln answers) and that each model
has its own Kiln project or Blender, so different models' work runs in parallel; the director's state has
its own Kiln line. The planner's brief makes a Kiln task say "use kiln_request" and state the goal, never
"in Blender" or a design.

**Kiln 0.7.3: Shuriken asks for results** (`kiln-tools.ts`, `modeling/kiln-modeling.ts`,
`modeling/kiln-lighting.ts`; the contract is in Kiln's `docs/INTEGRATION.md`, "Asking Kiln for a result" and
"Roblox target"). Everything below is gated on `GET /api/v1/app` → `version >= 0.7.3`, compared number by
number (`kilnAtLeast`, `KilnClient.supports`); older Kiln keeps `kilnBrief`, the `/ext` live-scene export and
`kiln_clip` as before. The direction: Shuriken says what the game needs and Kiln's copilot owns the method.
- Briefs. `kiln_request {kind, effort?, text, references?, images?}` posts `{text, from: "shuriken", kind,
  effort?, images?}` to `/chat`. `kind` is `new | rework | fix | animate` (default `new` when the call makes
  the model's Kiln project, else omitted). Every build has a level, `detail` (`kilnDetail`, `KILN_EFFORT`,
  `KILN_BRIEF_LIMIT` in `kiln-tools.ts`): `quick` (the default: props, dressing, anything simple) sends effort
  `low`, `quick: true` from Kiln 0.8.4, a text of at most 280 characters and no checked requirements (a rough
  size goes along as words); `standard` (a family, sockets, a named subject, animation) sends `high` and up to
  600 characters; `hero` sends `xhigh` and up to 1,200 (half of 1.12's limits; only the prose counts). `max` only when the caller asks. A longer text is
  refused with what to cut. Left to Kiln, a 2,900-character forge brief ran 37 minutes at max; quick + low
  builds the same forge in about a minute, so a prop whose look matters is asked for as two or three quick
  variants (`Forge_A`, `Forge_B`, …) and the best is kept. No message to Kiln carries Shuriken's content rule
  any more (1.13: Kiln's own prompt and scan cover it; Shuriken's scan and look before an upload are the net). With fields (Kiln 0.8.2) sockets, a family's models and the look go as bare lists, and named parts only as `spec.parts`. The text goes out as the agent wrote it: no Roblox paragraph, no
  research line, no "your call" line (Kiln's copilot has its own Roblox section and research phase);
  `references` becomes one plain sentence ("The subject is …"). The tool waits until the turn leaves
  `running` (Kiln keeps it running until the delivery is in) and returns Kiln's `effort`/`effortWhy` and the
  turn's `delivery` (size, units, objects, tris, joints, clips with speed and markers, renders): facts such
  as ground speeds and marker times are read there, never prescribed. The prompts (modeler, animator,
  planner, animation copilot) ask for goal + must-haves (clip names, loops, markers, speeds to tell back).
- Target and lighting. A project Shuriken creates is made with `target: "roblox"` and the place's Lighting
  (`readPlaceLighting`: a read-only Luau snippet through the Studio adapter, mapped to the contract's
  `brightness, ambient, outdoorAmbient, clockTime, latitude, envDiffuse, envSpecular, exposure, atmosphere,
  bloom, colorCorrection`; nothing is read when Studio isn't connected). An existing linked project gets
  `POST /projects/:id/target` once, and again before a brief only when the lighting hash changed since it was
  last sent (kept in memory and as `targetFp` in `.shuriken/kiln/<Model>.json`; a lighting that can't be read
  never fails a request and never counts as a change).
- Baked Roblox export. Importing a Kiln project (`importFromKiln`, and the publish after a turn) calls
  `POST /projects/:id/roblox` (409 = its copilot is working: retried for up to three minutes; an export of
  the current scene version is reused, `cached`) and runs `roblox_export` on `exports/roblox-v<n>/roblox.blend`
  (one atlas per material, one UV layer `RobloxUV`, coat already folded into roughness, so it isn't folded
  again). The export runs in Shuriken's own headless Blender on a copy of that file
  (`BlenderModeling.exportBaked`, behind `ModelingBackend.exportBaked`: its own bridge, no workspace, no
  save), not in the project's Blender and not through `/python`; `/ext` (live scene) is only the fallback
  when no bake could be had, and the result then carries a note. The material custom property
  `roblox_transparency` (0-1) becomes the part's transparency and `roblox_emissive_tint` keeps its meaning.
  The clips' fingerprint kept for `syncClips` comes from Kiln's own `/anim`, not from the baked copy.
- No hands-on control. Shuriken doesn't model, retexture or retune gaits in a Kiln project through `/python` or
  `/clips generate|regenerate`. `kiln_clip` generate / regenerate / settings / rename / delete / event on a
  model that is a Kiln project (linked, Kiln 0.7.3) is refused with a pointer to `kiln_request` (kind
  `animate` or `fix`); `check` (through Kiln's `/clips/:name` check) and the reads stay, and models living in
  Shuriken's own Blender keep `kiln_clip`. `blender_python` on a Kiln-owned model is refused while the
  advanced setting is off (a change made in Shuriken's Blender would be overwritten by Kiln's next result).
  A result that looks wrong in Studio gets a `fix` brief with Studio screenshots of the asset in place
  (`roblox_screenshot` evidence under `.shuriken/evidence`, passed in `images`) and one sentence on what is
  wrong. What stays plumbing: `/python` scaling a user's meters project to studs when it is copied into a
  model, the `/ext` read of rig and clips for `syncClips` while the user animates, `lock`, `close`, `render`.
- Helpers: `resources/blender/kiln*.py` (now with `kiln_roblox.py`) are byte-identical (LF) to Kiln's
  `blender/kiln*.py`; `tests/kiln-results.test.ts` (a fake Kiln) covers the contract. Synced again with Kiln 0.8.1
  (new `kiln_map.py`), and with Kiln 0.8.2 (new `kiln_parts.py`; `bridge.py` is Shuriken's own port and doesn't have Kiln's
  `parts` op or `PROJECT_DIR`, so `kiln.style()` is None in Shuriken's Blender). `KilnClient` re-reads `runtime.json` when a call fails (Kiln 0.8 removes it on quit and steps aside for a
  newer Kiln: port and token change); a missing file is "Kiln is not running".

**Kiln first: every model, families of parts, the build queue** (`capabilities/kiln-tools.ts`, `modeling/kiln-launch.ts`,
`kiln-brief.ts`, `kiln-family.ts`, `kiln-queue.ts`, `kiln-version.ts`; tests `kiln-first`, `kiln-family` (with real Blender),
`kiln-queue`, `kiln-082`, fake Kiln in `tests/helpers/fake-kiln.ts`). In the run of 2026-10-01 Kiln was running and `kiln_request`
was visible, yet 15 mech parts were hand-written bpy: the context line, the planner and the modeler offered Kiln only for creatures.
- Kiln first. Every model (props, vehicles, characters, creatures, weapons, map pieces, set dressing) is asked of Kiln. A Kiln that
  is installed but not running is started by the first request (`KilnLauncher`: never a second Kiln, never from a test or smoke run;
  Settings "Start Kiln when a build needs a model", on by default). While Kiln can be reached, an agent's `blender_python` on a NEW
  model is refused (`KilnModeling.kilnFirst`; models that already live in Shuriken's Blender and the user's panel are not). When Kiln
  can't be reached, or fails twice on a model, Blender takes it and the chat gets one plain line per reason naming the models.
- Briefs as data (`kiln-brief.ts`): goal text, references, the family's models, sockets (name, what it joins, where: never
  coordinates), what it is fitted against, the game's style, triangles, size, ground contact. Up to Kiln 0.8.1 all prose; from 0.8.2
  `spec {tris, size, ground, sockets}` and `style: <the project's sheet id>` go as data, with `mode: "queue"`.
- Families (`kiln-family.ts`): parts that must fit (all torsos; then legs and arms fitted against them; then weapons) are ONE Kiln
  project each (`.shuriken/kiln/families/<Family>.json`); a later family names the earlier project so Kiln brings a part in. Each
  member is exported as its own model from a copy of Kiln's baked scene (`exportBaked` with a `prepare` step): from 0.8.2 exactly the
  meshes and origin Kiln's `models` give; before, the top-level object of that name with its pivot at the bottom centre of its box.
  Sockets are read back (0.8.2 `models[].sockets` through `socketFrame`; before, markers with role "socket"; a rig's attach points)
  into the spec section "Model sizes and sockets" and the generated `ShurikenSockets` module (CFrames per model, `world`, `mate`),
  so code attaches parts by Kiln's numbers. Kiln 0.8.2's `checks` and `fit` become the result's `problems`, the ground for a fix.
  The game's style sheet (0.8.2) is copied into the project and into the spec section "Art style sheet".
- The queue (`kiln-queue.ts`): builds run first in, first out, `kilnBuildsAtOnce` at a time (Settings, 1-20, default 8), one build per
  Kiln project at a time, whoever waits. Against a Kiln older than 0.8.2 at most 6 run (12 renders at once froze an 8 GB card) and
  Shuriken's own bakes and renders through Kiln go two at a time (`KilnModeling.gpu`); 0.8.2 gates GPU work itself. The queue steps
  its own limit down on evidence (failures, a 503, bakes slowing sharply while several run, turns too against a Kiln without the gate: a long turn is effort, not load; builds queuing at Kiln's GPU gate
  per `GET /api/v1/load`), says so in the chat, and lets one more run again after every 15 quiet minutes (`STEP_UP_MS`). `kiln_request {wait: false}` returns a build id and
  `kiln_builds` waits for several in one call, so one modeler task holds one agent for many builds. `mode` (0.8.2) interjects into a
  running build, queues follow-on work or replaces it. A map project (placements in Kiln's check) is left to `kiln_layout_import`.
- Usage: each build is a copilot turn on the user's subscription. Its cost (from Kiln's transcript) is recorded as a `runs` row with
  role `kiln`, so it counts in the run list, the task's runs and the report; `Core.kilnBuilds()` feeds the agent limit; the top bar,
  the director's Kiln line and `kiln_builds` show running and waiting builds with Kiln's progress (0.8.2) and an estimate from Kiln's
  measured builds (a kit about 10 min, a prop about 5 min, a follow-on about 3 min).

**Big maps in the Roblox export** (`resources/blender/roblox_export.py`, `modeling/part-traits.ts`; tests `export-oversize`,
`export-faces`, `export-roles`, `export-instances`, real Blender). Found on a 9.2 km Kiln map (1,373 meshes, 356 unique, 521,727
triangles): per-material merging made 141 huge parts, 31 over Roblox's 2,048-stud limit, undrivable collision and an invisible road.
- Tiles. A material wider than 2,000 studs on an axis is cut on an even grid (triangles crossing a tile edge are cut there; UVs and
  normals interpolated, winding kept), then a tile over 10,000 triangles is slabbed as before. Parts record `piece [n, of]` and
  `tile [x, y, z]`; every tile keeps the material and its shared maps.
- Faces Roblox can't see. Per object and material the export measures the share of boundary edges (≥ 15% = a sheet), paper-thin
  closed shells (2·volume/area < 0.1) and flat horizontal meshes whose winding faces down. Such parts get `doubleSided` and the Luau
  sets `MeshPart.DoubleSided` inside `pcall` (the property is in the luau-lsp API types; plugin-writability unverified); flat meshes
  facing down are an export note, and `blender_check` / `model_view` list both. Negative-scale objects had their winding wrong (inside
  out): now reversed.
- Instances. Objects sharing a mesh (linked duplicates, collection instances; ≥ 4 uses with the same data, materials, modifiers, role)
  are ONE part per material in the mesh's own frame plus `instances [{position, rotation (Y X Z degrees), scale}]` in Roblox space
  (`ModelMeta.instances`, stored one use per line). Mirrored uses get a mirrored mesh of their own; shear, oversize and uses a
  modifier made different stay merged. Uploads happen once per unique mesh; `world/Models.luau` rows carry `inst=` and
  `placeInstances` clones the MeshPart per use (CFrame, Size, legacy `turn`, traits); `model_place` places the pivot once and
  records it; temporary meshes clone one EditableMesh. Rigged models never instance.
- Collision roles. Custom property `kiln_role` (drivable | ground | barrier | decor | collider; `kiln_collides_for` names what a
  collider stands in for) or, absent, a guess from object and material names. Roles are never merged (a road is its own part).
  `part-traits.ts` turns the role into traits: decor `CanCollide/CanQuery/CanTouch` false and `CastShadow` only when ≥ 10 studs;
  drivable and ground `PreciseConvexDecomposition`; barrier `Box` (exact box) or `Hull` (fills ≥ 75% of its box) else precise (a hull
  of a curved rail would close the road); collider invisible (`Transparency` 1) collision; the visuals it replaces collide with
  nothing. Part `Transparency` is applied by the builders now too.
- Not built yet: the planner's kit-plus-layout guidance.

**Kiln maps: a layout and its pieces** (`modeling/kiln-manifest.ts`, `kiln-layout.ts`, `kiln-layout-luau.ts`, `layout-import.ts`,
`capabilities/layout-tools.ts`; tests `kiln-layout`, `kiln-layout-luau`, `kiln-layout-import`, `kiln-layout-blender` (real Blender),
`renderer/model-instances`; the ground truth is Kiln's reference layout, copied to `tests/fixtures/kiln-layout-reference`). Kiln 0.8
describes a map as a layout project (ground, road, one-off buildings) that places pieces built in their own projects, and its Roblox
export writes `roblox.json` version 2 next to `roblox.blend`. One tool, `kiln_layout_import {model | kiln_project}` (modeler,
environment artist, level designer: the tool's `roles`), brings it all into Studio.
- The manifest (`parseManifest`): `units`, `studs_per_unit`, `plain`, `meshes`, `materials` (`plain`, `color`, `roblox_material`),
  `pieces` (project, version, fingerprint, `stale`), `placements` (4x4 row-major world matrices, scene units, Blender axes),
  `mirrored_placements`, `markers`, `paths`, `roles`, `colliders`. It degrades: version 1, a missing field or a bad entry is a note
  and a default, never an exception; a `blend` or map path that is only a file name is resolved against the manifest's folder.
- Kiln's check comes first (`GET /projects/:id/roblox`, `sortProblems`): a mirrored placement blocks; what Shuriken's exporter
  handles (a part over 2,048 studs, a mesh over the triangle limit) never holds an import back; everything else (metalness between
  0 and 1, see-through textured materials...) means the map is NOT imported and the problems come back for a `kiln_request` fix
  brief, unless the agent passes `accept_problems`. `check_only` reads the check and the numbers and changes nothing.
- Frames (kiln-layout.ts has the derivation; the tests check it with numbers against Kiln's `expected.json`, through the real
  exporter and the upload copy). Blender (x, y, z) is Roblox (-x, z, y): a rotation T, so nothing is mirrored. A piece is exported
  in studs from its own project (q = kP T p), and a placement's matrix (A, t) in the layout's units gives w = B q + d with
  B = (kL / kP) T A T^-1 and d = kL T t. A MeshPart draws its mesh centred on its box: B = R diag(S) (R the CFrame's rotation, S the
  Size over the mesh's own size, so non-uniform scale is exact) and the position is B c + d for a part whose box centre in its model
  is c. A piece that instances its own mesh composes both; a shear (non-uniform scale over a turned use) is approximated by the
  nearest rotation and counted in a note. Mirrored placements are left out. Uploads are pre-turned (`facing: 2`), so a clone needs
  nothing; a legacy upload's template is marked `ShurikenTurned` and its clones get `CFrame * Angles(0, pi, 0)` (a half turn about Y
  commutes with the scale). A marker's +Y is its facing: its anchor part's LookVector is that direction and its UpVector the marker's +Z.
- Exports (`LayoutImporter`): every piece's project, then the map's own geometry, each through Kiln's bake (`POST roblox {plain:
  true}`; Kiln reuses a bake of the current scene) and Shuriken's exporter in a Blender of its own on a copy (`exportBakedBlend`). A
  prepare step runs on the copy first: placements of the pieces that will be cloned are removed (Kiln leaves them in `roblox.blend`
  as collection instances, which the exporter would bake into the map), and a scene in meters is scaled to studs. A piece whose
  project can't be exported stays in the map's own export (the map's copy of it), with a note. The manifest's look is put on the
  parts (`applyManifestLook`): a material with `roblox_material` is `MeshPart.Material` plus `Color`, another plain one is its colour;
  neither has a texture to upload. What was exported from what is kept in `.shuriken/layouts/models.json` (Kiln's
  `source_fingerprint`, `plain`, the studs per unit, each part's box centre, a hash of the parts on disk): a model whose Kiln
  fingerprint (from `GET /api/v1/app`, which opens no project) and parts are unchanged is skipped without a call to Kiln, so only
  pieces that changed are baked again. That listing holds Kiln's 48 most recent projects (measured on the user's Kiln, which has
  more): for a project it leaves out, `GET /api/v1/storage` (every project, no fingerprints, a few seconds) says whether it exists
  and when it last changed (`updatedAt`, kept per model and read again after a bake, which counts as a change).
- Uploads: one per unique mesh through the queue `model_place` uses (`ModelUploads`, handed out by `registerModelTools`); uploads
  under way are joined. An upload of a part that is placed nowhere no longer rewrites `world/Models.luau` (a map has hundreds).
- In Studio (the programs are in kiln-layout-luau.ts; each is small, idempotent and answers with counts and at most 12 failures,
  because an `execute_luau` result is cut at about 100,000 characters and one call must not time out):
  `ServerStorage.ShurikenMapKit.<Map>` holds one template MeshPart per unique mesh (the asset is loaded once, its look and collision
  traits set once; clones copy them; it is not replicated to clients, and game code can clone pieces from it at runtime);
  `Workspace.<Map>.Static` holds the map's own parts (ground tiles of at most 2,000 studs, each streaming by itself);
  `Workspace.<Map>.Pieces.c_<x>_<z>` holds the placements in Folders by 512-stud grid cell; `Workspace.<Map>.Markers` the markers.
  Why this shape for StreamingEnabled: parts stream by distance one by one whatever Folder they are in, and a Folder costs nothing
  and never makes its contents arrive together, so cells are Folders (a Model around a cell would add a bounding box over hundreds
  of parts and, made atomic, would stream a whole cell at once); they keep the Explorer usable, the lookups of a second import
  short, and give game code a spatial index. A placement of several parts is one Model with `ModelStreamingMode.Atomic` (a tree
  never shows without its leaves); a single-part placement is the bare MeshPart (half the instances). The markers' Model is
  `Persistent`, so client code finds a checkpoint however far away it is. A unit's pivot (`WorldPivot`, or the part's
  `PivotOffset`) is the placement's own origin and facing, whatever the mesh's box centre is.
- Scale and resuming: the kit goes 20 templates a call to begin with (4 to 60, by how long the last call took), placements 300
  MeshParts a call (25 to 1,200, at most 150,000 characters of rows); a call that fails whole is tried again at a quarter of the
  size. Every template carries a stamp (mesh hash, asset, look) and every unit a fingerprint (`ShurikenFp`: its templates' stamps
  and its numbers): a second import keeps what matches, replaces what changed, and after a complete pass sweeps what this run did
  not see (`ShurikenRun`) and the templates the map no longer uses. A tool call has a time budget (`waitBudget`): what it did not
  get to comes back as `done: false`, and the next call goes on (nothing is exported, uploaded or placed twice). A mesh Studio
  can't load yet leaves its placements waiting, reported by name. 1,400 placements of 350 meshes arrive in about six unit calls
  and eighteen kit calls (tested against a Studio stand-in that keeps what the programs would build).
- For game code: markers are invisible, anchored, non-colliding Parts named after the marker, tagged `MapMarker` and
  `MapMarker_<role>` with a `Role` attribute (also written as the world builder `world/<Map>Markers.luau`); paths (points in studs,
  width, closed, length) and the markers' CFrames are a strict data module in the synced code, `<shared>/ShurikenMaps/<Map>.luau`
  (`Map.path("road_centerline")`, `Map.markersOf("checkpoint")`), which passes selene and strict luau-lsp. Roles drive collision as
  before (`part-traits.ts`); a placement's own role and a collider that names a placement or its piece override the clones' traits.
- No world builder re-places the placements (a 9 km map's rows would be one call of several hundred kilobytes that loads hundreds
  of assets: exactly what the batches avoid): the place file keeps them, and `kiln_layout_import` again restores what is missing.
- `temporary: true` builds the templates from `mesh.json` (EditableMesh, colour and traits only, at most 12,000 triangles each)
  for a look without uploads; its stamps differ, so the real import replaces all of it.
- Previews: `ModelView` (the Models page, its tile, `model_view`) draws a part with `instances` as one `THREE.InstancedMesh` with
  an instance per use (`components/models/instances.ts`); the Studio viewer draws each clone Studio holds from the project's mesh
  (the clones carry `ShurikenModel`), batched per model as before.
- A Kiln clip's `turn` (0.8.1: degrees per second, positive to the model's left, a positive yaw in Roblox) is written into
  `<Model>.clips.json` and kept in the animation's Kiln source and description.
- Models, sockets and fit (Kiln 0.8.2; test `kiln-sockets`): the manifest's `models` (each top-level object: its meshes, origin,
  size, materials and `sockets`, named frames in the model's own space) and `fit` (Kiln's check of mating sockets) are read into
  the same structure (`parseModels`, `parseFit`; absent in 0.8.1: no models, no fit). `socketFrame(matrix, studsPerUnit)` gives a
  socket as a frame relative to the model's pivot in Roblox, by the same axis change placements go through (its +Z is the socket's
  facing); `socketAttachment(matrix, studsPerUnit, {origin, legacy})` gives `Attachment.CFrame` on one of the model's parts (the
  part's box centre relative to the pivot; a legacy upload's part carries the half turn, so its Attachment is expressed in that
  frame). Two Attachments made this way and lined up exactly put the child where Kiln assembled it (tested for marked and legacy
  uploads, studs and meters).
- Not verified in Studio yet (no Studio in the tests): `ModelStreamingMode` and `PivotOffset` set from the plugin context, how long
  `InsertService:LoadAsset` takes for hundreds of assets, and collision of non-uniformly scaled clones. Known cost: the publish
  after a `kiln_request` still bakes without `plain` and with the placements as geometry, so the first import after it bakes and
  exports the map again.

The Models page previews it (`components/models/model-view.ts`) with a blocky 5.2-stud player standing beside it
(right of the model as the camera sees it, framed together), so its size in the game is obvious.
Agents see what they make too: `model_view` and `animation_view` ask the core's host for a picture
(`CoreOptions.render` with a `@shared/render` request → a `render` message to main → a hidden
offscreen page, `?render`, `render-sheet.ts`), drawn by the views the user sees: the Models page's
ModelView (three angles beside the player and a close-up, one JPEG sheet; an assembly's parts each
at their origin in their colour and material — Neon glows, Metal shines, Glass is see-through — the
same way the Models page groups and draws them) and the Animation page's
R15 mannequin (a filmstrip, frames snapped to markers like "Hit", a sword in hand for sword moves).
Main makes that page on the first request, renders one at a time, and closes it after two idle
minutes or with the last app window (nothing is drawn while the app closes); without a host (tests,
plain Node) the tools say to check with a Studio screenshot instead.

The director gets `map_preview` (latest screenshot evidence, optionally the live viewport), and its
structured reply may carry `show` buttons (animation / audio / models / viewer / agents, with an item)
that the chat renders as links to those pages.

The viewer draws terrain from sampled voxel columns (`viewer.terrain`): the lowest solid span of each
column is the ground, joined to a neighbour whenever their spans overlap (so steep FillBall flanks stay
closed), with its underside drawn too and sides where terrain meets empty cells or the sampled area's
edge — overhangs and slabs over the void read solid instead of hollow. `window.__shurikenViewer.terrain`
draws a given sample for checks without Studio.

The viewer draws the project's modeled meshes as Studio shows them (`@shared/viewer` is the contract between
the Luau, the core and the scene). `viewer.parts` rows carry flags (ShurikenTurned, has a colour map, FileMesh
Part, temporary mesh) and, for a Part drawn through a SpecialMesh FileMesh (the workaround for the 2048-stud
cap), its Scale and Offset; such a piece is matched to its project model by the ShurikenModel attribute (part or
mesh), the MeshId of a MeshPart that carries one, or its name, and drawn at the model's size times Scale.
`viewer.model` sends a model's geometry without the GLB's embedded images (the drift map's 121 MB of GLBs are 30 MB),
a ≤256 px thumbnail of its colour map (cached under `.shuriken/viewer-cache/`) and whether its upload is legacy:
Roblox's importer turns every mesh 180° about Y, so a legacy upload (no `facing` marker) is turned in Studio
whatever CFrame it was given (Shuriken's builders compensate with a half-turn and mark the part
`ShurikenTurned`; hand-written builders turn it themselves), and the viewer turns the GLB the same way
(`meshTurned`) instead of guessing which parts were compensated. Models load six at a time, widest first. A
stand-in for a mesh not (yet) loaded that is wider than 900 studs is a faint wire box, never an opaque slab, and
the first camera pose frames the StartGrid (else a SpawnLocation within the build, else the percentile-trimmed
box of what is drawn: `scene/framing.ts`). A read that fails while Studio flips between Edit and Play is read
again by the router and, if it still fails, retried quietly by the view while it keeps the last scene.

The Studio viewer page has a Studio-style Explorer: `viewer.parts` rows carry each part's folder path
under Workspace (indexed, at most 4 levels, size-capped so a page stays under Studio's result limit);
selecting a folder outlines its parts and frames them, and a part picked in the view opens its folders
in the Explorer. Below Workspace, the project's scripts appear under their services (from `code.index`,
the same index agents query) and the world builders; a script opens read-only in a tab (Studio's
colors via `lib/luau-highlight.ts`, virtualized rows, find) and its Properties list requires, users,
remotes and functions (click to jump). The Output panel polls `roblox.console`. Deep links:
`viewer@<folder>`, `viewer@script:<file>`, `viewer@output` — the director's `show` buttons use them.

`map_audit` (`core/roblox/map-audit.ts`) measures a built area in Studio in milliseconds — surface
materials and colours, a grid of downward raycasts that ignores zones and invisible walls (holes,
terrain, ground materials, flatness, bare ground near each sample), the landmark height, giant flat
ground parts and the lighting pieces — and `mapFindings` turns the numbers into plain findings with
lenient thresholds (checked: the scratch place's finished colosseum and lobby get none, a grey
baseplate blockout gets eight). Level designers, environment artists and the critic are told to use it.
Since the run of 2026-10-01 (mechs walked through tyre-stack cover, scaffolding stood in the lanes) it also
reports `cover` (pieces with a `Cover` attribute or tag: no collision, collision lower than `step` over their
base, nothing raycasts can hit; `step` defaults to 3 studs, an R15 character's, and the tool takes the
game's own; CanQuery counts as on for a colliding part, as measured) and `build` (unanchored parts not held
by anything anchored, tiny colliding parts, PreciseConvexDecomposition on small colliding meshes, small
shadow casters, RenderFidelity Precise, unique meshes, lights and shadowed lights, streaming, and z-fighting:
visible block faces in one plane, facing the same way, overlapping, with a different colour or material).
The audit script passes the strict checker (`tests/map-audit.test.ts`).

**Looking without eyes** (`core/look/`, `capabilities/look-tools.ts`; tests `look-analysis`, `lighting-presets`).
12 of 38 critic reviews in that run passed with no visual check, and the ones that looked passed frames that
were 77-92% one orange hue. `look_analyze` (environment artist, level designer, critic, UI designer) measures
screenshots the way an art director checks them, like the audio engine's analysis tells a sound designer what
it hears: `jpeg-decode.ts` is a dependency-free baseline JPEG decoder (what Studio's screen_capture writes:
4:2:0 at 1920 px; within 3 levels of libjpeg at 4:4:4 and in grey, nearest-neighbour chroma; progressive files
are refused by name), PNGs go through `modeling/png.ts`; `look-analysis.ts` works in CIE L*/Lab at about 320 px
(clipping and the L* histogram at full size) and reports exposure, value groups (k-means), chroma, hue families
and the dominant 50° family, the cast and its temperature (McCamy), a palette, the strongest horizontal boundary
as the horizon, depth (far against near contrast, the far band against the sky, ground against background),
edges and fine texture (calibrated on 789 screenshots of six projects), the visual weight and named regions
against their surroundings. `critiqueLook` turns them into one line and likely problems with Roblox fixes; a
stated mood and view move the conventions, and no finding judges beauty. Pictures are evidence ids, a project
file, or a task's newest screenshots.
`lighting_set` (environment artist, level designer) applies `look/lighting-presets.ts`: nine starting points by
time of day and mood, each with an intent, what to adapt, a look_analyze target and its source (only
sunny_cartoon was checked in Studio), merged with the agent's adjustments (range-checked; false removes a
piece) into `world/Lighting.json` and a generated idempotent `world/Lighting.luau` that sets each property on
its own (what a Studio can't set is reported), owns the Atmosphere and one of each post effect, keeps a Sky's
skybox and never touches `Lighting.Technology`; a hand-written builder is replaced only with replace_existing.
The environment artist briefs Kiln for kits through the `kiln` workshop (`kiln_request`, `kiln_builds`,
`kiln_import`, `model_view`, no Blender).

Skills for the workshops: `roblox-combat-feel` (moves, effects, sounds wired into client/server combat;
hit-stop and shake), `roblox-ragdoll-knockback` (a tested ragdoll/knockback module for current rigs), `roblox-environment-art` (v6: the visual brief, composition, lighting property by property
from lighting_set, materials and terrain, Kiln kits and story clusters, the VFX hand-off, look_analyze at gameplay
height, performance; `tests/environment-art-skill.test.ts`), `roblox-game-hud` (a HUD kit checked in a playtest: `E2E=hud-kit`), `roblox-ui-design` (menus, shops,
inventories and dialogs: the Ui kit, `E2E=ui-kit`; the kits follow PreferredInput, Reduce Motion and Background
Transparency, each behind a pcall), `roblox-ui-references` (the look in numbers: rubric, device canvases, tokens,
palettes, genre layouts, motion and polish checklist; `tests/ui-references-skill.test.ts`), `roblox-animation-runtime` (replication, joint-by-joint
priority layering, fades, markers, no root motion — measured on an R15 rig), `blender-props` (headless Blender
conventions for Roblox, materials → MeshParts, pitfalls, four recipes verified in Blender 5.2 with clean
clash checks). Retired bundled skills (`build123d-props`) are removed from the skills folder on sync.

More rules that keep the workshops honest:
- Generated runtime modules carry a version in their header (`-- ShurikenAnimations v4 …`);
  `ensureRuntime` rewrites older generated files and leaves hand-replaced ones alone. They must pass
  the new-project lint config (`SELENE_TOML`, `LUAURC`): `tests/runtime-lint.test.ts` runs the real
  toolchain where installed.
- Clips can give a hand `aim: [x right, y up, f forward]` instead of wrist angles, and `reach` (a
  point, with an `elbow` hint) instead of arm angles; `resolveAims` solves the arm (numeric IK on the
  rig's own chain) and then the wrist for the pose at that key. `animation_create` reports reaches
  that miss. Presets use the same solvers (`reachHand`, `reachFoot`, `plantFoot` keeps feet planted
  while hips turn).
- `animation_check` measures markers at their exact time (a fast strike moves a stud in one frame).
- Agents see a "Game content" context section (every animation with markers, effect, sound with
  upload state, model) with the require paths, so gameplay code uses the right names.
- `RobloxStudioAdapter.screenshot` retries a blank or timed-out capture once, then throws
  `ScreenshotUnavailableError` (after timeouts it also stops asking for 2 minutes: Studio can only capture
  a window it is drawing), which verification treats as skipped ("can't check visually"), not failed.

Lessons encoded from the first game milestone run (see git history for details): plans must carry
`dependsOn` (prose ordering is rejected), parallel tasks must not fail on each other's files, checkpoints
must not commit other tasks' in-flight work, and Studio is launched outside Shuriken's process tree.

## 12. Docks, copilots and plugged-in games (1.8)

Shuriken works on any Roblox game, not only games it builds: the director oversees everything, and the
user can also drive the docks directly.

**Dock copilots** (`core/copilots/`). The Animation, Music & sound, UI and Effects docks each have a
copilot the user talks to in the dock (its own chat channel, `copilot:<dock>`, migration 7). Each is a
narrow expert (`copilot-roles.ts`: prompt, the dock's tools per kind of turn, its skills) that continues its provider
session between messages (the latest completed run within 24 h, same app version, after any reset),
sees a compact state of its dock and what the user is looking at, and answers with a structured
`copilot` result: the reply, buttons that open app pages, a one-line digest for the director, and a
handoff when the request needs the whole team. The director's state lists the digests ("Work the user
did directly in the docks"), so it builds on dock work instead of redoing it. Suggestion bubbles here,
in the director's chat and on the start page are `{label, prompt}` (`@shared/suggestions`): the bubble
shows the short label and puts a fuller, more specific request in the box (a plugged-in game's study
writes its own). Since 1.8.1 they know the game (`director/live-suggestions.ts`): one small call of the
`suggester` role (fast model, no tools) writes every place's bubbles at once from a digest of the game —
its goals, finished and open work, models and rigs, animations, sounds, effects, screens, a plugged-in
game's study and what the user asked lately — kept in `.shuriken/suggestions.json` and written again
(at most every 10 minutes, only when the UI asks: `suggestions.live`) once the game changed (goals,
every few finished tasks, content). Director and copilot replies carry their own follow-ups
(`suggestions` in their output schemas), shown until the next message; the static bubbles only fill
in when nothing better exists. A bubble is a message the user sends (a request, or a question for the
director), never a question to the user. A project with no game yet (no goal, nothing plugged in: a blank
project) shows the start page's game ideas as the director's bubbles (`hasGame`), not changes: in 1.13 a blank
project's bubbles asked the user to define the core loop of a racing game, from a song they had tried in the
Audio dock. Smoke runs make no such call (`SHURIKEN_SMOKE`). Live check:
`E2E=suggestions` (one fast-model call). Their skills
(`COPILOT_SKILLS`): animation — roblox-animation-runtime, roblox-combat-feel, roblox-creature-ai; audio —
roblox-audio; UI — roblox-ui-design, roblox-game-hud, roblox-ui-references; effects — roblox-combat-feel. Each has a one-turn
live check with the real model (`E2E=copilot` for audio, `ui-copilot`, `animation-copilot`,
`effects-copilot`: a phone-ready shop on the Ui kit with server-checked purchases, an upper-body slash over
running with a server-timed hit, a hit burst).

Copilots stay in their field and make drafts first (1.10.2; the UI copilot's mockups of 1.9.1, made the rule
for all four after the effects copilot, asked for "a crazy vfx", playtested, synced code, ran Luau in Studio and
wrote a file). Two things are enforced in code, not in the prompt:
- *Domain only.* `COPILOT_TOOLS` (`copilot-roles.ts`) is the whole tool list of a copilot's run: `COPILOT_LOOK`
  (read-only: the project, code_query, skills, roblox_status/explore/inspect/search/console, store_search), its
  own workshop's tools, and the other workshops' lists it reads. No copilot has roblox_playtest, roblox_run_luau,
  roblox_call, a shell or another field's building tools in any turn, and none edits files, except the UI copilot
  in a put-it-in-the-game turn (Luau code only: `RoleDefinition.editOnly` = `UI_CODE`, checked by the runner's
  `decide`, which also refuses a built-in tool class the role doesn't have). Wiring a copilot's work into game
  code is the team's: the copilot gives the line that plays it and a `handoff` for the director. A call that
  reaches into another field through a tool the copilot does have is refused by `COPILOT_REFUSES`
  (`CallerContext.refuses`, checked first in `ToolRegistry.invoke`): the animation copilot asks Kiln for
  animation (`kind: "animate"` or `"fix"`, one model), never for a new or reworked model or a family.
  `tests/copilot-domains.test.ts` writes the lists out, checks each tool against the registry (permission
  `read`/`roblox_read`, or a capability of the copilot's own workshop; the only borrowed writers are rig_build
  for the animation copilot and roblox_sync_push for the UI copilot, both import-turn only) and compares them
  with what a run lists over MCP.
- *Drafts first.* Every message gets a turn mode (`copilots/intent.ts: turnMode`): `draft` unless it puts
  something in the game ("put it in the game", "add it", "use it for the sword hits", "replace the hit spark with
  this", "upload it", "remove X from the game", or a plain yes to the copilot's offer; "don't put it in studio
  yet" and "just a draft" keep it a draft). `copilotTurnRole(id, mode)` is the same role id and session with that
  turn's tools; the turn line in the prompt says which it is and, for an import turn, which drafts are meant
  (`importTargets`: named, on screen, or the last reply's). A draft turn's tool calls carry
  `CallerContext.drafts` (from `RoleDefinition.drafts`), and the workshop tools it has honour it: `vfx_create`,
  `animation_create`, `animation_import` and the audio tools save a draft (`draft: true` in
  `effects/<Name>.fx.json`, `animations/<Name>.anim.json`, the sound entry) and never build into Studio, upload,
  or write the runtime modules or builders into the game's code; a draft never takes a game item's name
  (`freeName`: HitSpark -> HitSpark2, Slash1 -> Slash1_2, with `draftOf`); `vfx_texture` doesn't upload;
  `*_remove` removes only drafts. The builders (`world/Effects.luau`, `world/Animations.luau`, `world/Audio.luau`)
  are written from `inGame()`. An import turn adds what brings the copilot's own product in: `vfx_use` (uploads
  its textures, builds it and the runtime), `animation_use`, `audio_use` (each with `as`: the game item it
  replaces), the builds, uploads and Studio checks of that workshop, and for animation Kiln (`kiln_request`,
  `kiln_clip`, `kiln_import`: Kiln's clips become the game's animations as it works, so asking Kiln is never a
  draft turn's). The UI copilot's turns are its design turn (mockups, their pictures and states, reference pictures,
icon and shape pictures: `ui_mockup_render`, `ui_reference`, `ui_icon` saving only) and its build turn (code, sync,
  `ui_audit`, `ui_mockup_audit {compare}`; `copilots/ui-intent.ts` finds the mockup and version meant).
Where drafts show: the effects preview (the Effects container and the Animation page's Effects tab), the
Animation page's mannequin or creature, the Audio page's player, the UI page's mockup board; Models have no
copilot (Kiln is theirs) and stay in Shuriken until Send to Studio. Each has its button — Add to game
(`effects.use`, `animations.use`, `audio.use`; Replace <name> for a new take) or the mockup's Put it in the
game — on the page and on the draft card under the copilot's reply (`data.drafts`, `data.mockup`, `data.mode`;
`renderer/lib/workshop-drafts.ts`). A draft turn's digest reaches the director as "Draft in the dock, not in
the game: …", and the director's state, the workers' context and the suggestion writer list dock drafts apart
from what the game has. The team's roles are not narrowed: the vfx-artist, sound-designer, animator,
ui-engineer and modeler build into the game as before (the ui-engineer builds a mockup the user picked, and
may sketch one first: `WORKSHOP_TOOLS.ui`).

**Send to Studio** (`core/roblox/studio-send.ts`). One click puts a dock's work into the open place:
models go where Studio's camera looks (a raycast from the camera target, placed on the ground, then
selected); an animation plays on a copy of its rig (or an R15 stand-in) through a small preview script
while the game runs; effects play. The Kiln dock calls it through `kilnHost.sendToStudio`.

**Plugging in a game** (`core/projects/adoption.ts`, `game-study.ts`; "Open a game…" on the start page
and in the Projects menu, `games.*` RPCs, main's `windows:adopt`). A place open in Studio (bound by its
name, place id kept) or a place file (opened in Studio where it is; a copy of the original goes to
`.shuriken/backups/`) becomes a project marked `extras.adopted`:
1. Its scripts are pulled out of every code service into files named the sync's way
   (`Name.server.luau` for any Script — the existing one keeps its RunContext —, `.client.luau`,
   `.luau`, `init` files for scripts with children), under `src/<Service>/…` (`adoptedSyncMap`; Shuriken's
   own generated modules go in `ReplicatedStorage/ShurikenShared`, first in the map). Scripts that can't
   be files (a sibling with the same name, case-insensitively; names Windows or the naming scheme can't
   hold) stay only in Studio and are listed. Send to Studio previews (`ShurikenPreview` attribute) are
   never files.
2. The files are committed as the baseline, the project instructions become the adopted-game rules
   (work with its structure and conventions, never rewrite what wasn't asked), and `.luaurc` is
   nonstrict (the game's code wasn't written for strict mode).
3. The study: a deterministic survey of the place (`SURVEY_LUAU`: service counts, remotes, UI, map,
   spawns, lighting, sounds, animations, tools, teams, tags, character settings), a code scan
   (libraries by module name, services used, lines worth a careful look: `require(<asset id>)`,
   `loadstring`, `getfenv`, obfuscated bytes, outgoing web calls), then the **analyst** role (read-only,
   deep tier) reads the code and returns the `dossier` result: summary, systems with files, conventions,
   risks, suggestions, chips and the director's greeting. It is saved as `.shuriken/dossier.json` and
   `dossier.md`; every agent's context has it (the `study` section), the director's state and every
   copilot's opening have its summary, and the director greets the user with what it understood. The
   director's `restudy` reads the game again after big changes made in Studio.
4. Its own animations can be edited: `animation_import` reads a KeyframeSequence (an Animation Editor
   save under AnimSaves, an Animation instance's asset, or an asset id the user owns, through
   KeyframeSequenceProvider) into a clip. A Pose's CFrame is the Motor6D.Transform Shuriken's clips are
   defined by (CFrame.Angles degrees + offset), so the conversion is exact (weight-0 poses, which only
   hold the pose tree, are skipped); the survey lists the place's KeyframeSequences.

**Code sync keeps Studio's side** (`core/roblox/code-sync.ts`, `merge3.ts`). Files are what the team
changes, but a push never overwrites a script someone changed in Studio. `.shuriken/sync/base.json` holds
each script's hash at the last sync (plus up to 8 older ones) and `base/` its text; each push leaves a
mark (`ServerStorage` attribute `ShurikenSync`). Before writing a script, the push compares Studio's
current text (`ScriptEditorService:GetEditorSource`, so open editors count) with the base:
- unchanged in Studio → written as before;
- changed in Studio, file unchanged since the last sync → the file takes Studio's version (`fromStudio`);
- changed on both sides → three-way line merge (diff3): kept both and pushed (`merged`), or, when the
  same or adjacent lines changed, conflict markers in the file (`conflicts`, an error for the agent);
  Studio keeps its version, and a file with markers is never pushed;
- deleted in Studio → an unchanged file goes too (kept in `.shuriken/sync/trash/`); a changed one is
  recreated, and the agent is told;
- scripts made in Studio since tracking began get files (`added`); orphans from before tracking stay
  orphans.
When the mark isn't the last one left (the place was reopened from an older save), a script matching
an older synced version is stale and overwritten, missing ones are recreated, and a push where most
scripts match nothing synced before pulls nothing ("is the right place open?"). An adopted game's
orphans are never deleted. Pushes to one project run one at a time; git changes run one at a time per
repository (`GitService.serial`). The line of pushes never ties up whoever holds Studio. The rule: what holds
the play-mode lease must not wait behind work that needs the lease to be free (a verification that took the
lease and then queued its sync behind agents' syncs, each waiting 6 minutes per Studio call for that lease,
froze a whole team five times in one build, about 115 minutes; `tests/verification-deadlock.test.ts`). So in
`CodeSync.push` a push for the lease's holder (verification, the world's rebuild) goes to the front of the
line; anyone else waits for Studio (lease free, Edit mode) *before* taking a place in line and steps out
again if Studio was taken meanwhile; and a push that has begun (`PlaytestLease.beginEdit`) runs its Studio
calls without waiting, while nobody is given the lease until it ends (`tryAcquire` refuses, `acquire` and
`acquirePlayMode` register as wanting so new pushes hold off): a playtest never starts in the middle of a
sync. A push that can't get Studio in time returns `busy`. The runtime pushes of `vfx_*`, `audio_*` and
`animation_*` go through the same call. An agent's sync leaves out the files other agents still running have
edited (`filesInFlight`: their Edit/Write calls in the audit), so it neither pushes their half-done work
into Studio nor merges Studio edits into a file someone is changing; their own sync brings them in. A
verification's sync follows the same rule (a check failed on another agent's half-edited file otherwise) and
names the files it left out in its result and its evidence (`leftOut`). Verified live in a scratch place: `E2E=adopt`.

**Kiln animation into Roblox** (`resources/blender/roblox_export.py`, `core/animation/kiln-clips.ts`,
`capabilities/kiln-tools.ts`). Kiln 0.7 rigs are one armature "Rig" (bones = joints) and clips are
Actions; Shuriken reads them only through Kiln's helpers (`kiln.rig.info()`, `kiln.anim.clips()`,
`kiln.anim.sample()`), which run in Kiln's Blender and in Shuriken's own (the helpers are synced,
byte-identical). The export puts the armature at rest, writes `models/<Model>.rig.json` (pivots, axes,
limits, legs, attachments in Roblox space; a second root hangs from a still one) and
`models/<Model>.clips.json`: each clip sampled at 30 fps, every joint's rotation (relative to its parent
and rest, world-aligned) turned into Roblox axes as CFrame.Angles degrees with its pivot offset — exactly
a Motor6D.Transform under rig_build's rig — keys reduced per joint (a key is dropped when slerp/lerp
between its neighbours reproduces it within 0.35° and 0.006 studs), events as markers. Skinned meshes
are cut into rigid pieces per dominant joint (smooth skinning later). Checked against Blender itself:
Shuriken's FK on the exported keys puts every bone tip where Blender has it (worst 0.035 studs over a
42-joint Griever's clips; `tests/blender.test.ts` re-checks a small rig). Publishing a model imports its
clips as project animations `<Model><Clip>` (R15 rigs: the clip's own name, no rig; Kiln's R15 rig roots
at a HumanoidRootPart bone, whose motion is folded into LowerTorso's pose — Roblox moves an R15 body
through its Root joint, never the HumanoidRootPart) marked with their
Kiln source; a changed clip (Kiln's fingerprint) is rewritten, a deleted one removed, others' clips never
touched; hit and death clips left at "Action" play at Action2/Action4. The bridge's scene fingerprint
includes the clips, so a clip change is a model change. Tools: `kiln_clip` (Kiln's generators, settings,
events and checks on a model in Shuriken's own Blender; on a Kiln 0.7.3 project only `check` works, the rest
is asked of Kiln), `kiln_request` (ask Kiln's copilot for a result, follow its turn, bring the result in), `kiln_import`, `kiln_clips`, `kiln_status`; Kiln's "Send to Studio" for an
animation imports the project and plays the clip on its rig in the open place. While the user animates a
linked model in Kiln, `KilnModeling.syncClips` (every 15 s; Kiln's `/anim` answers from memory, never
opening a project or calling Blender; copilot idle) compares Kiln's animation fingerprint with the one
last brought in and re-exports just the rig and clips
(`export_rig_clips`), so the Animation page follows along. Without uploads, `rig_build` makes a preview
rig from temporary meshes (EditableMesh), so a creature's clip can still be sent to Studio.

**Lean iterations** (`Orchestrator.submitIteration`, director intent `iterate`). Big features go through
research and the planner; a small, clear change (a tweak, a fix, a polish pass) the director specifies
itself as 1-6 steps (role, objective, acceptance criteria, dependsOn, check: playtest | screenshot |
none). They become an objective marked as an iteration whose tasks start at once through the same
`addTasks` path the planner's structured result uses (graph checks, static analysis and the critic
always, the Studio checks each step asks for). Its wrap-up is light: only its own tasks' checks
(never the global regression suite, which belongs to the main objective's wrap-up) and a checkpoint, no
milestone offer or report. Steps that don't hold together are planned
instead. Iterations run alongside a goal in progress.

## 13. Permission modes (1.9)

Two modes decide whether the team ever waits for the app's owner. **Autonomous** (the default): nothing waits
except spending money and publishing the game; the AI system decides, and says what it decided. **Ask**: the
behaviour from before 1.9, an approval or question card per escalation rule. The mode is `AppPrefs.permissionMode`
(`app-prefs.ts`; Settings → Agents → Permissions), overridden per project by `ProjectSettings.permissionMode`
(null/unset = same as the app; the same Settings page, "For this project"). `effectivePermissionMode(project, app)`
(`permissions/owner-gate.ts`) resolves it, `Core.permissionMode(project)` hands it to the tool gate, the shell gate, the
agent tools, the verifier and the orchestrator, and each reads it at the moment it decides, so a change applies at
once (cards already open stay until answered or dismissed; since 1.15.8 a card whose task finished closes by itself, §17). Hard denials (a project rule of `deny`, a destructive command that
reaches outside the project, a non-Shuriken MCP server) are the same in both modes.

**The one predicate that always asks** is `needsOwner(action)` in `permissions/owner-gate.ts`: pure, the same answer in
every mode, and the only place that defines what spending and publishing are. It answers for a capability-layer tool
call (a tool of permission class `spending` or `publish`, or code an agent runs through `roblox_run_luau`,
`roblox_call`, `cloud_luau_run`, `roblox_playtest` or `external_call` that calls `SavePlaceAsync`/`PublishAs`/
`StudioPublishService`, `PerformPurchase`, a Roblox publish or purchase endpoint, or, from `cloud_luau_run`, writes
the live game's DataStores or MessagingService), for a shell command (`npm publish`, `wally publish`, `rojo upload`,
`rbxcloud … publish`, a payment tool) and for the words of an agent's own `escalate` question (Robux, billing, a paid
service, publishing the game). `ToolRegistry.invoke` (`decideToolCall`), `decideShell` and the `escalate` tool all ask
it; a match becomes `ask` with `owner: true` in every mode, a project rule of `deny` still denies, and no rule,
mode or earlier approval turns it into an allow.

**What each former question becomes in autonomous mode** (ask mode keeps the card for all of them):

| Used to ask | Autonomous mode | Where |
|---|---|---|
| A tool whose rule said `ask` (`resolveToolDecision`) | Runs at once | `policy.auto_approved` on the timeline |
| A risky shell command (`decideShell`: `rm -rf`, `Remove-Item -Recurse`, `rd /s`, `git reset --hard`, `git clean -f`, `git push`…) | Runs only when `autonomousCheck` finds it safe: deletes whose targets resolve inside the project or the app's data folder (Git Bash's `/c/…`, WSL's `/mnt/c/…` and Cygwin's `/cygdrive/c/…` are drive C: `drivePath`; agents' throwaway files go in `.shuriken/scratch/`, git-ignored, which they are told about and may write and delete in), `git` on the project's repo; anything that reaches further (a parent folder, `$HOME`, a drive, `.git`, a variable it can't resolve, system commands such as `format`, `shutdown`, `diskpart`) is refused, not asked | `policy.auto_approved`, or `policy.denied` |
| The large-removal guard (25+ instances gone from the place) | Goes ahead; the checks and the critic review the result, the before/after snapshots stay in the task's evidence | `auto_resolved` approval |
| An agent's `spec_propose` on an approved section | Approved on the spot with the new text | `auto_resolved` spec change |
| An agent's `escalate` question | The director answers from the user's request (`answerQuestion`: a small run, 120 s, $1); with no answer the agent decides for itself and notes it (`DECIDE_YOURSELF`). A question about paying or publishing (`needsOwner`) still goes to the owner as a card | `auto_resolved` question |
| A task reported `blocked`, or out of attempts | Parked as `escalated`, and a small planner task "Decide: <task>" (`autonomy.ts`, priority 97, at most 2 per task) retries it with a different approach, replaces it (`plan_add_task` then `plan_cancel_task` with `replaced_by`) or drops it (what waited for it carries on). With no objective to hang it on: retried once with a note, then dropped; after 2 decisions it is dropped | `auto_resolved` blocked / failure, its response rewritten when the planner has decided (`setAutoResolution`) |
| A sign-in problem | An agent runtime that can't start: the attempt is refunded and runs are held with backoff (20 s doubling to 5 min), said once in the chat | `provider.environment` on the timeline |
| A manual verification check | Not asked: the automated checks and the critic review stand in | `auto_resolved` question |
| "Save the place in Studio" after world changes the save did not keep | Not asked: the place guard keeps trying and Studio's recovery copies are filed in the project | `auto_resolved` question |
| "Continue with the next milestone?" | Since 1.15.7 not asked in any mode: with the window's Keep building on (`ProjectSettings.keepBuilding`, Settings → Agents) the next milestone starts by itself, at most `MAX_AUTO_MILESTONES` (8) in a row, then one line says it stopped; off (the default) the build stops at the finished goal and one chat line says the roadmap has more | `auto_resolved` question (Keep building on) |
| "The regression suite keeps failing" | The checks that still fail after their repair are quarantined (retired with a reason) and the objective finishes | `auto_resolved` failure |

**Where decisions are recorded.** Anything that used to be an escalation card is written by
`GovernanceService.autoResolve` as an escalation with status `auto_resolved` (created and resolved together, `response`
= what was decided), with an `escalation.auto_resolved` timeline event. `setAutoResolution` rewrites the response when
the decision comes later (a planner's decision task). Such a record never fires `onEscalationResolved`, never counts as
"needs you", and shows in the director's chat as a plain status line (`autoResolvedLine`), not a card. The Agents
page lists them under "Decided without asking" (`escalations.list` with `status: 'auto_resolved'`, newest first,
grouped by day, each linked to its task's latest run; `renderer/lib/decisions.ts`). Tool and shell approvals are
timeline events (`policy.auto_approved`), not escalations. Tests: `tests/autonomous-mode.test.ts` (the gates),
`tests/autonomous-escalations.test.ts` and `tests/regression-loop.test.ts` (the escalations),
`tests/permission-settings-rpc.test.ts`, `tests/permission-prompts.test.ts`, `tests/renderer/permission-modes.test.ts`
and `tests/renderer/decisions.test.ts` (the Settings control, the list and the wording agents are told).

## 14. Shuriken Link: the Studio plugin (1.12)

**Why.** On 2026-10-01 Roblox switched on `FFlagAssistantCapsRestrictDataStore2`: code run through Studio's MCP server
(the Assistant's thread) lost five script capabilities (`AssetRequire`, `ScriptGlobals`, `DataStore`, `Network`,
`LoadUnownedAsset`) and can no longer parent a script anywhere, require a game module or fire an event. No Studio
update, no setting of the place or the experience changes it. 1.11.1 worked around it on the MCP path
(`roblox/probe-bridge.ts`: scripts created through `multi_edit`, probes run by a host script inside the playtest).
1.12 adds a way that is not on that path: a Studio plugin.

**What was measured** (a scratch place, Studio 0.741.19, a local plugin in `%LOCALAPPDATA%\Roblox\Plugins`):
- Edit: the plugin loads with no prompt and lacks no capability: it creates scripts with their `Source`, requires game
  modules, fires events, has `loadstring`. A call takes 3-20 ms.
- A playtest's server: the plugin runs there too (a separate instance per DataModel) with no capability missing, but
  without `loadstring`; code set as the `Source` of a ModuleScript and required by the plugin's thread runs with the
  plugin's rights, and may read `Script.Source` (7-17 ms).
- A playtest's client: the plugin runs but may not make HTTP requests ("can only be executed by game server"); the
  server instance relays its commands through a RemoteFunction (about 60 ms).
- HTTP to 127.0.0.1 needs no permission prompt for a local plugin, with HTTP requests switched off in the place.
- Refused to a plugin as well: `VirtualInputManager` (capability `RobloxScript`), so key presses and clicks stay with
  Studio's MCP tools (`roblox_input`). Screenshots, play start/stop and asset tools stay on MCP too.

**The pieces** (`src/core/roblox/link/`):
- `plugin.ts` — the plugin's Luau (one Script in an `.rbxmx`), generated with the key and the port range. In Edit it
  asks each port of `LINK_PORTS` (47811-47822) whether a Shuriken project has this place, stays linked to the core
  that claims it and looks again when that core lets go (every 6 s at first, then every 30 s). It leaves
  `port|studio id` as the attribute `ShurikenLink` on ServerStorage: a playtest's DataModels are copies that know
  neither their place's name nor their Studio window, and the server instance reads the mark to find its Edit
  instance's core. The client instance waits for the RemoteFunction `ShurikenLinkRelay` the server instance creates.
  In a place nobody claims the plugin runs no code.
- `link-server.ts` — a core's end: HTTP on 127.0.0.1 (the first free port of the range), three requests, all from
  the plugin: `hello`, `poll` (held up to 25 s until there is a command), `result`. Luau reaches Studio only from
  inside the core (`run`); nothing that arrives over HTTP is run. Commands of one session run in order, sessions run
  side by side (a server probe no longer stalls a client one). A command that times out or is cancelled has its
  thread stopped in Studio. A held poll whose connection drops ends the session after 2.5 s (Studio closed, the
  playtest stopped); `endPlay` ends a playtest's sessions at once.
- `studio-link.ts` — the service: the key (`link.json` in the app's data folder, shared by every core), the plugin
  file (written when missing or from another key or version; removed when the setting is off), which place is this
  core's (`binding`, the same "name contains" rule the MCP path uses, against `Name` or `Name (placeId: N)`), and
  following a renamed place.

**Who is who.** Both ends prove they hold the key without sending it: the plugin sends a nonce; the core answers with
its own nonce and SHA-256(key, both nonces, the port it listens on); the plugin checks that before it sends anything
else, then both derive the session's key (SHA-256 over key, nonces, session id), which every later request carries.
The port is in the proof so that a process on another port can't relay a proof it got from the real core. A hello
alone links nothing: a session is live with its first authenticated poll, so a caller without the key can neither
receive commands nor displace the real plugin. The core refuses requests with an `Origin` or `Referer`, another
`Host`, a non-loopback peer, or any method but POST (a web page can send none of what is needed). The plugin's
SHA-256 is its own Luau (Luau has no hash); the live test proves it against Node's.
What this does not defend against: a process running as the same Windows user can read the key file or drop its own
plugin into the Plugins folder; that was true before the link existed.

**Where it plugs in.** `RobloxStudioAdapter.callOnce`: `execute_luau` goes through the plugin when the place's
DataModel is linked (`luauViaLink`), else through MCP (`callMcp`) as before; everything above it (the playtest
lease, waiting for Studio's mode, `runAgentLuau`'s line numbers, the sync, the tools) is unchanged. A playtest's
sessions appear a moment after it starts: within 15 s of the start a call waits up to 5 s (server) or 8 s (client)
for its session before it takes the MCP path (`LINK_PLAY_WAIT`). The 1.11.1 workarounds stay as the way without the
plugin: `scriptsRestricted` asks the MCP path itself (`mcpOnly`), the probe hosts are put in until the plugin has
been seen inside a playtest of the place (`playProven`), and the sync's `multi_edit` fallback only runs when Luau
was refused. Agents are told which of the two holds (`studioRightsLine`, one line of their Capabilities).

**A published place is followed.** Studio reloads a place it has just published: the window's title and the name
its MCP server lists become the published place's, and the old Edit session ends. The new Edit instance says hello
with the studio id the mark carried (`prev`); when that is the id of the window that was this project's place and
no session matches the binding any more, the core claims it and `Core.followPlace` binds the project to the new
name, clears its place file (the published place saves to Roblox) and says so in the chat. `StudioRecovery` does not
take a place for gone while its Edit session is linked or was lost less than 15 s ago (`LINK_GRACE_MS`). Before,
a publish was taken for a crash: the file was reopened in a second window and the team built there.

**A window listed under the game's name** (1.15.8, `RobloxStudioAdapter.samePlaceById`). Studio's MCP server may list
the team's window as "Voxel Pit (placeId: N)" while its DataModel is still named after the place file: on 2026-10-07
for 50 minutes, every playtest and screenshot failing with "No open Studio instance matches", while the plugin, which
matches by `game.Name`, still worked. When no window matches the binding, one listed with the project's place id
(`extras.cloud.placeId`, or the id the plugin reports for the project's Edit session) is taken only when the window
itself answers `return game.Name` with the bound name (asked through Studio's MCP with its studio_id; the answer is
kept `SAME_DOC.freshMs`, and through a playtest for a window proven before, as a place is published and reloaded
only from Edit). A published copy (reloaded after a publish, or opened from Roblox) is named after the game and is
never taken; the "no instance" error says why. `StudioRecovery` and `Core.ensureStudio` ask the same, so that window
is neither taken for gone nor opened a second time. Tests: `tests/studio-place-id.test.ts`.

**A place opened by hand** (1.15.9, `RobloxStudioAdapter.linkOwnPlace`). A project is linked to a window when Shuriken's
own open of its place succeeds; on 2026-10-08 that open failed (Studio had moved with an update: `locateStudio` now
needs `RobloxStudioBeta.exe` in the registry's folder, and a launch of a missing exe throws `StudioMovedError` and
looks again), the user opened the place file by hand, and the project stayed "not linked". An unbound project now
links the one window listed under exactly its own place file's name (`projectPlaceFile`; the core saves it as
`robloxStudioMatch` and says so in the chat), from any call that resolves a window and from `Core.ensureStudio`. Any
other place, or two windows of the same file, is still never taken.

**Setting and state.** `AppPrefs.studioLink` (on by default; Settings → the Studio plugin toggle, with a status
line from `studio.link.status`); the health check "Shuriken Link (Studio plugin)". The link exists only in the real
app: tests and smoke runs (`integrations: false`, `SHURIKEN_SMOKE`, `SHURIKEN_NO_LINK=1`) write nothing into
Studio's Plugins folder and open no port. A Studio window loads plugins when it starts, so a window that was open
before the plugin was installed links after it is reopened; until then it works through MCP.

Tests: `tests/studio-link.test.ts` (the core's end, driven by a TypeScript twin of the plugin's requests:
`tests/helpers/fake-link-plugin.ts`), `tests/e2e/link.e2e.ts` (the real plugin in real Studio: handshake, Edit
rights, a first sync, a playtest's server and client, the sessions ending, a second playtest without probe hosts).
Not checked live: a publish being followed (the test would have to publish a place).

**Edit work during a playtest (1.13).** Studio's MCP server refuses Edit work in play mode, so every agent's code
sync and Edit Luau waited behind every playtest. The plugin's Edit instance keeps running during a playtest
(measured in Studio 0.741 with `tests/e2e/link-edit-in-play.e2e.ts`: 17 ms a call, 20 calls in 333 ms; a script's
source, a new script, a new part and a property changed in Edit stay out of the running game, are still there when
play stops, and the next playtest has them). So with the Edit instance linked (`RobloxStudioAdapter.editInPlay`):
`call` sends Edit Luau straight to the plugin without the wait for Studio's mode (and falls back to the wait if
Studio's own answer comes back, i.e. the link dropped); `waitForLease` is passed at once unless `strict` (a
playtest of one's own, `waitForEdit`, Studio's Edit-only tools, a task's checks); `CodeSync.push` skips
`waitForEdit` for anyone but the playtest's own holder; and `PlaytestLease.beginEdit` lets Edit work begin under
someone else's playtest. What must not happen is Studio copying the place for a playtest in the middle of a sync:
`setPlaying(true)` calls `beginPlayStart` (work under way finishes, none begins) until the start is over. Playtests,
screenshots and Studio's own tools (`multi_edit`, `insert_asset`, `screen_capture`, `search_game_tree`) still take
turns. Without the plugin everything waits as before. Since 1.15 a task's checks that neither play nor take a
picture (code sync, static analysis, Luau asserts in Edit) are Edit work too: `task_run_checks` waits non-strictly and
`Verifier.withStudio` (`editOnly`) takes no turn of play mode for them; in a 12-agent build such a run had waited up to
8 minutes behind every playtest.

## 15. The Storefront (1.15)

What sells a game on Roblox, made beside the build by three separate experts, each with its own role, tools,
skill and copilot (`core/storefront/`, `capabilities/storefront-tools.ts`), all kept in `.shuriken/storefront/`:

- **The store** (store designer, skill `roblox-monetization`, `store_catalog`): game passes and developer products
  in `catalog.json`, each with a key, kind, name, description, price, the benefit exactly as the game grants it, a
  category, where the game offers it, the icon's hue and subject, and whether it is a paid random item. The style
  follows the genre (`cosmetic` for skill-based competitive games: looks and status only; `fair`; `aggressive`), and
  `checkCatalog` points out an item that reads like an advantage in a cosmetic store. Every change writes the game's
  generated `ShurikenStore` module (`store-luau.ts`, next to the game's shared code): the items with their Roblox ids
  (0 until pushed), the game's only `ProcessReceipt`, pass checks on join and on purchase (a player attribute the
  client reads), `Store.onPass` / `Store.onProduct` for the engineers' grants, a purchase ledger the game keeps in the
  player's save (`Store.useLedger`; its `add` returns false when it couldn't save, and the purchase is asked again),
  `Store.otherReceipts` for a game that sold products before (receipts this store doesn't know go to its handler),
  and Studio test purchases (in a playtest only) for items not on Roblox yet, so the whole flow is built and tested
  before anything is pushed. Passes and products are looked up apart, and keys are written `["Key"]` (a key Luau
  reserves is refused). The module is written from `applied.json`, the store as last put in the game:
  `saveCatalog`'s `apply` names whose changes go in (the team's and the user's own edits for the items they touched,
  a push for the items it pushed, "Put it in the game" for all, a copilot's draft for none), so a draft stays out of
  the game also when someone changes another item meanwhile. The engineers write the grants; the UI designer the shop
  and the offers.
- **The words** (copywriter, skill `roblox-store-copy`, `copy_write` / `copy_get`): the title and description in
  `copy.json` with the versions before them, and the items' shown names and descriptions; `checkCopy` keeps Roblox's
  limits and refuses anything that points off Roblox. The user puts the title and description on Roblox by hand.
- **The pictures** (thumbnail artist, skill `roblox-store-art`): `thumb_shot` captures the place in Studio from a
  staged camera (Edit view, the game's UI hidden, a field of view, Highlight outlines on the subjects for the picture
  only; `shotSetup` / `shotTeardown` put everything back), `thumb_compose` draws a 1920x1080 thumbnail or the
  512x512 icon in the UI mockup format with the mockup renderer, `thumb_pick` has a judge that didn't make them (the
  `thumb-judge` role, a quick app-level call with the pictures) eliminate the candidates round by round, and
  `store_icons` draws every item's icon from one template (`{subject}`: a game model drawn with an outline or a
  glyph, `{text}`, `{hue}` in any colour), so the set is consistent. The user saves the thumbnails and the icon as PNG
  (`file:saveAs`, only PNGs under a project's `.shuriken/storefront/art`) and uploads them.

**Switches.** `AppPrefs.monetization` and `AppPrefs.copy` (Settings → Storefront, both on by default) are the only
switches: the planner reads them in the environment line (`storefrontLine`) and plans a store-designer task right
away, the store's code, shop and icons after it, a copywriter task beside the build, and one thumbnail-artist task
near the end; no game task depends on copy or art. With both off nothing of it is planned or shown (the tools say so,
the dashboard's container and the page's tabs go).

**Pushing to Roblox** (`store-push.ts`, `open-cloud-store.ts`): only the user's word. The Storefront page's Push to
Roblox sends the confirm list as the user saw it, each item with its hash: one changed since (an agent, a copilot) is
left for another look. The director pushes only when `asksStorePush` finds, in one sentence of the user's own message,
a push word and a store word (or the store "on Roblox") with no "don't"/"not"/"wait" and not as a question; "create a
VIP pass" is a design request, a copilot's handoff passed on is not the user's word, and a hands-off message clears
`storePush`. It pushes the items the message names (`namedItems`, by key or shown name), else every one not on
Roblox. Each draft or changed item is created or updated through the Open Cloud game pass and developer product APIs
(multipart, with its icon; the game must be published: its universe is read from the open place's `game.GameId`; the
key needs those APIs' write permission) and saved at once into the catalog as it is then (an id Roblox gave is never
lost to a save made meanwhile), with the universe it went to: a push into another game than the store's is refused.
An icon's content hash is part of the item's, so a redrawn icon is a change to push. Nothing else on the page
publishes anything: thumbnails, icon, title and description are the user's to upload.

**The page and the copilots.** The Storefront page (`renderer/pages/storefront.tsx`, dashboard container under
Quality) has a tab per expert, each with its own copilot (`store`, `copy`, `thumbnails` in `copilot-roles.ts`). A
copilot's draft turn changes the design only (`CallerContext.drafts`: the catalog saves, the game's module stays as
it was, `Storefront.moduleBehind` says so); the store's "Put it in the game" (`storefront.apply`, or the copilot's
`store_module` when the user says so) writes and syncs the module. No copilot pushes to Roblox. Tests:
`tests/storefront.test.ts`, `tests/renderer/storefront.test.ts`; the generated module and the shot's Luau pass selene
and luau-lsp.

## 16. Matchmade games (1.15.2)

A game played in matches (PvP rounds, duels, arenas, team modes, ranked play) is built as **one place with two roles**
(`core/match/`, `capabilities/match-tools.ts`, skill `roblox-matchmaking`). Public servers of the place are the
lobby; a reserved server of the same place is a match (`game.PrivateServerId ~= "" and game.PrivateServerOwnerId ==
0`). Chosen over a lobby place and an arena place because those need several Studio windows per project (Roblox's
login lock hung every Studio after a second one: the reason play windows were removed in 1.13.8) and the hop between
places can't be played in Studio; a separate match place can be added later without changing the game's code.

**The module** (`match-luau.ts`, written by `match_setup` from `.shuriken/match/config.json` into the game's shared
code, renewed on open when an older runtime wrote it). The lobby keeps a sorted map in MemoryStore per mode
(`ShurikenQueue_<Mode>`: one entry per player or party, its users, server, rating and join time as the sort key,
expiring after 2 minutes unless its server renews it). One lobby server at a time holds the `leader` lock (a hash map
entry it renews every 4 s) and forms matches: oldest entry first, then others that fit (a party stays together; for a
ranked mode, ratings within a window that widens with the wait and is gone after `maxWaitSec`), or after `botsAfterSec`
whoever is there with bots in the empty places. For each match it reserves a private server
(`TeleportService:ReserveServer(game.PlaceId)`), keeps the record (mode, access code, teams by user id, bots) in the
`ShurikenMatches` hash map with a key per player for rejoins, removes the entries, and publishes on MessagingService to
the lobby servers holding the players, which send them with `TeleportAsync` (retried). The match server reads its
record by the id in the teleport data and trusts nothing else a client could send: unknown players go back to the
lobby; it starts when everyone is there or after `startTimeoutSec`, with `bots` for the missing. `Match.finish`
clears the record and sends everyone to a public server; `BindToClose` does the same. The game writes only what a
match is (`Match.onStart`, `onPlayerLeft`, `onPlayerJoined` for a rejoin, `Match.finish(match, results)` after it
saved them), its ratings (`Match.useRating`), and the lobby UI from `Match.state` / `Match.notice` on the client.

**Studio.** Teleports only work in a published game, and Shuriken never publishes. In Studio the module uses no
MemoryStore, MessagingService or teleport: a queue gathers for 2 s and starts a test match in the same server
(`match.test`, the empty places as `bots`), and `Match.finish` fires `Match.returned(players, results)` there. The
same game code runs in both, so agents playtest the whole loop. Checked: selene and luau-lsp (strict, Roblox's types)
on the module and a game using it; `tests/e2e/match.e2e.ts` plays it in real Studio. Not checked: the live path
(MemoryStore, reserved servers, MessagingService), which needs a published game.


## 17. The director's word and the planner's memory (1.15.8)

Audited across six projects (2026-10-02 to 10-07), the director said the team was stopped when it had just resumed (16
replies), claimed actions that didn't happen, sent a "verbatim" message cut at 300 characters, repeated a stale card in
about 21 replies, and needed four or five messages to wrap a build up. What changed:

- **Cards** (`director/cards.ts`, `GovernanceService.dismiss`): a card has a `dismissed` status (closed without an
  answer: its task is left as it is; an answer would re-queue it). A card closes by itself when its task is done,
  cancelled or replaced (`Orchestrator.attach`, `task.updated`; a goal's own "save the place" card excepted), and open
  cards of finished tasks close when the project opens. The chat card has a Dismiss button (`escalations.resolve` with
  `dismissed`). The director's state lists each card with its id, its buttons, its task and status, and how often its
  replies already mentioned it (`timesSaid`); `cards: [{card, action: dismiss|answer, answer}]` in its output clears or
  answers one, only when the user's own words do (`asksClearCard`, `pickedOption`).
- **Run state**: after the user's stop, a request is planned now (its planning job is run at once, `runNow`) but its
  tasks wait for "resume", "start", "continue", "go" or "do it now" (`asksResume`); "resume when the plan is ready"
  sets `extras.resumeWhenPlanned` and the orchestrator resumes when that plan is done. Every reply is checked against
  the real state after the app has acted (`reconcileRunState`).
- **Truth of actions**: the app carries out the actions first; when one didn't happen (a task not found, a refused or
  failed push, a card the user's words didn't clear) the reply is rewritten by a one-turn pass (`DIRECTOR_FINAL`).
  Verbatim requests carry the user's stored message exactly (`requestFor`); the user's last three messages are in the
  director's state in full. One reply at a time per project: messages that arrive meanwhile are answered together
  (`Director.drain`). Sentences already said in two of the last six replies are dropped (`dropRepeats`); replies are
  about 600 characters unless the user asks for detail.
- **Controls**: `tasks` gains `start` (run a task now, even while stopped: "resume just X"); `resume: true` with any
  intent; `wrapUp` (`Orchestrator.wrapUp`: cancel what hasn't started, no triage, polish, look or final regression run
  until the next request); `agentLimit` (this window's `agentCap`); `remember` (a standing instruction into the
  planner's notes); stopping "the final review" (`Orchestrator.stopFinalCheck`). A stop says how many runs are still
  finishing; a resume says which tasks the user paused stay paused. The state says why ready tasks wait
  (`Orchestrator.whyWaiting`) and gives the game's name from Studio (`extras.cloud.name`, never "Place2"); at a usage
  limit the answer comes from the records (`statusNow`), and the message is kept (`extras.heldMessages`, 1.15.9): the
  held messages go first in the next batch, tried a minute after the reset the error names (every 10 minutes when
  it names none, at least every 30), 5 s after another account is chosen and 20 s after the project opens; a retry
  that meets the limit again says nothing new, and the director is told when they were written.
- **One planner per project** (`orchestrator/planner-session.ts`): planning jobs run one at a time (decisions, the
  user's plan updates, triage, polish, in priority order) and continue the project's planner session; each job's
  message (`plannerBrief`) has the job, the planner's notes and what changed since its last turn (the user's messages,
  tasks finished, failed, cancelled, added, cards). A fresh session (full context package) after an app update, 48 h,
  25 jobs or a failed resume. The session is a cache under rule 4: the tasks, spec, decisions and notes are the record.
- **The planner's notes** (`orchestrator/planner-notes.ts`, `.shuriken/planner-notes.md`, tool `planner_notes`, a
  priority-96 section of every fresh planning package): the user's standing instructions and decisions to keep.
- **Planning effort**: decisions and triage run at medium (`RoleDefinition.ownEffort`), plans at the planner's setting.
- **QA switch**: `ProjectSettings.autoQa` false (Settings → Agents, per window): `plan_add_task` refuses QA-only tasks.
- **Autonomous decisions**: a decision never drops a task the user asked for or put first (`autonomy.ts usersOwn`,
  `plan_cancel_task`); a question about Studio's playtest turn gets the facts (`aboutStudioTurn`), never "release the
  lock"; a failure that only says Studio wasn't there gives the attempt back (up to three times, `STUDIO_AWAY`).

## 18. Reference footage and pictures (1.15.8)

The user gives Shuriken a clip of a game whose feel they want (combat, movement, a UI) or a picture (concept art, a
UI screenshot); Shuriken samples the frames, measures the sound, and one agent run writes a study the planner, the
specialists, the critic, the director and the docks build from (`core/references/`, `capabilities/reference-tools.ts`,
`main/media-decoder.ts`, `renderer/src/media-page.ts`, `pages/references.tsx`; types and limits in
`shared/references.ts`).

**Storage.** `<project>/.shuriken/references/<id>/` (git-ignored, `LATER_IGNORES`): `reference.json` (the record:
kind, name, the user's file name, size, status, stage and error, duration and size, frames with their times and why
they were taken, cuts, palette, the sound's summary, spectrograms, the study's summary/takeaways/tags/cost),
`original.<ext>` (a copy; the user's file stays where it is), `frames/`, `audio.pcm` (16-bit mono at 22,050 Hz) and
`audio.json` (the full measurement), `spectrogram-NN.png`, `preview.*` (a picture's copy for the model) and `study.md`.
Caps: a video 1 GB, a picture 20 MB, 40 per project; the sound of a file over 600 MB or past 15 minutes isn't measured.
Status: queued → decoding → measuring → studying → ready, or `measured` (no study: safe mode and smoke runs start no
agent; "Write the study" later) or `failed` with the reason. One analysis runs at a time (`ReferenceService`); an
analysis the app closed on reads as stopped (`settled`). Removing a reference stops its analysis and deletes its folder.

**Decoding happens in Chromium.** The core can't decode video, so it asks the main process (`media` message, like
`render`; `CoreOptions.media`), which runs the request on a hidden window loading the renderer's `?media` page
(`MediaHost`). The page can't read files: the file is served on the `shuriken-media://` scheme (registered as
privileged before the app is ready), only in that window's session, only while its request runs, under a random
token, with byte ranges (seeking) and CORS (so the canvas may read the pixels). The page seeks a `<video>` and copies
frames with a canvas (JPEG, 768 px on the long side); a MediaRecorder WebM's unknown length is found by seeking past
its end; the sound is decoded with `OfflineAudioContext.decodeAudioData` at the measuring rate, mixed to mono, and
handed to main in 4 MB pieces (`__mediaAudioChunk`). Pictures are drawn to a canvas (at most 1568 px; PNG when
transparent). Without a decoder (plain Node, tests without the fake) a PNG or baseline JPEG is still read in the
core; a video fails with that reason. Checked in a real Electron with clips the page records itself (MP4 H.264/AAC
and WebM VP9/Opus): `scripts/references-selftest.ts`.

**Measuring** (pure: `audio-features.ts`, `frames.ts`, `spectrogram.ts`). Frames: up to 240 tiny scan pictures (every
0.5 s, or spread over a long clip) find the cuts (a jump in the colour histogram and pixels well above the clip's
usual motion, a peak of its own, a second apart) and the palette; then up to 60 frames: up to 30% right after cuts, up
to 20% at the loudest hits, the rest spread evenly (one a second when it fits), each with its time and reason; the
coverage is said in words. Sound, from the PCM: the RMS envelope (100 ms), integrated loudness (BS.1770,
`measureLoudness`), loudness range, silence share (under -50 dBFS), onsets (spectral-flux peaks placed in the
waveform to about 2 ms), a tempo estimate (autocorrelation of the flux, the beat and its double, leaning to 120,
refined at four beats; null under 0.15 confidence; it can read half or double), bass/mid/high shares and centroid
over time, and the loudest hits (peak, jump ("out of silence" past 40 dB), decay, low/mid/bright) each paired with its
nearest frame. Spectrograms: 15 s strips, log frequency with guides at 100/1000/5000 Hz, the level lane, onset ticks
and hit marks, a seconds ruler. Speech is not transcribed, anywhere.

**The study** (`REFERENCE_ANALYST`, role `reference-analyst`: the worker tier (deep by default), high effort, 8
turns, $3 budget, tool `reference_view` only, output `reference_study`). It is shown 28 frames (`pickForStudy`: the
loudest key moments, then the frames that fill the gaps) and up to 6 spectrograms, each picture preceded by its
caption ("Frame at 12.40 s (at a loud hit)": `AgentRunRequest.images[].caption`), and a brief with what the frames
cover, the other frames' times, the cuts, the palette, the sound's numbers and its loudest hits with their frames, the
user's game, and the limits. It writes what the game is, camera and controls, UI and HUD, combat and movement feel
with timings read from the frame times (wind-up, impact, recovery, hit-stop, knockback), VFX and animation, world and
art style, pacing, sound, what to take (concrete, with numbers) and what not to copy (another game's names, logos,
art). `study.md` is its markdown under a header saying how it was made and above the measured facts.

**Use.** The context package of every compiled run (planner, workers, critic) has a "Reference footage and pictures
from the user" section (priority 82, about 3,200 characters): every reference with its summary, and the takeaways of
the three that matter most to the role (`ROLE_TAGS`) and the task's words (a reference the task names comes first);
the planner is told to name a reference (id and seconds) in the tasks that build what it shows. `reference_list` and
`reference_view` (capability `app.references`, permission read, its limitations recorded in the capability registry)
are seen by the planner, the critic, the director's looking pass (`LOOK_TOOLS`), the dock copilots (`COPILOT_LOOK`) and
the specialists whose work a reference shows (`REFERENCE_TOOL_ROLES`: not QA, security, performance or copy).
`reference_view` gives the study and a spread of frames, the frames in a time range, new frames at up to 30 fps in a
window of up to 4 s (`detail`, kept with the reference, 160 at most), the sound with the hits in a range and its
spectrogram, or the picture (with the `ui_reference` path for the UI roles). The director's state lists the
references and where each stands (`directorLines`); each dock's state lists the ones for its field.

**UI.** The References page (the top bar's film icon; `references@<id>` opens one): add files with the button or by
dropping them anywhere on the page; each reference's status (a spinner while it works, the failure's reason), the
limits said plainly (frames are samples, sound is measured not heard, speech isn't transcribed, the study is one agent
run and what it cost), the study, the frames (cuts and hits marked; click for a large one), the palette, the sound
(loudness, peak, range, silence, tempo, hits a minute, balance, the level graph with the hits, the hits with their
frames, the spectrograms); Analyze again, Write the study / Study again, Remove. A video or picture dropped on the
director's chat is added as a reference (the core's status line in the chat follows it; a refusal is said there); a
video dropped on a dock's chat is added as a reference, while pictures stay attachments.

**Tests.** `tests/reference-audio.test.ts` (clicks found within 5 ms, click tracks at 90 and 120 bpm, no tempo in
noise, silence share, balance, loudness, a low thump ranked over clicks, spectrogram PNGs),
`tests/reference-frames.test.ts` (scan plan, cuts against a camera pan, the frame plan and its cap, the study's
picks, pairing hits with frames, palette), `tests/references.test.ts` (the pipeline through a real Core with a fake
media page and a scripted analyst: what the analyst is shown, `study.md`, the tools and who sees them, detail frames,
the context package, the director's lines, refusals, no sound track, a stopped analysis, removal, a picture, no
decoder, safe mode, the self-test), `tests/renderer/references.test.ts`. Not covered by unit tests: Chromium's
decoding (the self-test script and the smoke recipe below) and a study by the real model.

**Checking it in the app.** Smoke (no agents run, so no study: status `measured`): build (`npx electron-vite build`),
write a seed file `[{"method":"references.selftest","params":{"seconds":8}},{"method":"references.selftest","params":{"seconds":6,"container":"webm"}}]`
and run `electron . --smoke --smoke-open <empty folder> --smoke-rpc-file <seed> --smoke-views references --smoke-out
<dir>` with `SHURIKEN_DATA_DIR` set to a scratch folder: `report.json`'s rpc results hold both references (about 120
bpm, a low hit at the first cut, a cut near 3.5 s and 6 s, frames) and `references.png` shows the page. Without
Claude, Studio or Kiln at all: `scripts/references-selftest.ts` (its header says how; `SELFTEST_FILE` runs real
clips through it). With the real analyst (one run): a dev build on a scratch project, add a real gameplay MP4 on the
References page, then read `study.md` and the next run's context package.

## 19. Big projects stay responsive (1.15.8)

Measured on a copy of a 1,250-task, 860-model, 300-sound project (`--smoke-profile` writes the page's
`cpu.cpuprofile` and the core's `core.cpuprofile`; `report.json`'s `perf` lists every RPC's count, time and size,
and the main log names every call over 300 ms):

- The core has one thread, and every page waits on it. `TaskGraph` keeps every task as last read while nothing has
  written the tasks or their links: a temp trigger counts this connection's writes (`temp.task_writes`, taken back
  with a rolled-back transaction) and `PRAGMA data_version` another connection's commits. Callers get copies; a
  filtered read of a stale list still goes to SQLite; nothing is kept inside a transaction. `runnable()` (every
  state report) reads only ready tasks in full.
- `ModelStore.get` keeps each model file while its time and size are unchanged (copies again).
- Sound and effect usage (which scripts play what) tests a sound's patterns only on files that contain its name: the
  per-sound regexes over every script were 9 s of the core's thread when a big project opened.
- The UI's task lists ask `tasks.list` with `slim: true` (`core/tasks/slim.ts`): no checks or acceptance criteria,
  600 characters of objective, 300 of result (the unseen-looks line kept). A task's page reads `tasks.get`.
- The place viewer keeps its batch materials between rebuilds (a new material per rebuild compiled every shader
  again: seconds frozen after each change in Studio) and skips a rebuild when the rows read the same as last time.
  Release builds don't read every shader's compile log (`renderer.debug.checkShaderErrors`). Dashboard tiles
  (the mannequin, the effects preview, the model turntable) draw 30 frames a second.

## 20. Builds stay out of the user's way (1.16.1)

Many people work at the same PC while builds run, often in a Studio of their own. Measured with three builds open: every
start and stop of an agent's playtest brought that Studio to the front (six of six, 0.2-2 s after the request), and a
game with a shoulder camera (`MouseBehavior.LockCenter` every frame) pinned the user's real cursor to the middle of the
screen for 22-27 s per agent playtest, even with that Studio behind other windows. So the mouse is freed while the user
uses the PC, agent Studios stay behind the user's windows and anything Studio grabs is handed back, and agent playtests
are silent.

- **The focus guard** (`roblox/studio-window.ts` `StudioFocusGuard`): one hidden PowerShell per place window that always
  knows which window the user is in. Around an agent's play start or stop (`arm`), Studio taking the foreground gives it
  straight back (about 30 ms); a switch the user made (a press on another program's window, Alt or the Windows key) is
  theirs. The user's own playtest from the app (lease owner `ui:`) is not guarded.
- **The mouse** (`FreeStep`, `RobloxStudioAdapter.agentPlay`, `LUAU_MOUSE_FREE_CLIENT`): while an agent's playtest runs,
  the guard says "FREE 1" when the user has used the keyboard or mouse in the last 3 minutes (`UNATTENDED.idleMs`) and
  isn't in that Studio's window, "FREE 0" otherwise. The adapter sets `ShurikenMouseFree` on the playtest server's
  ReplicatedStorage, and a watch Shuriken Link put in the playtest client puts `MouseBehavior` back to Default after the
  game's camera each frame and whenever it changes. Away from the PC the game keeps its lock, so the agents' mouse-look
  checks work as the game means.
- **Sound** (`AUDIO_HELPER`, Windows' per-program Core Audio sessions): while an agent's playtest runs and that Studio
  isn't the window in front, the guard mutes that Studio's sound, re-applied about once a second (a session exists only
  once the program plays something); it is unmuted when the playtest ends, when the user brings that Studio to the front,
  and when the guard ends (its input closes with Shuriken).
- **Studio opening** (`openPlace(…, { background: true })`, `OpenStep`): a reopen after a crash and a build's own open
  send a new Studio that comes to the front behind the user's window again, until the user picks it themselves. An open
  the user asked for comes to the front as before.
- **The save** (`pressSaveInMenu`): its File menu, which takes the foreground for a fraction of a second, also waits for
  no mouse button to be held (a camera drag in the user's own playtest), as well as for a pause in typing.

Tests: `tests/studio-focus-guard.test.ts` (the adapter's side, simulated Studio), the C# helpers compiled and asked in
`tests/studio-unattended.test.ts`, and `tests/e2e/studio-quiet.e2e.ts` (E2E=quiet): a stand-in "Studio" built on the
spot (a program named RobloxStudioBeta.exe playing silence) and the real guard. It is muted while its playtest runs
behind other windows, FREE follows the user's activity, and its sound comes back after. With QUIET_FOCUS=1 a stand-in
that pulls itself to the front is sent behind and the user's window gets the foreground back.

**Shortcuts to side-by-side versions (1.16).** Some keep each version in a folder of its own
(`…\Versions\Shuriken Studio <x.y.z>\Shuriken.exe`). Windows Search and the Start menu open the Start menu's shortcut,
and an install or a hand edit updated only one shortcut, so Search kept opening an old version. On start, a packaged
Shuriken (`main/shortcuts.ts`) rewrites (`shell.writeShortcutLink` `replace`, app id kept) every Start menu or Desktop
shortcut that opens an older such copy to open itself; an older version never moves them, and the installer's own
layout (one folder, no version in its path, updated in place) is never touched. `scripts/shortcuts-check.mjs` checks it
in real Electron.

## 21. The databases and the viewer (1.16)

- **Write-ahead logs reach their files** (`db/store.ts` `checkpoint`). The SQLite databases run in WAL mode, and a
  global.db once kept weeks of changes (the projects index, settings, the knowledge base) only in its `-wal`, its main
  file not written since; a hard stop of the app lost the log and all of it. `Store` now checkpoints with TRUNCATE when
  it opens and closes, and the core checkpoints the global and the open project's database every 5 minutes, warning
  when a reader held pages back. `tests/store-checkpoint.test.ts`: a copy of the file alone has every row.
- **The viewer's grey rectangle** (`renderer/src/components/scene/placement.ts` `partMatrix`, `MIN_DRAWN`). The viewer
  reads part sizes rounded to 0.01 stud, so a 0.001-thick part (a flat lens, a decal sheet, a glass pane) arrived 0
  thick: its instance got a zero scale, three.js's instanced normals divide each normal by the squared column lengths
  (a division by zero, NaN shading), and `UnrealBloomPass` spread the NaN through its mip chain into a block over the
  view (the canvas goes see-through there and shows the panel behind it). Every part is now drawn at least `MIN_DRAWN`
  (0.001, Roblox's own minimum) in each axis, and a size that is not a number as that.
  `tests/renderer/viewer-zero-thickness.test.ts`.
