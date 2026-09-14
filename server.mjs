#!/usr/bin/env node
/*
 * DSH → Codex delegate bridge (official MCP-server engine, governed).
 *
 * The engine is Codex's own `codex mcp-server`, which exposes `codex` and
 * `codex-reply` plus a `codex/event` notification stream. This file is a
 * governance proxy: it is the MCP server DSH mounts, and it is a one-shot MCP
 * client to Codex per delegated call.
 *
 * Why a proxy and not a direct mount: on `codex mcp-server` the model chooses
 * `sandbox` (the enum includes danger-full-access), `cwd` (any path on the
 * machine), `config` (a free-form object overriding any Codex setting, MCP
 * servers included) and `base-instructions`. Mounting it directly hands the
 * delegated agent — or anything it reads — a privilege knob. Here those fields
 * are never taken from the caller: only prompt, workspace, mode and thread.
 *
 * 0.3.0 起本桥还给每次委派记一条**可查询的运行记录**（run ledger，见 runs.mjs）：
 * runId / 状态 / 步骤 / 失败原因 / 产物 / 起止时间 / threadId，并由此派生出
 * 查询（list_codex_runs、get_codex_run）与续跑/重试（retry_codex_run）两个入口。
 * 记录是**新增**的旁路：delegate_to_codex 的入参、出参与沙箱语义一个字节都没动，
 * 只在结果头里多一行 `Run: <runId>`。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  RUNS_DIR,
  RUN_RETENTION_DAYS,
  RUN_STATUSES,
  artifactDigest,
  describeRun,
  getRun,
  listRuns,
  openRun,
  redact,
  stepsDigest,
  updateRun,
} from './runs.mjs'

const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_TIMEOUT_SECONDS = 900
const MAX_PROMPT_CHARS = 120_000
const OUTPUT_LIMIT = 32_000
const PROTOCOL_VERSION = '2025-03-26'
const BRIDGE_VERSION = '0.3.0'
const RUN_LIST_MAX = 50

const allowedRoot = path.resolve(process.env.CODEX_DELEGATE_ROOT || process.cwd())
const allowWrite = process.env.CODEX_DELEGATE_ALLOW_WRITE === 'true'
const writeRootEnv = process.env.CODEX_DELEGATE_WRITE_ROOT || ''
const writeRoot = writeRootEnv.length > 0 ? path.resolve(writeRootEnv) : ''
const codexBinary = process.env.CODEX_BINARY || 'codex'

/**
 * Delegation depth, carried through the environment so it survives every hop.
 * The Codex engine we spawn sits one level below a DSH agent; the reverse
 * bridge (Codex -> DSH) refuses to serve at that depth, which is what breaks a
 * DSH -> Codex -> DSH -> Codex cycle.
 */
const delegationDepth = Number.parseInt(process.env.DSH_DELEGATE_DEPTH || '0', 10) || 0
const engineEnv = { ...process.env, DSH_DELEGATE_DEPTH: String(delegationDepth + 1) }

function isInsideBase(base, candidate) {
  const relative = path.relative(base, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isInsideRoot(candidate) {
  return isInsideBase(allowedRoot, candidate)
}

function resolveWorkspace(value) {
  const workspace = path.resolve(value || allowedRoot)
  if (!isInsideRoot(workspace)) {
    throw new Error(`workspace must stay inside the allowed root: ${allowedRoot}`)
  }
  return workspace
}

function getMode(value) {
  const mode = value || 'read-only'
  if (mode !== 'read-only' && mode !== 'workspace-write') {
    throw new Error('mode must be read-only or workspace-write; danger-full-access is never available through this bridge')
  }
  if (mode === 'workspace-write' && !allowWrite) {
    throw new Error('workspace-write is disabled; set CODEX_DELEGATE_ALLOW_WRITE=true in the DSH MCP configuration after reviewing the scope')
  }
  return mode
}

/** Writes must land inside CODEX_DELEGATE_WRITE_ROOT when one is configured. */
function assertWriteScope(workspace, mode) {
  if (mode !== 'workspace-write' || writeRoot.length === 0) return
  if (!isInsideBase(writeRoot, workspace)) {
    throw new Error(`workspace-write is confined to ${writeRoot}; "${workspace}" is outside it`)
  }
}

function assertThreadId(value) {
  const thread = typeof value === 'string' ? value.trim() : ''
  if (!/^[0-9a-fA-F-]{16,64}$/.test(thread)) {
    throw new Error('resume_session must be a threadId returned by an earlier result ("Thread: <id>")')
  }
  return thread
}

function truncate(value, limit = OUTPUT_LIMIT) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n\n[truncated]`
}

function oneLine(value, limit) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

const liveChildren = new Set()
/*
 * 运行记录需要区分两种"运行中途断了"：
 *   · 引擎进程没了（被 kill / 崩溃 / 起不来）⇒ 运行被**中断**，记为 failed/engine_lost
 *   · 客户端显式发了 notifications/cancelled  ⇒ 记为 cancelled/client_cancel
 * 两者在 callEngineTool 里都会以 `engine exited` 的 reason 落地，光看 reason 分不出来，
 * 所以这里留一个"哪些请求是被客户端取消的"标记，在记录收官时消费掉。
 */
const clientCancelledCalls = new Set()

function killLiveChildren(reason) {
  for (const child of liveChildren) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Read the sandbox mode out of a Codex `permission_profile`. A managed profile
 * with a writable filesystem entry is workspace-write; read-only entries are
 * read-only; anything else (absent/`disabled`) is full access.
 */
function sandboxFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return ''
  if (profile.type === 'managed') {
    const fileSystem = profile.file_system && typeof profile.file_system === 'object' ? profile.file_system : {}
    const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries : []
    const writable = entries.some((entry) => typeof entry?.access === 'string' && entry.access.includes('write'))
    return writable ? 'workspace-write' : 'read-only'
  }
  return String(profile.type || '')
}

/**
 * Turn one completed Codex item into digest steps. Item shapes differ between
 * the `exec --json` and `mcp-server` streams (case and field naming), and
 * `command` arrives as an argv array on some builds, so look up candidates
 * rather than assuming one spelling.
 */
function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value) && value.length > 0) {
      const joined = value.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
      if (joined.length > 0) return joined
    }
    if (typeof value === 'number') return String(value)
  }
  return ''
}

/** `CODEX_BRIDGE_DEBUG=<path>` records raw items so shapes stay checkable. */
const debugEventsPath = process.env.CODEX_BRIDGE_DEBUG || ''

function debugRecord(value) {
  if (debugEventsPath.length === 0) return
  try {
    appendFileSync(debugEventsPath, `${JSON.stringify(value)}\n`, 'utf8')
  } catch {
    /* diagnostics must never break a delegation */
  }
}

function summarizeItem(item) {
  const steps = []
  if (!item || typeof item.type !== 'string') return steps
  debugRecord(item)
  const type = item.type.toLowerCase().replace(/_/g, '')
  if (type === 'commandexecution') {
    steps.push({ kind: 'call', label: 'command', detail: oneLine(firstString(item, ['command', 'cmd', 'script', 'argv']), 200) })
    const exit = firstString(item, ['exit_code', 'exitCode', 'status'])
    const output = firstString(item, ['formatted_output', 'aggregated_output', 'aggregatedOutput', 'output'])
    steps.push({ kind: 'out', label: 'result', detail: oneLine(`exit=${exit || '?'} ${output}`, 200) })
    return steps
  }
  if (type === 'filechange') {
    return [{ kind: 'call', label: 'file change', detail: oneLine(JSON.stringify(item.changes ?? item), 200) }]
  }
  if (type === 'websearch') {
    return [{ kind: 'call', label: 'web search', detail: oneLine(firstString(item, ['query', 'hits']) || JSON.stringify(item), 200) }]
  }
  if (type === 'mcptoolcall') {
    const label = `mcp ${firstString(item, ['server', 'name'])}`.trim()
    return [{ kind: 'call', label, detail: oneLine(`${firstString(item, ['tool'])} ${JSON.stringify(item.arguments ?? {})}`, 200) }]
  }
  if (type === 'error') {
    return [{ kind: 'out', label: 'error', detail: oneLine(firstString(item, ['message']) || JSON.stringify(item), 200) }]
  }
  if (type === 'reasoning' || type === 'usermessage' || type === 'agentmessage' || type === 'plan') return steps
  return [{ kind: 'call', label: type, detail: oneLine(JSON.stringify(item), 160) }]
}

function formatActivity(steps, limit = 14) {
  if (steps.length === 0) return '  (no command or tool activity recorded for this turn)'
  const kept = steps.slice(-limit)
  const lines = kept.map((step) => `  ${step.kind === 'call' ? '$' : '→'} ${step.label}: ${step.detail}`)
  if (steps.length > kept.length) lines.unshift(`  … ${steps.length - kept.length} earlier step(s)`)
  return lines.join('\n')
}

/*
 * Codex keeps its threads inside the mcp-server process, so one engine is
 * created lazily and reused for every delegation: a fresh process per call
 * would answer each codex-reply with "Session not found". Concurrent calls
 * multiplex over it by JSON-RPC request id, and the engine's own codex/event
 * notifications carry _meta.requestId, so a call only ever sees its own run.
 */
let engine = null

function engineWrite(state, message) {
  try {
    state.child.stdin.write(JSON.stringify(message) + '\n')
  } catch {
    /* a dying engine surfaces through its close handler */
  }
}

function routeEngineLine(state, rawLine) {
  const line = rawLine.replace(/^\uFEFF/, '').trim()
  if (line.length === 0) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'codex/event') {
    const entry = state.pending.get(message.params?._meta?.requestId)
    if (entry === undefined) return
    entry.events.push(message.params.msg)
    if (entry.onEvent) entry.onEvent(message.params.msg, entry.events)
    return
  }
  const entry = state.pending.get(message.id)
  if (entry === undefined) return
  clearTimeout(entry.timer)
  state.pending.delete(message.id)
  if (entry.kind === 'initialize') {
    entry.settle(message.error ? { ok: false, reason: oneLine(message.error.message, 300) } : { ok: true })
    return
  }
  if (message.error) {
    entry.settle({ ok: false, kind: 'tool_error', reason: oneLine(message.error.message || JSON.stringify(message.error), 300), text: '', threadId: '' })
    return
  }
  const structured = message.result?.structuredContent || {}
  const content = typeof structured.content === 'string'
    ? structured.content
    : (Array.isArray(message.result?.content)
      ? message.result.content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
      : '')
  entry.settle({
    ok: !message.result?.isError,
    kind: message.result?.isError ? 'tool_error' : 'completed',
    reason: message.result?.isError ? oneLine(content, 300) : '',
    text: content,
    threadId: typeof structured.threadId === 'string' ? structured.threadId : '',
  })
}

function startEngine() {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBinary, ['mcp-server'], {
      cwd: allowedRoot,
      env: engineEnv,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    liveChildren.add(child)
    const state = { child, nextId: 10, pending: new Map(), lineBuffer: '', exited: false }

    const failAll = (reason) => {
      if (state.exited) return
      state.exited = true
      liveChildren.delete(child)
      for (const entry of state.pending.values()) {
        clearTimeout(entry.timer)
        entry.settle({ ok: false, kind: 'engine_lost', reason, text: '', threadId: '', events: entry.events })
      }
      state.pending.clear()
      // 退役标记必须**留得住**：下面会把 engine 置 null，而 readyEngine() 正是靠它
      // 判断"当前这个 promise 对应的引擎还能不能用"。少了这一句，退出之后 engine 变 null，
      // 守卫就再也看不出"已退役"，直接把那个已经 resolve 的旧 promise 返回回去
      // ⇒ 后续请求拿到一个 exited 的 state，往死进程里写 JSON-RPC（2026-09-14 审计 P1）。
      if (engine === state) {
        engine = null
        engineRetired = true
        // 引擎没了 ⇒ 代数归零：记录里的这个数字要能回答"当时有没有随引擎重启失效的 thread"。
        engineGeneration = 0
      }
    }

    // Our stdout is reserved for the MCP protocol; forward engine noise to stderr.
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.on('error', (error) => {
      failAll('engine spawn failed: ' + error.message)
      reject(error)
    })
    child.on('close', (code) => {
      const reason = 'codex mcp-server exited (code ' + (code ?? 'unknown') + ')'
      failAll(reason)
      reject(new Error(reason))
    })
    child.stdout.on('data', (chunk) => {
      state.lineBuffer += chunk.toString()
      const lines = state.lineBuffer.split('\n')
      state.lineBuffer = lines.pop() ?? ''
      for (const line of lines) routeEngineLine(state, line)
    })

    const hello = state.nextId++
    const giveUp = (reason) => {
      failAll(reason)
      reject(new Error(reason))
    }
    state.pending.set(hello, {
      kind: 'initialize',
      events: [],
      settle: (outcome) => {
        if (!outcome.ok) {
          giveUp(outcome.reason)
          return
        }
        engineWrite(state, { jsonrpc: '2.0', method: 'notifications/initialized' })
        // 引擎代数在**建连成功那一刻**就 +1。注意委派侧是在 callEngineTool() 之前
        // 就把记录开出来的（要能记下"桥在 spawn 之前就拒绝"），所以这个计数必须在
        // readyEngine() 的 .then 里读、在 startEngine() 的成功路径上写 —— 写成
        // delegate() 进入时的快照就会永远是上一代（实测踩过）。
        engineGeneration += 1
        resolve(state)
      },
      timer: setTimeout(() => giveUp('codex mcp-server did not answer initialize within 30s'), 30000),
    })
    engine = state
    engineWrite(state, {
      jsonrpc: '2.0',
      id: hello,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-codex-delegate', version: BRIDGE_VERSION } },
    })
  })
}

let enginePromise = null
// engine 退出后会被置 null，所以"还能不能用"不能只看 engine 是否为空 —— 必须另留一个
// 退役标记，否则退出后引擎会被永久判为"可用"（见 failAll 里的注释）。
let engineRetired = true
// 引擎「第几代」：每成功建连一次 +1。运行记录带上它可以解释"同一条 thread 为什么失效"。
let engineGeneration = 0

function readyEngine() {
  if (enginePromise !== null && engineRetired === false && !(engine !== null && engine.exited)) return enginePromise
  engine = null
  engineRetired = false
  enginePromise = startEngine().catch((error) => {
    enginePromise = null
    engineRetired = true                     // 起不来也算退役，下次请求重新初始化
    throw error
  })
  return enginePromise
}

function callEngineTool({ tool, args, timeoutSeconds, onEvent }) {
  const ready = readyEngine()
  return ready.then((state) => new Promise((resolve) => {
    const id = state.nextId++
    const entry = { kind: 'call', events: [], onEvent: null, settle: null, timer: null }
    // Idempotency has to live in its own flag: routeEngineLine removes the
    // pending entry before invoking settle, so a pending-presence guard would
    // swallow every successful response and leave the caller hanging.
    let done = false
    const settleOnce = (outcome) => {
      if (done) return
      done = true
      clearTimeout(entry.timer)
      state.pending.delete(id)
      resolve({ kind: 'settled', reason: '', ...outcome, events: entry.events })
    }
    entry.settle = settleOnce
    entry.requestId = id
    entry.cancel = (reason, kind) => {
      // 取消 = 发一条 notifications/cancelled 并**立刻**让调用方收敛：`codex mcp-server`
      // 没有"等确认的取消"，回合可能在引擎里继续跑。所以超时被记成 cancelled（我们不再等、
      // 并已通知它停），而不是一次干净的失败（runner 语义见 README 的"取消"一节）。
      engineWrite(state, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
      settleOnce({ ok: false, reason, text: '', threadId: '', kind })
    }
    entry.timer = setTimeout(() => entry.cancel('timed out after ' + timeoutSeconds + 's', 'timeout'), timeoutSeconds * 1000)
    entry.onEvent = (msg, events) => {
      if (onEvent && onEvent(msg, events) === false) {
        entry.cancel('Codex reported a policy that does not match the request; the run was cancelled', 'policy')
      }
    }
    state.pending.set(id, entry)
    engineWrite(state, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } })
  })).catch((error) => ({ ok: false, kind: 'engine_lost', reason: oneLine(error.message, 300), text: '', threadId: '', events: [] }))
}

/**
 * `codex-reply` cannot re-declare a sandbox: a thread keeps whatever it was
 * created with. Threads we created are recorded here so a resume cannot be used
 * to slip a write-enabled thread through under a read-only request.
 */
const threadLedger = new Map()

async function delegate({ prompt, workspace, mode, timeoutSeconds, thread, includeActivity, runId, batchId, parentRunId }) {
  const effectiveRunId = typeof runId === 'string' && runId.length > 0 ? runId : randomUUID()
  if (thread.length > 0) {
    const known = threadLedger.get(thread)
    if (known !== undefined && known.mode !== mode) {
      throw new Error(`thread ${thread} was created with mode "${known.mode}"; it cannot be resumed as "${mode}" — start a fresh delegation instead`)
    }
    if (known !== undefined && mode === 'workspace-write' && writeRoot.length > 0 && !isInsideBase(writeRoot, known.workspace)) {
      throw new Error(`thread ${thread} works in ${known.workspace}, outside the write fence ${writeRoot}`)
    }
  }
  const args = thread.length > 0
    ? { threadId: thread, prompt }
    : { prompt, cwd: workspace, sandbox: mode, 'approval-policy': 'never' }

  /*
   * 运行记录在**委派真正起步前**就开出来：这样"引擎起不来"这类失败也留得下痕。
   * 代价是此刻只知道上一代的引擎代数，所以这里先 await 一次 readyEngine() 拿到
   * 本次真正要用的那一代（引擎懒启动就是在这里发生的）。
   */
  await readyEngine().catch(() => {
    /* 起不来由 callEngineTool 统一记账，这里只是让代数落到正确的值 */
  })

  const problems = []
  let configured = null
  const session = openRun({
    runId: effectiveRunId,
    batchId,
    parentRunId,
    workspace,
    mode,
    timeoutSeconds,
    threadId: thread,
    resumedFrom: thread,
    engineGeneration,
    promptChars: prompt.length,
    promptHead: prompt,
  })

  /*
   * 运行中的记录要能回答"当前走到哪一步"：事件一到就追加一版，而不是等收尾。
   * 节流到 400ms 一次，避免一个话痨 turn 把 JSONL 写成几百行；
   * 最后一次（收尾那版）永远写，所以最终记录总是完整的。
   */
  const liveSteps = []
  let liveArtifacts = []
  let lastLiveAt = 0
  const publishLive = (force) => {
    const now = Date.now()
    if (!force && now - lastLiveAt < 400) return
    lastLiveAt = now
    updateRun(session, {
      steps: stepsDigest(liveSteps),
      stepCount: liveSteps.length,
      artifacts: liveArtifacts,
      currentStep: liveSteps.length > 0 ? oneLine(liveSteps[liveSteps.length - 1].detail, 200) : '',
      finishedAt: null,
      durationMs: null,
    })
  }

  const run = await callEngineTool({
    tool: thread.length > 0 ? 'codex-reply' : 'codex',
    args,
    timeoutSeconds,
    // Resumed turns cannot re-declare their sandbox (codex-reply takes only a
    // thread and a prompt), so the thread's real policy is checked as soon as
    // the server reports it and the run is killed when it is looser than asked.
    onEvent: (msg) => {
      if (msg.type === 'session_configured') {
        configured = msg
        const actualSandbox = sandboxFromProfile(msg.permission_profile)
        if (actualSandbox.length > 0 && actualSandbox !== mode) return false
        if (typeof msg.approval_policy === 'string' && msg.approval_policy !== 'never') return false
        const cwd = typeof msg.cwd === 'string' ? path.resolve(msg.cwd) : ''
        if (cwd.length > 0 && !isInsideRoot(cwd)) return false
        if (mode === 'workspace-write' && writeRoot.length > 0 && cwd.length > 0 && !isInsideBase(writeRoot, cwd)) return false
      }
      if (msg.type === 'error') problems.push(`codex reported an error: ${oneLine(msg.message || JSON.stringify(msg), 240)}`)
      if (msg.type === 'item_completed') {
        for (const step of summarizeItem(msg.item)) {
          liveSteps.push(step)
          if (step.kind === 'call') liveArtifacts = artifactDigest([...liveArtifacts, ...[...String(step.detail).matchAll(/(?:[A-Za-z]:\\|\/)[^\s"'\\/]+(?:[\\/][^\s"']+)+/g)].map((hit) => hit[0])])
        }
        publishLive(false)
      }
      return true
    },
  })

  // `codex-reply` never re-emits session_configured, so a resumed turn is
  // vouched for by the ledger entry written when the thread was created and its
  // policy verified. A thread the ledger does not know stays unverifiable.
  const vouched = thread.length > 0 && configured === null && threadLedger.has(thread)
  if (configured === null && run.ok && !vouched) {
    problems.push('the bridge could not observe Codex\'s session_configured event, so the effective sandbox was unverifiable')
  }
  if (!run.ok && /session not found/i.test(run.reason)) {
    run.reason += ' — threads live in the bridge engine process, and it has restarted; start a fresh delegation instead of resuming'
  }
  if (run.ok && problems.length === 0 && run.threadId.length > 0) {
    threadLedger.set(run.threadId, { mode, workspace: configured && typeof configured.cwd === 'string' ? path.resolve(configured.cwd) : workspace })
  }

  const steps = []
  const artifactsFromEvents = []
  for (const event of run.events) {
    if (event.type !== 'item_completed') continue
    for (const step of summarizeItem(event.item)) steps.push(step)
    if (event.item?.type === 'file_change' && Array.isArray(event.item.changes)) {
      for (const change of event.item.changes) {
        const target = firstString(change, ['path', 'file', 'filename'])
        if (target.length > 0) artifactsFromEvents.push(target)
      }
    }
  }

  let tokens = ''
  let rateLimit = ''
  for (const event of run.events) {
    if (event.type !== 'token_count' || !event.info) continue
    const total = event.info.total_token_usage || {}
    if (typeof total.total_tokens === 'number') tokens = String(total.total_tokens)
    const primary = event.rate_limits?.primary
    if (typeof primary?.used_percent === 'number') rateLimit = `${primary.used_percent}% of the ${primary.window_minutes ?? '?'}-min window`
  }

  const ok = run.ok && problems.length === 0
  const outcome = ok ? { status: 'succeeded', kind: 'completed' } : outcomeForRun(run, problems, session)
  const failureDetail = ok ? '' : (run.reason || problems.join('; '))
  const threadId = run.threadId || thread || ''
  const artifacts = artifactDigest(artifactsFromEvents.length > 0 ? artifactsFromEvents : liveArtifacts)
  session.threadId = threadId
  session.steps = stepsDigest(steps)
  session.stepCount = steps.length
  session.artifacts = artifacts
  session.resumable = threadId.length > 0 && outcome.status !== 'failed'
  const currentStep = steps.length > 0 ? oneLine(steps[steps.length - 1].detail, 200) : ''
  const record = updateRun(session, {
    status: outcome.status,
    kind: outcome.kind,
    threadId,
    resumable: session.resumable,
    steps: stepsDigest(steps),
    stepCount: steps.length,
    artifacts,
    currentStep,
    error: ok ? null : { kind: outcome.kind, detail: oneLine(failureDetail, 400) },
    result: {
      text: oneLine(run.text || '', 400),
      tokens,
      rateLimit,
      steps: steps.length,
      artifacts: artifacts.length,
    },
  })

  const status = ok
    ? 'Codex completed the delegated task.'
    : `DELEGATION FAILED: ${oneLine(failureDetail, 400)}.`
  const vouch = vouched ? threadLedger.get(thread) : null
  const actualSandbox = configured
    ? sandboxFromProfile(configured.permission_profile)
    : (vouch ? `${vouch.mode} (vouched from creation)` : 'unknown')
  const header = [
    status,
    `Run: ${record.runId} [${record.status}/${record.kind}]`,
    `Thread: ${threadId || 'unknown'}${thread ? ' (resumed)' : ''}`,
    `Workdir: ${configured && typeof configured.cwd === 'string' ? configured.cwd : (vouch ? vouch.workspace : workspace)}`,
    `Sandbox: ${actualSandbox}`,
    `Approval: ${configured && typeof configured.approval_policy === 'string' ? configured.approval_policy : (vouch ? 'never (pinned at creation)' : 'unknown')}`,
    `Model: ${configured && typeof configured.model === 'string' ? configured.model : 'unknown'}`,
    tokens.length > 0 ? `Tokens: ${tokens}` : null,
    rateLimit.length > 0 ? `Quota used: ${rateLimit}` : null,
    configured && typeof configured.rollout_path === 'string' && configured.rollout_path.length > 0
      ? `Rollout: ${configured.rollout_path}`
      : null,
    `Steps: ${steps.length}`,
    `Artifacts: ${record.artifacts.length} (${RUNS_DIR})`,
    `Next step: pass resume_session: "${threadId || '<id>'}" to continue this exact conversation.`,
  ].filter(Boolean).join('\n')
  const activity = includeActivity ? `\n\nCodex activity:\n${formatActivity(steps)}` : ''
  publishRun(record)

  return {
    ok,
    runId: record.runId,
    status: record.status,
    threadId,
    text: `${header}${activity}\n\n${truncate(redact(run.text || 'Codex produced no final text.'))}`,
  }
}

/**
 * 把"为什么没成功"翻成记录里的枚举。
 * 这一层**只判定**，不改动结果文案：delegate_to_codex 的报错文本与改动前逐字一致。
 */
function outcomeForRun(run, problems, session) {
  if (run.kind === 'timeout') return { status: 'cancelled', kind: 'timeout' }
  if (run.kind === 'policy') return { status: 'cancelled', kind: 'policy' }
  if (clientCancelledCalls.has(session.runId)) {
    clientCancelledCalls.delete(session.runId)
    return { status: 'cancelled', kind: 'client_cancel' }
  }
  if (/session not found/i.test(run.reason)) return { status: 'failed', kind: 'thread_lost' }
  if (run.kind === 'engine_lost' || !run.ok) return { status: 'failed', kind: run.kind === 'engine_lost' ? 'engine_lost' : 'tool_error' }
  return { status: 'failed', kind: 'unverifiable' }
}

const tools = [
  {
    name: 'delegate_to_codex',
    description: 'Delegate a scoped task to Codex through Codex\'s own MCP server, with the sandbox pinned by this bridge. Results lead with the effective policy Codex reported, the thread id, token usage and a digest of the commands it ran. Pass that Thread back as resume_session to continue the same conversation; a follow-up sees everything Codex already found. Use only when the user explicitly asks to delegate work to Codex.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'Complete task instructions for Codex, including acceptance criteria and any output paths. Self-contained: Codex cannot see this conversation.',
          minLength: 1,
          maxLength: MAX_PROMPT_CHARS,
        },
        workspace: {
          type: 'string',
          description: 'Working directory for the delegated run. Must be inside the bridge root, and inside the write fence for mode: workspace-write.',
        },
        mode: {
          type: 'string',
          enum: ['read-only', 'workspace-write'],
          description: 'Requested sandbox. Defaults to read-only. danger-full-access is not offerable; writes also require the bridge write gate.',
        },
        resume_session: {
          type: 'string',
          description: 'A Thread id from an earlier result to continue that Codex conversation. The resumed turn keeps the sandbox it started with, and the bridge aborts it if the reported policy is looser than requested.',
        },
        include_activity: {
          type: 'boolean',
          description: 'Also return the steps Codex took, not just the final answer. Defaults to true; set false to save tokens.',
        },
        timeout_seconds: {
          type: 'integer',
          minimum: 10,
          maximum: MAX_TIMEOUT_SECONDS,
          description: `Wall-clock limit for the whole delegated run including Codex MCP startup. Defaults to ${DEFAULT_TIMEOUT_SECONDS}.`,
        },
        batch_id: {
          type: 'string',
          description: 'Optional label for a batch of related delegations; it is recorded on every run and can be used to group them later. Has no effect on the run itself.',
          maxLength: 120,
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_codex_runs',
    description: 'List recent Codex delegations recorded by this bridge, newest first: runId, status (running/succeeded/failed/cancelled), failure kind, step count, artifacts, threadId. Each delegation produces one record; use get_codex_run for one run in full, retry_codex_run to continue a recorded thread.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: RUN_LIST_MAX, description: `How many runs to return, newest first. Defaults to 20, maximum ${RUN_LIST_MAX}.` },
        status: {
          type: 'string',
          enum: RUN_STATUSES,
          description: 'Only runs in this state. Omit to list every state.',
        },
        batch_id: { type: 'string', description: 'Only runs recorded with this batch_id.' },
      },
    },
  },
  {
    name: 'get_codex_run',
    description: 'Fetch one delegation record by runId: status, failure kind and reason, the steps Codex took (current step included), the workspace paths it touched, start/end time, duration, threadId, whether it can be resumed, and the tail of its final text (redacted).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'A runId from a delegate_to_codex result ("Run: <id>") or from list_codex_runs.' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'retry_codex_run',
    description: 'Continue the Codex conversation of an earlier recorded run, using that run\'s threadId (so the follow-up sees everything that run already found). It starts a NEW run record whose parentRunId points at the original, and the original is left untouched. A prompt is required because run records store only the first 200 characters of the original prompt. The original run\'s workspace and sandbox mode are reused and re-checked; there is no way to widen them from here. Fails when the recorded thread is gone (the engine restarted since), because Codex threads do not survive a restart.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run_id: { type: 'string', description: 'The runId whose thread should be continued.' },
        prompt: { type: 'string', description: 'What Codex should do next, in this already-running conversation. Required: the record does not keep the full original prompt.', minLength: 1, maxLength: MAX_PROMPT_CHARS },
        include_activity: { type: 'boolean', description: 'Also return the steps this retry took. Defaults to true, matching delegate_to_codex.' },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: MAX_TIMEOUT_SECONDS, description: `Wall-clock limit for this retry. Defaults to the original run's timeout.` },
      },
      required: ['run_id', 'prompt'],
    },
  },
]

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

/**
 * 委派成功一版就发一次进度通知。MCP 的 `notifications/tools/run` 是**通知**：
 * 老的客户端（含本机的 DSH 桥）不认就直接丢弃，不会变成错误，所以它只是"
 * 运行记录可被推送"的钩子，真正的查询入口是下面两个工具。
 */
function publishRun(record) {
  send({
    jsonrpc: '2.0',
    method: 'notifications/tools/run',
    params: { runId: record.runId, status: record.status, kind: record.kind, threadId: record.threadId, steps: record.stepCount, artifacts: record.artifacts.length, startedAt: record.startedAt, finishedAt: record.finishedAt, durationMs: record.durationMs, error: record.error, batchId: record.batchId, parentRunId: record.parentRunId, path: RUNS_DIR },
  })
}

/** 运行记录里那次"桥在 spawn 之前就拒绝"的结局：留一条可查的痕，但不改报错文案。 */
function recordRefusal({ runId, batchId, workspace, mode, timeoutSeconds, prompt, reason, kind = 'refused' }) {
  // 这类拒绝发生在任何 spawn 之前：没有人被委派过，没有 thread，也就不能续跑。
  const session = openRun({ runId, batchId, workspace, mode, timeoutSeconds, promptChars: prompt.length, promptHead: prompt })
  const record = updateRun(session, {
    status: 'failed',
    kind,
    steps: [],
    stepCount: 0,
    artifacts: [],
    currentStep: '',
    resumable: false,
    threadId: '',
    error: { kind, detail: oneLine(reason, 400) },
    result: null,
  })
  publishRun(record)
  return record
}

function sharedRunOptions(input) {
  return {
    mode: getMode(input.mode),
    workspace: resolveWorkspace(input.workspace),
    thread: input.resume_session === undefined ? '' : assertThreadId(input.resume_session),
    timeoutSeconds: Number.isInteger(input.timeout_seconds) ? input.timeout_seconds : DEFAULT_TIMEOUT_SECONDS,
  }
}

function assertTimeout(timeoutSeconds) {
  if (timeoutSeconds < 10 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be between 10 and ${MAX_TIMEOUT_SECONDS}`)
  }
  return timeoutSeconds
}

function assertBatchId(value) {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error('batch_id must be a string')
  const batch = value.trim()
  if (batch.length > 120) throw new Error('batch_id must be at most 120 characters')
  return batch
}

/**
 * delegate_to_codex：入参、出参与沙箱语义与 0.2.0 逐字一致，**只多**一行 `Run: <id>`
 * 与一个可选的 batch_id。校验失败也在动作之前先落一条 refused 记录（新能力），
 * 报错文案不动。
 */
async function runDelegate(input, runId) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return toolResult('prompt is required', true)
  if (input.prompt.length > MAX_PROMPT_CHARS) return toolResult(`prompt exceeds ${MAX_PROMPT_CHARS} characters`, true)
  let batchId = ''
  try {
    batchId = assertBatchId(input.batch_id)
    const { mode, workspace, thread, timeoutSeconds } = sharedRunOptions(input)
    assertTimeout(timeoutSeconds)
    assertWriteScope(workspace, mode)
    const ran = await delegate({
      prompt: input.prompt,
      workspace,
      mode,
      timeoutSeconds,
      thread,
      includeActivity: input.include_activity !== false,
      runId,
      batchId,
    })
    return toolResult(ran.text, !ran.ok)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    let header = ''
    try {
      const record = recordRefusal({ runId, batchId, workspace: typeof input.workspace === 'string' ? input.workspace : '', mode: typeof input.mode === 'string' ? input.mode : 'read-only', timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, prompt: input.prompt, reason })
      publishRun(record)
      // 拒绝也要可查：把 runId 放在报错前面（**只加一行头**，原有报错文本逐字保留），
      // 否则这条记录存在却没人知道它的 id，等于查不到。
      header = `Run: ${record.runId} [${record.status}/${record.kind}]\n`
    } catch {
      /* 记录写不进去也不能改变这个调用原本的报错 */
    }
    return toolResult(redact(`${header}${reason}`), true)
  }
}

function runList(input) {
  const limit = Number.isInteger(input.limit) ? input.limit : 20
  if (limit < 1 || limit > RUN_LIST_MAX) return toolResult(`limit must be between 1 and ${RUN_LIST_MAX}`, true)
  if (input.status !== undefined && !RUN_STATUSES.includes(input.status)) {
    return toolResult(`status must be one of ${RUN_STATUSES.join(', ')}`, true)
  }
  let batchId = ''
  try {
    batchId = assertBatchId(input.batch_id)
  } catch (error) {
    return toolResult(redact(error instanceof Error ? error.message : String(error)), true)
  }
  const all = listRuns({ limit, statuses: input.status === undefined ? [] : [input.status] })
  const records = batchId.length > 0 ? all.filter((record) => record.batchId === batchId) : all
  const lines = [
    `codex runs (newest first): ${records.length}${batchId ? ` in batch ${batchId}` : ''}${input.status ? ` with status ${input.status}` : ''}`,
    `runs dir: ${RUNS_DIR}`,
    ...records.map((record) => `  · ${describeRun(record)}`),
  ]
  if (records.length === 0) lines.push('  (no run recorded yet — records start with the first delegation made through this bridge)')
  const running = records.filter((record) => record.status === 'running')
  if (running.length > 0) lines.push(`note: ${running.length} run(s) still running; a run that outlives the bridge process stays "running" in the ledger (the record is written by the process that owns it).`)
  return toolResult(lines.join('\n'))
}

function runDetail(input) {
  const runId = typeof input.run_id === 'string' ? input.run_id.trim() : ''
  if (runId.length === 0) return toolResult('run_id is required', true)
  const record = getRun(runId)
  if (record === null) return toolResult(`no run recorded with runId "${runId}". Use list_codex_runs to see recent run ids (records are kept ${RUN_RETENTION_DAYS} days).`, true)
  const lines = [
    `runId: ${record.runId}`,
    `status: ${record.status} (${record.kind})`,
    `batch: ${record.batchId || '-'}   retryOf: ${record.parentRunId || '-'}`,
    `startedAt: ${record.startedAt ? new Date(record.startedAt).toISOString() : '-'}   finishedAt: ${record.finishedAt ? new Date(record.finishedAt).toISOString() : '-'}   durationMs: ${record.durationMs ?? '-'}`,
    `workspace: ${record.workspace}   mode: ${record.mode}   timeoutSeconds: ${record.timeoutSeconds}`,
    `threadId: ${record.threadId || '-'}   resumable: ${record.resumable === true ? 'yes' : 'no'}${record.resumedFrom ? `   resumedFrom: ${record.resumedFrom}` : ''}`,
    `engineGeneration: ${record.engineGeneration}`,
    `prompt: ${record.promptChars} chars, head "${record.promptHead || ''}"`,
    `steps: ${record.stepCount}`,
    record.error && record.error.detail ? `failure: ${record.error.kind}: ${record.error.detail}` : 'failure: none',
    `artifacts (${record.artifacts.length}):`,
    ...(record.artifacts.length > 0 ? record.artifacts.map((artifact) => `  · ${artifact}`) : ['  (none)']),
    `last step: ${record.currentStep || '(none)'}`,
    'steps digest:',
    ...(record.steps.length > 0 ? record.steps.map((step) => `  ${step.kind === 'call' ? '$' : '→'} ${step.label}: ${step.detail}`) : ['  (none)']),
    record.result && record.result.text ? `result tail: ${record.result.text}` : 'result tail: (none)',
    `raw: ${RUNS_DIR}`,
  ]
  return toolResult(lines.join('\n'))
}

/** 仅重试"这一条 run"（单次委派内没有"多项"概念，见 README）：用原 threadId 续一次。 */
async function runRetry(input, runId) {
  const sourceId = typeof input.run_id === 'string' ? input.run_id.trim() : ''
  if (sourceId.length === 0) return toolResult('run_id is required', true)
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return toolResult('prompt is required', true)
  if (input.prompt.length > MAX_PROMPT_CHARS) return toolResult(`prompt exceeds ${MAX_PROMPT_CHARS} characters`, true)
  const source = getRun(sourceId)
  if (source === null) return toolResult(`no run recorded with runId "${sourceId}"`, true)
  if (typeof source.threadId !== 'string' || source.threadId.length === 0) {
    return toolResult(`run ${sourceId} (${source.status}/${source.kind}) has no threadId, so there is nothing to continue — it was refused before Codex started. Start a fresh delegation instead.`, true)
  }
  if (source.status === 'running') {
    return toolResult(`run ${sourceId} is still running; wait for it to settle before continuing its thread.`, true)
  }
  try {
    assertWriteScope(resolveWorkspace(source.workspace), source.mode)
    const timeoutSeconds = assertTimeout(Number.isInteger(input.timeout_seconds) ? input.timeout_seconds : (Number.isInteger(source.timeoutSeconds) && source.timeoutSeconds >= 10 ? source.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS))
    const ran = await delegate({
      prompt: input.prompt,
      workspace: source.workspace,
      mode: source.mode,
      timeoutSeconds,
      thread: source.threadId,
      includeActivity: input.include_activity !== false,
      runId,
      batchId: source.batchId,
      parentRunId: source.runId,
    })
    return toolResult(ran.text, !ran.ok)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    let header = ''
    try {
      const record = recordRefusal({ runId, batchId: source.batchId, workspace: source.workspace, mode: source.mode, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, prompt: input.prompt, reason })
      publishRun(record)
      header = `Run: ${record.runId} [${record.status}/${record.kind}]\n`
    } catch {
      /* 同上：记录失败不改报错（只少一行 Run: 头） */
    }
    return toolResult(redact(`${header}${reason}`), true)
  }
}

async function handleToolCall(params, runId) {
  const input = params?.arguments || {}
  if (params?.name === 'delegate_to_codex') return runDelegate(input, runId)
  if (params?.name === 'list_codex_runs') return runList(input)
  if (params?.name === 'get_codex_run') return runDetail(input)
  if (params?.name === 'retry_codex_run') return runRetry(input, runId)
  return toolResult(`Unknown tool: ${params?.name ?? 'missing'}`, true)
}

async function handleRequest(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-codex-delegate', title: 'DSH → Codex bridge', version: BRIDGE_VERSION },
      },
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    // 每次工具的调用 id 都先换成 runId：客户端发 notifications/cancelled 时只能看到
    // 这个 JSON-RPC id，靠它才能把"取消"落到正确的运行记录上。
    const runId = randomUUID()
    inFlightCalls.set(id, runId)
    try {
      send({ jsonrpc: '2.0', id, result: await handleToolCall(params, runId) })
    } finally {
      inFlightCalls.delete(id)
    }
    return
  }
  if (method === 'ping') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'notifications/cancelled') {
    if (inFlightCalls.has(params?.requestId)) {
      const runId = inFlightCalls.get(params.requestId)
      if (typeof runId === 'string' && runId.length > 0) clientCancelledCalls.add(runId)
      killLiveChildren('client cancelled the request')
    }
    return
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`)
}

const inFlightCalls = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  const trimmed = line.replace(/^\uFEFF/, '').trim()
  if (trimmed.length === 0) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    rpcError(null, -32700, 'Parse error')
    return
  }
  handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      rpcError(message.id, -32603, redact(error instanceof Error ? error.message : String(error)))
    } else {
      process.stderr.write(`${error}\n`)
    }
  })
})

for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(name, () => {
    killLiveChildren(`${name} received`)
    process.exit(0)
  })
}
process.on('exit', () => killLiveChildren('process exit'))
