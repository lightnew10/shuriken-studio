# Session journals

Every time Shuriken Studio runs, the main process writes a journal of that session to
`%APPDATA%\Shuriken Studio\sessions\<date>_<time>_<pid>\` (or `$SHURIKEN_DATA_DIR/sessions`). Smoke runs
are not journaled. Nothing leaves the PC.

| File | What is in it |
|---|---|
| `summary.md` | Duration, projects, counts (chat, agent runs, tasks, errors, restarts, account switches, limit waits) and **Needs attention**: failed runs, tasks that needed several attempts or failed, questions the user had to answer, regression failures, critic rejections, core restarts, renderer crashes, user interventions (stopping work, changing the plan). Rewritten every ~15 s and at exit. |
| `events.jsonl` | Every recorded event, one JSON object per line: `{ ts, source: main\|renderer\|core, kind, data }`. Kinds include `session.start/end/abandoned`, `nav`, `app.open`, `start.send`, `start.suggestion`, `project.open`, `chat.user`, `chat.director`, `run.started`, `run.finished`, `task.done`, `task.failed`, `escalation`, `account.switched`, `limit.wait`, `core.restart`, `renderer.crash`, `cli.prompt`, `error`. |
| `chat.md` | The conversation between the user and the director, readable. |
| `errors.log` | Errors from main, core (error-level logs, scheduler errors) and the renderer (uncaught errors, rejected promises), with stacks. |
| `screens/` | JPEGs of the window: the first dashboard view, every finished objective. |
| `session.json` | Metadata and the counters, kept current. |

A session that never wrote `session.end` (crash, kill, power loss) is marked `session.abandoned` the
next time the app starts, and its summary says so.

## Reviewing sessions (for developers and Claude Code)

```bash
npm run sessions               # list sessions with counters
npm run sessions -- --last     # latest session: summary, flags, errors, chat, screenshots
npm run sessions -- <id> --timeline  # its agent runs in order (start, length, turns, cost) and time per role
npm run sessions -- --flags    # everything flagged as sub-par, across sessions
npm run sessions -- --errors   # every error, across sessions
```

When improving the app, start here: read the latest sessions' **Needs attention**, then open the
matching agent runs (the project's `.shuriken/project.db`, the Agents page) to see what the agents saw
and did. Per-run detail (context package, transcript, tool calls with arguments and results) lives in
the project database and in `.shuriken/context/`.
