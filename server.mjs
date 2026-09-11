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
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_TIMEOUT_SECONDS = 900
const MAX_PROMPT_CHARS = 120_000
const OUTPUT_LIMIT = 32_000
const PROTOCOL_VERSION = '2025-03-26'

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

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1***')
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
    entry.settle({ ok: false, reason: oneLine(message.error.message || JSON.stringify(message.error), 300), text: '', threadId: '' })
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
        entry.settle({ ok: false, reason, text: '', threadId: '', events: entry.events })
      }
      state.pending.clear()
      if (engine === state) engine = null
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
        resolve(state)
      },
      timer: setTimeout(() => giveUp('codex mcp-server did not answer initialize within 30s'), 30000),
    })
    engine = state
    engineWrite(state, {
      jsonrpc: '2.0',
      id: hello,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-codex-delegate', version: '0.2.0' } },
    })
  })
}

let enginePromise = null

function readyEngine() {
  if (enginePromise !== null && !(engine !== null && engine.exited)) return enginePromise
  engine = null
  enginePromise = startEngine().catch((error) => {
    enginePromise = null
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
      resolve({ ...outcome, events: entry.events })
    }
    entry.settle = settleOnce
    const cancel = (reason) => {
      engineWrite(state, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
      settleOnce({ ok: false, reason, text: '', threadId: '' })
    }
    entry.timer = setTimeout(() => cancel('timed out after ' + timeoutSeconds + 's'), timeoutSeconds * 1000)
    entry.onEvent = (msg, events) => {
      if (onEvent && onEvent(msg, events) === false) {
        cancel('Codex reported a policy that does not match the request; the run was cancelled')
      }
    }
    state.pending.set(id, entry)
    engineWrite(state, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } })
  })).catch((error) => ({ ok: false, reason: oneLine(error.message, 300), text: '', threadId: '', events: [] }))
}

/**
 * `codex-reply` cannot re-declare a sandbox: a thread keeps whatever it was
 * created with. Threads we created are recorded here so a resume cannot be used
 * to slip a write-enabled thread through under a read-only request.
 */
const threadLedger = new Map()

async function delegate({ prompt, workspace, mode, timeoutSeconds, thread, includeActivity }) {
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

  const problems = []
  let configured = null

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
  for (const event of run.events) {
    if (event.type !== 'item_completed') continue
    for (const step of summarizeItem(event.item)) steps.push(step)
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

  const status = run.ok && problems.length === 0
    ? 'Codex completed the delegated task.'
    : `DELEGATION FAILED: ${oneLine(run.reason || problems.join('; '), 400)}.`
  const vouch = vouched ? threadLedger.get(thread) : null
  const actualSandbox = configured
    ? sandboxFromProfile(configured.permission_profile)
    : (vouch ? `${vouch.mode} (vouched from creation)` : 'unknown')
  const header = [
    status,
    `Thread: ${run.threadId || thread || 'unknown'}${thread ? ' (resumed)' : ''}`,
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
    `Next step: pass resume_session: "${run.threadId || thread || '<id>'}" to continue this exact conversation.`,
  ].filter(Boolean).join('\n')
  const activity = includeActivity ? `\n\nCodex activity:\n${formatActivity(steps)}` : ''

  return {
    ok: run.ok && problems.length === 0,
    text: `${header}${activity}\n\n${truncate(redact(run.text || 'Codex produced no final text.'))}`,
  }
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
      },
      required: ['prompt'],
    },
  },
]

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

async function handleToolCall(params) {
  if (params?.name !== 'delegate_to_codex') {
    return toolResult(`Unknown tool: ${params?.name ?? 'missing'}`, true)
  }
  const input = params.arguments || {}
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return toolResult('prompt is required', true)
  if (input.prompt.length > MAX_PROMPT_CHARS) return toolResult(`prompt exceeds ${MAX_PROMPT_CHARS} characters`, true)
  try {
    const mode = getMode(input.mode)
    const workspace = resolveWorkspace(input.workspace)
    assertWriteScope(workspace, mode)
    const thread = input.resume_session === undefined ? '' : assertThreadId(input.resume_session)
    const timeoutSeconds = Number.isInteger(input.timeout_seconds) ? input.timeout_seconds : DEFAULT_TIMEOUT_SECONDS
    if (timeoutSeconds < 10 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new Error(`timeout_seconds must be between 10 and ${MAX_TIMEOUT_SECONDS}`)
    }
    const ran = await delegate({
      prompt: input.prompt,
      workspace,
      mode,
      timeoutSeconds,
      thread,
      includeActivity: input.include_activity !== false,
    })
    return toolResult(ran.text, !ran.ok)
  } catch (error) {
    return toolResult(redact(error instanceof Error ? error.message : String(error)), true)
  }
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
        serverInfo: { name: 'dsh-codex-delegate', title: 'DSH → Codex bridge', version: '0.2.0' },
      },
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    inFlightCalls.add(id)
    try {
      send({ jsonrpc: '2.0', id, result: await handleToolCall(params) })
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
    if (inFlightCalls.has(params?.requestId)) killLiveChildren('client cancelled the request')
    return
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`)
}

const inFlightCalls = new Set()

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
