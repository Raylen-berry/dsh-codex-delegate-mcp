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

## Enable in DSH

The folder location and the interpreter path are baked into the patch, so keep this folder where it is:
`D:\DeepSeek\dsh-codex-delegate-mcp`.

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

The harness spawns the bridge once, at mount. Editing `server.mjs` alone changes nothing, and touching only its mtime changes nothing either: the layer re-applies on a **config diff**. Bump `CODEX_BRIDGE_REV` to force the stdio child to respawn and pick up new code.

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


