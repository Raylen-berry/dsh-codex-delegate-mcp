# DSH → Codex Delegate MCP

A governed stdio MCP server that lets DeepSeek Harness (`dsh`) delegate work to Codex on the same machine. As of 0.2.0 the engine is Codex's **own** `codex mcp-server` (tools `codex` / `codex-reply`), and this file is a thin governance proxy in front of it.

Why not mount `codex mcp-server` directly: on that server the *model* chooses `sandbox` (the enum includes `danger-full-access`), `cwd` (any path on the machine), `config` (a free-form object that overrides any Codex setting, including MCP servers) and `base-instructions`. Mounting it as-is hands a privilege knob to the delegated agent — or to anything it reads. The proxy takes only prompt, workspace, mode and thread, pins `approval-policy: never`, and never forwards `config`/`base-instructions`/`model`.

It does not expose the current Codex desktop conversation. It uses the Codex account and configuration already available to the local CLI.

## Safety defaults

- The default tool mode is `read-only`.
- The server only accepts the directory where `dsh` was started, or a descendant of it.
- `workspace-write` is disabled unless the DSH patch explicitly sets `CODEX_DELEGATE_ALLOW_WRITE: 'true'`.
- `danger-full-access` is never available.
- The server uses stdio; it does not open a network port.

## Pre-release check (same command in CI and locally)

Every push / PR runs `.github/workflows/ci.yml`, which does exactly one thing: `npm test`.
That is the same command you run locally — **no dependencies, no network**:

```bash
npm test                       # = node tools/run-all.mjs
node tools/run-all.mjs --list  # list what runs, what is excluded, and why
```

`tools/run-all.mjs` runs every suite to completion before summarizing, so one broken suite never hides
the next; any non-zero suite makes `npm test` exit 1, which turns CI red.
CI runs a Node 20/22/24 matrix on `windows-latest` (the suite is written platform-agnostically —
`process.execPath` + `os.tmpdir` + `path.join`, no shell — but only Windows was actually measured
on this machine, so no unverified runner was added).

Measured locally (Node 24.9.0):

| Suite | Local result |
| --- | --- |
| `tools/verify-engine-restart.mjs` | 3 passed (fake engine = a `mcp-server` script this suite writes itself; real Codex is never called) |
| `tools/verify-runs.mjs` | 58 passed (same fake-engine trick, plus a scenario file; covers the run ledger and cancel/resume/retry) |
| `tools/verify-config-drift.mjs` | 19 passed (checks the drift checker against synthetic configs in a temp dir + one read-only run over the real pair) |

Nothing is excluded in this repo. All suites are offline: `CODEX_BINARY` points at `node` itself and the
fake engine is a script the suite writes into its own temp workspace, so no model is called and no
network is touched. `tools/run-all.mjs` fails the whole run if a new `tools/verify-*.mjs` is not
registered in its `SUITES` list, so a suite cannot be added silently.

**Test isolation is asserted, not assumed.** The ledger defaults to
`$DSH_HOME/dsh-codex-delegate-mcp/runs/`, and the suites start a *real* `server.mjs` that inherits this
process's environment — so a local `npm test` wrote fake delegation records into the user's real data
directory once (measured 2026-09-14: 24 rows of the restart fixture leaked into the live ledger). Two
independent guards now prevent that:

1. `tools/run-all.mjs` runs every suite with
   `CODEX_DELEGATE_RUNS_DIR=<os.tmpdir()>/dsh-codex-delegate-runs-selftest-<pid>`, so a suite — including
   one added later — cannot reach `$DSH_HOME` even by omitting it. Each of the two suites that start a
   bridge also sets that variable itself, so running a single file directly is equally safe.
2. After the suites finish, `run-all.mjs` re-reads the **real** `$DSH_HOME/dsh-codex-delegate-mcp/runs/`
   and compares file-level sha256 against the snapshot taken before them. Any added, removed or changed
   file makes the whole run exit 1. When that directory does not exist (CI), it reports "not applicable"
   rather than failing.

### Reverse verification of the run ledger

`CODEX_SERVER=<path to another server.mjs> node tools/verify-runs.mjs` points the *same* assertions at a
different build. Measured against the pre-0.3.0 `server.mjs` materialized from `git HEAD` in a temp
`git worktree`: **14 passed / 34 failed, exit 1** — the old build has no run records at all, so every
record assertion fails. (Report the failure count, not "the suite is green": the 14 that still pass are
the ones whose subject exists in both builds, such as a `DELEGATION FAILED` header still being present,
or a secret-absence check that trivially holds when nothing was recorded.)
## Get it

The public repository is `dsh-codex-delegate-mcp`; clone it and the folder name
becomes the repo name, not the `dsh-codex-delegate-mcp` shorthand used in the
examples below. Clone it anywhere, then adjust two machine-local facts in
`dsh-codex-delegate.cordis.patch.yml`: the `args` path to `server.mjs`, and
`CODEX_BINARY`, which must point at a real `codex` executable (an `.exe`; on
Windows a `.cmd` shim fails a shell-less stdio spawn). `CODEX_DELEGATE_ROOT` and
`CODEX_DELEGATE_WRITE_ROOT` are pinned to one root for the bridge's whole
lifetime — widen or move them to change the scope.

## Enable in DSH

The folder location and the interpreter path are baked into the patch, so keep this folder where it is on
this machine: `D:\DeepSeek\dsh-codex-delegate-mcp` (see "Get it" above for a fresh clone elsewhere).

For a terminal / CLI run:

```powershell
dsh web --patch .\dsh-codex-delegate-mcp\dsh-codex-delegate.cordis.patch.yml
```

For a terminal/headless run:

```powershell
dsh --profile headless --patch .\dsh-codex-delegate-mcp\dsh-codex-delegate.cordis.patch.yml "Use mcp__codex__delegate_to_codex to inspect this workspace and summarize its purpose."
```

For **DSH Desktop** (the app builds its own argv, so `--patch` is not reachable): put the same `- insert:` block
into the profile's user patch layer `%DSH_HOME%\profiles\web\cordis.patch.yml`. That layer is watched and
**re-applied on save — no restart needed** (it re-applies on a config diff, not on mtime; see "Reloading" below).
That is the route used on this machine. Validate the composition without booting anything:

```powershell
dsh web --dump-config --patch .\dsh-codex-delegate-mcp\dsh-codex-delegate.cordis.patch.yml
```

DSH will discover the tool as `mcp__codex__delegate_to_codex`.

In DSH, make the delegation explicit, for example: `请委派给 Codex：检查当前项目的测试失败原因，只读分析。` The bridge does not take over this Codex desktop conversation; it starts a fresh local Codex CLI task.

## Machine-local corrections verified on 2026-09-04 (codex-cli 0.148.0-alpha.9)

> Historical: these three bugs belonged to the `codex exec` engine and are gone in 0.2.0, where Codex's own MCP server is the engine. They are kept because they explain why the wrapper exists at all — and item 4 (a real executable for `command`, plus `CODEX_BINARY`) still applies.

The original package could complete an MCP handshake but never a real delegation. Three defects, all fixed in `server.mjs`:

1. `--sandbox <mode>` and `--approve-for-me` are mutually exclusive, so every call died with `exit=2` before Codex started. Now `read-only` pins `--sandbox read-only` and `workspace-write` uses `--approve-for-me`.
2. `spawn()` inherited an open stdin pipe. `codex exec` appends stdin as a `<stdin>` block and waits for EOF, so the call hung until the timeout killed it. Now `stdio: ['ignore', 'pipe', 'pipe']`.
3. A non-zero exit or timeout was reported as a *successful* tool result. Now it is returned with `isError: true`.

Two configuration corrections in the patch (not in `server.mjs`): `command` must be a real executable — on this machine `node` on `PATH` resolves to a `.cmd` shim, and a stdio spawn without a shell fails on it — and `CODEX_BINARY` must point at `C:\Users\Administrator\.codex\plugins\.plugin-appserver\codex.exe`, because `codex` is not on `PATH` here.

`CODEX_DELEGATE_ROOT` is pinned to `D:\DeepSeek`: the bridge accepts one root for its whole lifetime, so it cannot follow whichever workspace a session opens. Change it there to widen or move the scope.


## Allow edits

Write mode is **fenced, not global**. Two envs decide it:

| env | effect |
| --- | --- |
| `CODEX_DELEGATE_ALLOW_WRITE` | master switch; `'false'` refuses `workspace-write` before any spawn |
| `CODEX_DELEGATE_WRITE_ROOT` | optional narrower root. When set, a write call whose `workspace` is outside it is refused **before spawning**, and the recorded `cwd` / `workspace_roots` are re-checked against it afterwards |

So "open the write gate" need not mean "free to write anywhere under the read root". The live config on this machine runs `ALLOW_WRITE: 'true'` with `WRITE_ROOT: <workspace>\DeepSeek子代理`: Codex may write into the deliverables folder and nowhere else. To withdraw write capability, set `ALLOW_WRITE: 'false'`. Bump `CODEX_BRIDGE_REV` after either change, or the running child keeps the old environment.

One nuance to read correctly in a result: a **fresh** write run uses `--approve-for-me` and reads back `Approval: on-request`; a **resumed** write run must use `-c approval_policy="never"` (because `exec resume` accepts no approval flags) and reads back `Approval: never`. Only the second is fully unprompted.

## Activity: what Codex did, not just what it answered

`codex exec --json` would cost the policy header, so the bridge keeps the plain invocation and reads Codex's own rollout record (`$CODEX_HOME/sessions/**/rollout-*<session-id>.jsonl`) for the turn that just ran. Every result then carries:

```text
Steps: 10

Codex activity:
  $ exec: const r = await tools.shell_command({command: "Get-ChildItem …"…
  → result: Script completed Wall time 0.3 seconds Output: Exit code: 0 …
```

The last 14 steps (each truncated to 240 chars) are returned; pass `include_activity: false` to drop the block. This is also where the safety read-back comes from: `turn_context` records `sandbox_policy.type`, `approval_policy`, `cwd`, and `workspace_roots` per turn, so the bridge compares the *recorded* policy against the requested one and fails the call on a mismatch or on any root outside the allowed root — instead of trusting what it asked for.

One practical side effect of watching the activity: Codex's shell child runs PowerShell in **ConstrainedLanguage** mode, so `[PSCustomObject]@{…}` and .NET static calls fail there. Phrase delegated prompts with cmdlets and core types, or expect a wasted round trip.

## Multi-step delegation

Each result opens with a read-back block:

```text
Codex completed the delegated task.
Session: 01a07fef-4494-76d3-b674-9ae5821898ec
Workdir: D:\DeepSeek
Sandbox: workspace-write [workdir, /tmp, $TMPDIR]
Approval: never
Model: gpt-5.6-luna
Tokens: 17956
Next step: pass resume_session: "01a07fef-..." to continue this exact conversation.
```

Pass that id back as `resume_session` to continue the **same** Codex conversation instead of starting a fresh one — the follow-up sees what Codex already read and wrote. Sessions live in `$CODEX_HOME/sessions/rollout-*<id>.jsonl`, so a resume survives a bridge restart; deleting those files does not.

`codex exec resume` accepts neither `--sandbox`, `--approve-for-me`, nor `--cd`, so a resumed run pins its policy through `-c sandbox_mode=...` (plus `-c approval_policy="never"` for writes), and the bridge then **verifies the policy from codex's own header**: a mismatch — or a `workdir` outside the allowed root — fails the call instead of reporting a success.

## Reloading after editing server.mjs

The harness spawns the bridge once, at mount. Editing `server.mjs` alone changes nothing, and touching only its mtime changes nothing either: the layer re-applies on a **config diff**. Bump `CODEX_BRIDGE_REV` — in the **live** copy under `%DSH_HOME%\profiles\web\cordis.patch.yml`, past whatever value it already has — to force the stdio child to respawn and pick up new code. The repo template's copy of that key is documentation; see "Which copy of the config actually takes effect" above, and use `tools/check-config-drift.mjs` to see whether the two copies currently agree.

## Verified on 2026-09-04, through DSH's own MCP client (codex-cli 0.148.0-alpha.9)

| Case | Result |
| --- | --- |
| handshake + `tools/list` | pass |
| `workspace` outside the allowed root | refused before spawning |
| `workspace-write` while the gate is off | refused before spawning |
| read-only delegation + policy read-back | pass, `Sandbox: read-only` |
| `resume_session` context continuity | pass — recalled a value from the earlier turn |
| write delegation | pass — file created with the requested bytes, checked on disk |
| write + resume | pass — same session id, `Approval: never` in force |
| codex argument error / timeout | reported as `isError: true` with `DELEGATION FAILED` |

Cost note: one delegated run persists a ~60–80 KB `rollout-*.jsonl`, and `--ephemeral` is deliberately not used because it would break `resume_session`. Delete old rollouts to reclaim space.


## Requirements

- Node.js 20 or newer
- DeepSeek Harness CLI (`dsh`) with `@deepseek-ai/dsh-mcp-client` available
- Codex CLI authenticated on the same machine

No npm package installation is required for this MCP server itself.

## Which copy of the config actually takes effect (and why the repo one is only a template)

On DSH Desktop the bridge is mounted from **`%DSH_HOME%\profiles\web\cordis.patch.yml`** — the profile's
user patch layer. `dsh-codex-delegate.cordis.patch.yml` in this repo is a **template**: editing it mounts
nothing by itself. It is useful for `--patch` CLI runs, for `--dump-config` validation, and as the
documented shape of the block.

That means two hand-maintained copies of one block, which drift — measured on 2026-09-14: the live file
was already at `CODEX_BRIDGE_REV: '14'` (untouched since 09-11) while this repo still said `13`, so
"aligning the repo to 14" produced **no config diff** and the host would not have respawned the stdio
child — the new tools would simply not appear. Two rules came out of it:

- **Bump `CODEX_BRIDGE_REV` in both copies** whenever `server.mjs` changes behavior, and bump it *past*
  whatever the live copy currently says. Equal values mean no diff, and no diff means no remount.
  (Remounting restarts the resident engine, so open `threadId`s die with `Session not found`.)
- **Check for drift instead of trusting the copies.** `tools/check-config-drift.mjs` is a read-only
  comparison of the two files' key values (including `CODEX_BRIDGE_REV`):

  ```powershell
  node tools\check-config-drift.mjs                 # 0 = consistent / 1 = drift / 2 = usage problem
  node tools\check-config-drift.mjs --live <path> --template <path>
  ```

  A key written in one copy but omitted in the other counts as equal (≈) only where the omitted value is
  the built-in default — which is why `CODEX_DELEGATE_RUNS_DIR` shows as ≈ and not as drift. This check
  is what a "config is actually applied" doctor step should own; until `dsh-doctor` exists, this script
  is that check. `tools/verify-config-drift.mjs` asserts the checker itself (19 assertions, all against
  synthetic copies in a temp dir) so a wrong verdict cannot pass silently.

## 0.2.0 — engine semantics (measured 2026-09-08)

**Threads live in the engine process.** Codex's `mcp-server` keeps a conversation in memory, so the proxy holds one persistent engine instead of spawning per call. A per-call process made every `codex-reply` fail with `Session not found` — that was the first thing this version had to fix. Consequences to know:

- bumping `CODEX_BRIDGE_REV`, or anything that remounts the row, restarts the engine and invalidates open `resume_session` ids; the bridge says so explicitly in that error.
- concurrent delegations multiplex over the one engine by JSON-RPC id; Codex tags its `codex/event` notifications with `_meta.requestId`, so a call only ever sees its own run.

**Policy is read from the event stream, not inferred.** The engine emits `session_configured` with `permission_profile`, `approval_policy`, `cwd`, `model` and `rollout_path`. The proxy compares that against what was asked and **cancels the running turn** on a mismatch (`notifications/cancelled`), so an over-privileged run stops instead of being reported after the fact. `codex-reply` does not re-emit the event, so a resumed turn is vouched for by the ledger entry recorded when its thread was created; a thread the ledger doesn't know is reported unverifiable.

**Activity comes from the same stream**: `item_completed` for `CommandExecution` (argv + exit code + output), `FileChange` (the whole patch), `WebSearch`, `McpToolCall`, plus `token_count` total usage and the account rate-limit window.

| Case | Result |
| --- | --- |
| read-only delegation, policy read-back | pass — `Sandbox: read-only`, `Approval: never`, `Steps: 2`, command argv and exit code shown |
| resume the same thread | pass — answered from context, `Sandbox: read-only (vouched from creation)` |
| resume a read-only thread as `workspace-write` | refused before spawn — `created with mode "read-only"` |
| `workspace-write` inside the write fence | pass — Codex created the file itself, `Workdir` = fenced dir, patch shown in activity |
| `mode: danger-full-access` | refused — `never available through this bridge` |
| engine hygiene | 1 proxy + 1 engine, no leftovers |

**Cost note, measured**: a fresh thread on the official engine starts at ~22k tokens even for a one-command task, because `mcp-server` loads the skills and plugin context into every new session (`codex exec` cost 574 tokens for the same trivial prompt). Resuming is incremental (a second turn showed 33k total against 22k at creation). For many tiny pings the older `codex exec` path is cheaper; for anything multi-turn or write-scoped this one is worth it.

## Reverse hand: Codex → DSH (`dsh-inbound-mcp.mjs`)

Codex has no ACP client, so the way in is the other half of the same protocol pair: this bridge **is an MCP server that Codex mounts**, and it speaks ACP to `dsh --profile acp` — the supported automation surface for driving a persistent DSH agent.

Tools exposed to Codex: `dsh_run(task, cwd?, timeout_seconds?)`, `dsh_reply(session, task)`, `dsh_sessions(limit?)`. One persistent `dsh --profile acp` child serves them all, and unlike Codex threads, ACP sessions survive a bridge restart (`session/list` / `session/resume`).

Mount it from a Codex config layer (`$CODEX_HOME/<name>.config.toml`, used with `codex exec -p <name>`):

```toml
[mcp_servers.dsh]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["D:\\DeepSeek\\dsh-codex-delegate-mcp\\dsh-inbound-mcp.mjs"]
cwd = "D:\\DeepSeek"
startup_timeout_sec = 20
tool_timeout_sec = 900
default_tools_approval_mode = "approve"
env_vars = ["DSH_DELEGATE_DEPTH", "DSH_INBOUND_ROOTS", "DSH_HOME", "PATH", "HOME", "USERPROFILE", "SystemRoot", "COMSPEC", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "CODEX_HOME"]

[mcp_servers.dsh.env]
DSH_INBOUND_ROOTS = "D:\\DeepSeek"
DSH_HOME = "C:\\Users\\Administrator\\AppData\\Roaming\\dsh-desktop\\harness"
```

Two Codex defaults cost me a failed round each, so take them literally:

- **`default_tools_approval_mode`** — an MCP tool call wants approval and `codex exec` has nobody to ask, so the call dies as `user cancelled MCP tool call` (stderr `mcp: dsh/dsh_run (failed)`) while the bridge is perfectly healthy. Easy to misread as a bridge bug.
- **`env_vars`** — Codex does not hand an MCP child its full environment. Without `DSH_DELEGATE_DEPTH` in that list the bridge reads depth 0 and the recursion guard silently never fires. The bridge now prints `Delegation depth seen by this bridge: N` in every result so this can't fail quietly again.

### Two-tier mounting (decided 2026-09-08)

The same `[mcp_servers.dsh]` block now lives in **both** places, with different approval modes on purpose:

| Where | Approval | Effect |
| --- | --- | --- |
| Codex base `config.toml` | `default_tools_approval_mode = "prompt"` | any interactive Codex session sees the tools, and **each** `dsh_run`/`dsh_reply` asks the human first — an injection-driven automatic call stalls in front of the user |
| `-p dshreverse` overlay | `"approve"` | unattended `codex exec -p dshreverse …` keeps working without a human at the keyboard |

Rationale: merging into the base config makes the reverse hand reachable from *every* Codex session, which is exactly the surface you do **not** want callable silently by file contents (prompt injection). `prompt` in the base layer makes it loud; the overlay re-opens it for automation you explicitly start. Delete the `[mcp_servers.dsh]` block from `config.toml` to withdraw entirely (backup: `config.toml.bak-before-dsh`).

### Audit trail

Every inbound call appends one JSON line to `dsh-inbound-audit.jsonl` next to the bridge (override with `DSH_INBOUND_AUDIT`, disable with `'none'`): timestamp, depth, tool, workspace, task head (200 chars), reply head, ok/blocked. Both a successful run and a guard refusal are recorded — this is the "who asked for what, when, and what happened" log to review when a session acted on its own.

### Ring break, two independent layers

DSH → Codex → DSH → Codex has no bottom unless something refuses. Two separate things refuse:

1. **Depth marker.** The forward bridge spawns Codex with `DSH_DELEGATE_DEPTH = own depth + 1`. The inbound bridge refuses any call at depth ≥ `DSH_INBOUND_MAX_DEPTH` (default 0) unless `DSH_INBOUND_ALLOW_NESTED=true`, and the refusal states its own reason so it can't be mistaken for a crash.
2. **Composition.** The inbound bridge starts `dsh --profile acp`, and the `acp` profile does not carry the `mcp-codex-delegate` row (verified with `dsh --profile acp --dump-config`). An inbound DSH agent has no `mcp__codex__*` tool to reach for, guard or no guard.

### Permission for inbound work

Measured here: an inbound task runs **workspace-writable** inside the requested `cwd`, which must sit inside `DSH_INBOUND_ROOTS` — a delegated DSH agent created `reverse-write-check.txt` with no approval round-trip. Anything beyond that arrives as a `*_request_permission`, which the bridge answers **deny** plus a `NEEDS USER APPROVAL (denied by bridge): …` line so it reaches a human; the bridge never escalates on its own. Honest caveat: that deny path is implemented but was never exercised, because no inbound agent asked.

| Case | Result |
| --- | --- |
| Codex calls `dsh_run`, DSH agent counts files | pass — `RESULT=ok`, agent ran a real `pwsh` tool call, answer `4` matched an independent count |
| same call at `DSH_DELEGATE_DEPTH=1` | refused — `recursion guard: ... depth 1 (limit 0)`, `RESULT=blocked`, `mcp: dsh/dsh_run (failed)` |
| inbound write inside the root | pass — file created by the inner DSH agent, content checked on disk |
| MCP boot without `default_tools_approval_mode` | failed with `user cancelled MCP tool call` (documented above) |
| guard without `env_vars` | silently depth 0 → guard never fires (documented above) |

## 0.3.0 — run ledger: 批次 / 当前步骤 / 失败原因 / 产物 + 取消 · 续跑 · 仅重试失败项

Every `delegate_to_codex` call now leaves **one queryable record**. The ledger is an added side channel:
`delegate_to_codex`'s input schema, sandbox policy, error wording and result body are unchanged, except
for one added header line `Run: <runId> [status/kind]`.

```text
Codex completed the delegated task.
Run: 4c95c806-3070-4ff9-af4d-670806c329e0 [succeeded/completed]
Thread: 01a07fef-4494-76d3-b674-9ae5821898ec
…
Steps: 3
Artifacts: 1 (C:\Users\…\AppData\Roaming\dsh-desktop\harness\dsh-codex-delegate-mcp\runs)
```

### Where it is stored

`$DSH_HOME/dsh-codex-delegate-mcp/runs/YYYY-MM-DD.jsonl`, overridable with `CODEX_DELEGATE_RUNS_DIR`;
if neither `DSH_HOME` nor that variable is set (bare CI, a hand-started bridge) it falls back to
`<os.tmpdir()>/dsh-codex-delegate-runs`.

One JSONL file per day, and **every state change appends a line** — the same `runId` written later wins.
So a run in progress is already readable (`running`, with the steps so far), and a process killed
mid-run leaves a complete readable file rather than a half-written JSON. A record that outlives the
bridge process simply stays `running`; nothing repairs it afterwards. Files older than 14 days are
pruned on the next list. There is no writer lock: the bridge process is the only writer in practice.

### What a record contains

| Field | Meaning |
| --- | --- |
| `runId` | one per delegation; `retry_codex_run` creates a **new** one and points back via `parentRunId` |
| `batchId` | optional `batch_id` argument on `delegate_to_codex`, purely a grouping label |
| `status` / `kind` | `running` · `succeeded` · `failed` · `cancelled`, plus a machine-readable reason kind |
| `steps` / `stepCount` / `currentStep` | the digest of the same `codex/event` stream the result header already summarizes |
| `artifacts` | workspace paths Codex actually touched (from `file_change` events), or paths seen in command activity |
| `error` | `{kind, detail}` — the failure/cancel reason as recorded |
| `startedAt` / `finishedAt` / `durationMs` | wall clock; while running, `finishedAt` is `null` |
| `threadId` / `resumedFrom` / `resumable` | the Codex thread this run used, and whether it can still be continued |
| `engineGeneration` | the bridge engine's generation for that run, reset to `0` when the engine retires — the number answers "was an engine live, and is this the one a later restart replaced", not "how many engines has this process ever started" |
| `promptChars` / `promptHead` | length, plus the **first 200 characters only**, redacted |
| `result` | tail of the final text, token total, rate-limit window |
| `workspace` / `mode` / `timeoutSeconds` / `pid` | the request as the bridge pinned it |

`kind` is one of: `timeout`, `policy`, `client_cancel`, `engine_lost`, `tool_error`, `thread_lost`,
`refused` (the bridge refused before spawning), `completed`.

### Three new tools (two read-only, one that runs Codex again)

| Tool | What it does |
| --- | --- |
| `list_codex_runs {limit?, status?, batch_id?}` | most recent runs, newest first, one line each |
| `get_codex_run {run_id}` | one record in full: status, kind, failure detail, steps, artifacts, times, thread, resumability |
| `retry_codex_run {run_id, prompt, timeout_seconds?, include_activity?}` | continues that run's thread (`codex-reply` with the **recorded** `threadId`) and records a new run pointing back at it |

A refusal (a workspace outside the allowed root, `workspace-write` while the gate is off, a thread
resumed under a different mode) also leaves a record — `failed/refused`, with no thread and no steps —
and its error text now leads with `Run: <id> [failed/refused]` so the record is findable. The original
error wording is unchanged below that line.

The bridge also emits an MCP notification `notifications/tools/run` after each run settles. It is a
notification, not a request: a client that does not know it (including DSH's own bridge today) drops it,
so **nothing is pushed** — the three tools are the way to read the ledger.

### Cancel · resume · retry-only-failures: what actually works

Nothing new was invented for cancelling. The three cancellation paths already existed; the record now
names them instead of reporting them as generic failures.

| Capability | Support level | Mechanism / limit |
| --- | --- | --- |
| **Cancel** (timeout) | works | the bridge's own wall clock: on `timeout_seconds` it sends `notifications/cancelled` and lets the caller settle, recorded as `cancelled/timeout`. `codex` has no per-turn cancellation that waits for confirmation, so the turn may keep running inside the engine — the record says "we stopped waiting and told it to stop", not "Codex stopped" |
| **Cancel** (policy mismatch) | works | `session_configured` reports a sandbox/approval/cwd looser than requested ⇒ same cancel path, recorded as `cancelled/policy` |
| **Cancel** (client) | works, rarely used | an MCP `notifications/cancelled` for an in-flight `tools/call` is mapped to that call's `runId` and recorded as `cancelled/client_cancel`. The transport-level cancel is what DSH itself has never sent, so this path is exercised by the test suite, not by daily use |
| **Cancel** (explicit "stop run X now" tool) | **not supported** | there is no `cancel_codex_run`: cancelling from the record would need a new kill path, and the repo has none today |
| **Resume** | works while the engine lives | `retry_codex_run` re-declares nothing — it replays the recorded `threadId` into `codex-reply`, and the original `workspace`/`mode` are reused and re-checked (a resume can never widen them). Codex threads live **in the engine process**, so after an engine crash, or a `CODEX_BRIDGE_REV` bump that remounts the child, the reply fails with `Session not found` and the new run is recorded as `failed/thread_lost`. Records do not survive the bridge process as resumable threads |
| **Retry** (one run) | works | `retry_codex_run {run_id, prompt}` retries the single run you name, recording lineage through `parentRunId` |
| **Retry only the failed items of a run** | **not applicable here** | one delegation is exactly **one prompt, one turn** — there is no multi-item list to select from. `steps` are a *digest of what Codex did*, not addressable work items, and re-running a step is impossible: a step is a command Codex already ran inside its own turn. So "only the failed items" collapses to "retry the single failed run" (above). If you need per-item retry, the granularity has to come from the caller: give each item its own `delegate_to_codex` call with a shared `batch_id`, then list that batch and retry the runs whose `status` is `failed`/`cancelled` one `runId` at a time |
| Push updates while a run is in progress | **not supported** | records are written during the run, but only when something happens (event digested, run settles); a run that produces no events writes nothing, and no client is notified unless it understands `notifications/tools/run` |
| Per-step retry, run cancellation, cross-restart threads | **not supported** | as above |

Credential hygiene is unchanged and mechanical: every string written to the ledger goes through the same
`redact()` used for tool results (`Bearer …`, `sk-…`, `api_key/token/secret = …`), the full prompt is
never stored — only its length and a redacted 200-character head — and the `verify-runs` suite asserts
that no `Bearer`/`sk-`/`api_key=` plaintext reaches the file.

Measured end to end with the fake engine (`tools/verify-runs.mjs`, 58 assertions): a successful
delegation produces a complete record; a tool-layer error is `failed/tool_error` with the engine's own
text; a hung engine is `cancelled/timeout` after the bridge's clock; a killed engine is
`failed/engine_lost` (and the next delegation reconnects); a client cancel is
`cancelled/client_cancel`; a retry reuses the recorded `threadId` in `codex-reply` and links back via
`parentRunId`; `list_codex_runs` is newest-first; and the ledger contains no credential plaintext.


