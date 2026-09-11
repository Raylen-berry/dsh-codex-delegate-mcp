#!/usr/bin/env node
/*
 * DSH inbound bridge — Codex (or any MCP client) delegating work INTO DeepSeek
 * Harness.
 *
 * Direction: this is the mirror of server.mjs. Codex is an MCP *client* and has
 * no ACP client at all, so the way in is: Codex mounts this small stdio MCP
 * server, and this server speaks ACP to `dsh --profile acp`, which is the
 * supported automation surface for driving a persistent DSH agent.
 *
 * Two rules are enforced here and nowhere else:
 *   - Recursion guard. A DSH agent delegated work down to Codex; if that Codex
 *     calls back in, the cycle has no bottom. The forward bridge stamps
 *     DSH_DELEGATE_DEPTH into the engine environment, so an inbound call that
 *     arrives with depth >= 1 is refused unless the operator opts in.
 *   - Permission. Inbound work runs in the requested workspace with DSH's own
 *     sandbox/approval stack in charge, which on this deployment means
 *     workspace-write. Anything the agent asks for beyond what is granted
 *     surfaces as a denial plus a NEEDS USER line in the tool result; this
 *     bridge never escalates on its own.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-03-26'
// ACP negotiates an integer protocol revision, unlike MCP's date string.
const ACP_PROTOCOL_VERSION = 1
const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_TIMEOUT_SECONDS = 1800
const OUTPUT_LIMIT = 32_000

const rootsEnv = process.env.DSH_INBOUND_ROOTS || ''
const allowedRoots = rootsEnv.length > 0
  ? rootsEnv.split(path.delimiter).map((entry) => path.resolve(entry)).filter((entry) => entry.length > 0)
  : [path.resolve(process.cwd())]
const maxDepth = Number.parseInt(process.env.DSH_INBOUND_MAX_DEPTH || '0', 10) || 0
const allowNested = process.env.DSH_INBOUND_ALLOW_NESTED === 'true'
const depth = Number.parseInt(process.env.DSH_DELEGATE_DEPTH || '0', 10) || 0

const nodeBinary = process.execPath
const dshEntry = process.env.DSH_ENTRY || 'D:\\deepseek-harness\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const dshLauncher = process.env.DSH_LAUNCHER || 'D:\\deepseek-harness\\DSH Desktop\\resources\\harness-node-entry.mjs'
const dshHome = process.env.DSH_HOME || ''

function isInsideAnyRoot(candidate) {
  return allowedRoots.some((root) => {
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
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

function oneLine(value, limit = 240) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

const liveChildren = new Set()

function killLiveChildren() {
  for (const child of liveChildren) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

/* ---------- ACP engine: one persistent `dsh --profile acp` child ---------- */

let acp = null

function acpWrite(state, message) {
  try {
    debugLog('→acp', message)
    state.child.stdin.write(JSON.stringify(message) + '\n')
  } catch {
    /* the close handler reports the death */
  }
}

/** `DSH_INBOUND_DEBUG=<path>` records both directions of the ACP exchange. */
const debugPath = process.env.DSH_INBOUND_DEBUG || ''

function debugLog(direction, message) {
  if (debugPath.length === 0) return
  try {
    appendFileSync(debugPath, `${direction} ${JSON.stringify(message)}\n`, 'utf8')
  } catch {
    /* diagnostics never break a run */
  }
}

/**
 * Audit trail: one JSON line per inbound call, whether it ran, was refused or
 * failed. Defaults next to this file; override with DSH_INBOUND_AUDIT, disable
 * with 'none'. This is the "who asked for what, when, and what happened" record
 * the operator chose to keep once the bridge became reachable from any Codex.
 */
const auditPathEnv = process.env.DSH_INBOUND_AUDIT
const auditPath = auditPathEnv === undefined
  ? path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh-inbound-audit.jsonl')
  : auditPathEnv

function audit(entry) {
  if (auditPath === 'none' || auditPath.length === 0) return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    depth,
    ...entry,
  })
  try {
    appendFileSync(auditPath, `${line}\n`, 'utf8')
  } catch (error) {
    process.stderr.write(`[dsh-inbound] audit write failed: ${error?.message || error}\n`)
  }
}

function startAcp() {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary, ['--expose-internals', dshLauncher, dshEntry, '--profile', 'acp'], {
      cwd: allowedRoots[0],
      env: {
        ...process.env,
        ...(dshHome.length > 0 ? { DSH_HOME: dshHome } : {}),
        // Anything this agent delegates further is one level deeper, so the
        // forward bridge sees a depth it will refuse to serve.
        DSH_DELEGATE_DEPTH: String(depth + 1),
      },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    liveChildren.add(child)
    const state = { child, nextId: 1, pending: new Map(), lineBuffer: '', exited: false, stderrTail: '', agentText: [] }

    const failAll = (reason) => {
      if (state.exited) return
      state.exited = true
      liveChildren.delete(child)
      for (const entry of state.pending.values()) {
        clearTimeout(entry.timer)
        entry.settle({ ok: false, reason, text: '' })
      }
      state.pending.clear()
      if (acp === state) acp = null
    }

    child.stderr.on('data', (chunk) => {
      state.stderrTail = (state.stderrTail + chunk.toString()).slice(-6000)
    })
    child.on('error', (error) => {
      failAll('ACP spawn failed: ' + error.message)
      reject(error)
    })
    child.on('close', (code) => {
      const reason = `dsh --profile acp exited (code ${code ?? 'unknown'})`
      failAll(reason)
      reject(new Error(state.stderrTail.length > 0 ? `${reason}: ${oneLine(state.stderrTail, 400)}` : reason))
    })
    child.stdout.on('data', (chunk) => {
      state.lineBuffer += chunk.toString()
      const lines = state.lineBuffer.split('\n')
      state.lineBuffer = lines.pop() ?? ''
      for (const line of lines) routeAcpLine(state, line)
    })

    const hello = state.nextId++
    state.pending.set(hello, {
      kind: 'initialize',
      settle: (outcome) => {
        if (!outcome.ok) {
          failAll(outcome.reason)
          reject(new Error(outcome.reason))
          return
        }
        acpWrite(state, { jsonrpc: '2.0', method: 'notifications/initialized' })
        resolve(state)
      },
      timer: setTimeout(() => {
        failAll('dsh --profile acp did not answer initialize within 90s')
        reject(new Error('dsh --profile acp did not answer initialize within 90s'))
      }, 90000),
    })
    acp = state
    acpWrite(state, {
      jsonrpc: '2.0',
      id: hello,
      method: 'initialize',
      params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'dsh-inbound-bridge', version: '0.1.0' } },
    })
  })
}

function routeAcpLine(state, rawLine) {
  const line = rawLine.replace(/^\uFEFF/, '').trim()
  if (line.length === 0) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    // The desktop launcher prints a `[harness-node] runtime ...` banner on
    // stdout; anything that is not JSON-RPC is ignored rather than fatal.
    if (debugPath.length > 0) debugLog('←acp(raw)', line)
    return
  }
  debugLog('←acp', message)
  if (message.method === 'session/update') {
    const update = message.params?.update
    if (update?.sessionUpdate === 'agent_message_chunk' && typeof update?.content?.text === 'string') {
      state.agentText.push(update.content.text)
    }
    if (update?.sessionUpdate === 'plan' || update?.sessionUpdate === 'tool_call') {
      state.pending.get(message.params?.sessionId)?.events?.push(update)
    }
    return
  }
  // Permission asks are answered "deny" here and reported upward; the bridge has
  // no human at the keyboard and must not escalate on its own.
  if (typeof message.method === 'string' && message.method.endsWith('request_permission') && message.id !== undefined) {
    state.escalations = (state.escalations || []).concat(message.params?.toolCall?.title || message.method)
    acpWrite(state, {
      jsonrpc: '2.0',
      id: message.id,
      result: { outcome: { outcome: 'selected', optionId: (message.params?.options?.[0]?.optionId) ?? 'reject_once' } },
    })
    return
  }
  if (message.id === undefined) return
  const entry = state.pending.get(message.id)
  if (entry === undefined) return
  clearTimeout(entry.timer)
  state.pending.delete(message.id)
  if (message.error) {
    entry.settle({ ok: false, reason: oneLine(JSON.stringify(message.error), 500), text: undefined })
    return
  }
  entry.settle({ ok: true, reason: '', text: message.result })
}

function acpRequest(state, method, params, timeoutSeconds) {
  return new Promise((resolve) => {
    const id = state.nextId++
    let done = false
    const entry = {
      kind: 'request',
      settle: (outcome) => {
        if (done) return
        done = true
        clearTimeout(entry.timer)
        state.pending.delete(id)
        resolve(outcome)
      },
      timer: setTimeout(() => {
        if (done) return
        done = true
        state.pending.delete(id)
        resolve({ ok: false, reason: `${method} timed out after ${timeoutSeconds}s`, text: undefined })
      }, timeoutSeconds * 1000),
    }
    if (method === 'session/prompt') entry.events = []
    state.pending.set(id, entry)
    acpWrite(state, { jsonrpc: '2.0', id, method, params })
  })
}

async function runPrompt({ prompt, cwd, timeoutSeconds, resumeSession }) {
  const state = acp && !acp.exited ? acp : await startAcp()
  const sessionId = resumeSession?.trim?.() || ''

  if (sessionId.length === 0) {
    const created = await acpRequest(state, 'session/new', { cwd, mcpServers: [] }, Math.min(timeoutSeconds, 120))
    if (!created.ok) return { ok: false, reason: `session/new failed: ${created.reason}`, sessionId: '' }
    const newId = created.text?.sessionId
    if (typeof newId !== 'string' || newId.length === 0) return { ok: false, reason: 'session/new returned no sessionId', sessionId: '' }
    return promptInto(state, newId, prompt, timeoutSeconds)
  }
  const resumed = await acpRequest(state, 'session/resume', { sessionId, cwd }, Math.min(timeoutSeconds, 120))
  if (!resumed.ok) return { ok: false, reason: `session/resume failed: ${resumed.reason}`, sessionId }
  return promptInto(state, sessionId, prompt, timeoutSeconds)
}

async function promptInto(state, sessionId, prompt, timeoutSeconds) {
  state.agentText = []
  const before = state.escalations?.length || 0
  const result = await acpRequest(state, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, timeoutSeconds)
  const answer = state.agentText.join('')
  const stop = typeof result.text?.stopReason === 'string' ? result.text.stopReason : ''
  return {
    ok: result.ok,
    reason: result.ok ? '' : result.reason,
    sessionId,
    stopReason: stop,
    text: answer || (result.ok ? '(the DSH agent produced no text chunks)' : ''),
    escalations: (state.escalations || []).slice(before),
  }
}

/* ------------------------------- MCP surface ------------------------------- */

const tools = [
  {
    name: 'dsh_run',
    description: 'Delegate a task to a DeepSeek Harness agent on this machine and read its answer back. Use when the DSH agent should do the work (its tools, its workspace, its model). Runs with workspace-write inside an allowed root; anything beyond that is denied and reported, never auto-escalated. Returns a Session id you can pass to dsh_reply to continue the same DSH conversation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Self-contained instructions for the DSH agent.', minLength: 1, maxLength: 60000 },
        cwd: { type: 'string', description: `Workspace for the DSH agent. Must be inside one of: ${allowedRoots.join(', ')}. Defaults to this session's directory.` },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: MAX_TIMEOUT_SECONDS, description: `Wall-clock limit. Defaults to ${DEFAULT_TIMEOUT_SECONDS}.` },
      },
      required: ['task'],
    },
  },
  {
    name: 'dsh_reply',
    description: 'Continue an existing DSH conversation by the Session id returned from dsh_run, so the DSH agent keeps what it already read and did.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: { type: 'string', description: 'Session id from a dsh_run result.' },
        task: { type: 'string', description: 'The next instruction for the DSH agent.', minLength: 1, maxLength: 60000 },
        cwd: { type: 'string', description: 'Workspace, as in dsh_run. Must match a root the session can resume under.' },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: MAX_TIMEOUT_SECONDS },
      },
      required: ['session', 'task'],
    },
  },
  {
    name: 'dsh_sessions',
    description: 'List persistent DSH sessions this bridge can resume (newest first), to find a conversation to continue.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' } } },
  },
]

function guard() {
  if (allowNested || depth <= maxDepth) return null
  return `recursion guard: this request arrived at delegation depth ${depth} (limit ${maxDepth}). A DSH agent already delegated down to Codex, and calling back into DSH from here would chain without a bottom. Set DSH_INBOUND_ALLOW_NESTED=true on the bridge to allow it anyway.`
}

function resolveCwd(value) {
  const cwd = path.resolve(typeof value === 'string' && value.trim().length > 0 ? value : process.cwd())
  if (!isInsideAnyRoot(cwd)) {
    throw new Error(`cwd must be inside one of the allowed roots: ${allowedRoots.join(', ')}`)
  }
  return cwd
}

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

async function handleCall(name, input) {
  const blocked = guard()
  if (blocked !== null) return toolResult(blocked, true)
  const timeoutSeconds = Number.isInteger(input?.timeout_seconds) ? Math.min(Math.max(input.timeout_seconds, 10), MAX_TIMEOUT_SECONDS) : DEFAULT_TIMEOUT_SECONDS

  if (name === 'dsh_sessions') {
    const state = acp && !acp.exited ? acp : await startAcp()
    const listed = await acpRequest(state, 'session/list', { cwd: allowedRoots[0], pageSize: Number.isInteger(input?.limit) ? input.limit : 10 }, 120)
    if (!listed.ok) return toolResult(`session/list failed: ${listed.reason}`, true)
    const items = Array.isArray(listed.text?.sessions) ? listed.text.sessions : []
    const lines = items.map((item) => `  ${item.sessionId}  ${oneLine(item.title || item.cwd || '', 80)}`)
    return toolResult(`DSH sessions (${items.length}):\n${lines.join('\n') || '  (none)'}`)
  }

  const prompt = typeof input?.task === 'string' ? input.task : ''
  if (prompt.trim().length === 0) return toolResult('task is required', true)
  let cwd
  try {
    cwd = resolveCwd(input?.cwd)
  } catch (error) {
    return toolResult(error.message, true)
  }
  const resumeSession = name === 'dsh_reply' ? input?.session : undefined
  if (name === 'dsh_reply' && (typeof resumeSession !== 'string' || resumeSession.trim().length === 0)) {
    return toolResult('session is required for dsh_reply', true)
  }

  const ran = await runPrompt({ prompt, cwd, timeoutSeconds, resumeSession })
  const head = [
    ran.ok ? `DSH agent completed the task.` : `DSH TASK FAILED: ${oneLine(ran.reason, 300)}.`,
    `DSH session: ${ran.sessionId || 'unknown'}${resumeSession ? ' (continued)' : ''}`,
    `Workspace: ${cwd}`,
    `Delegation depth seen by this bridge: ${depth}`,
    `Stop: ${ran.stopReason || 'unknown'}`,
    ran.escalations?.length > 0 ? `NEEDS USER APPROVAL (denied by bridge): ${ran.escalations.join(' | ')}` : null,
    ran.sessionId ? `Next: call dsh_reply with session "${ran.sessionId}" to continue this DSH conversation.` : null,
  ].filter(Boolean).join('\n')
  return toolResult(`${head}\n\n${truncate(redact(ran.text || ''))}
`, !ran.ok)
}

async function handleRequest(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dsh-inbound-bridge', title: 'DSH inbound', version: '0.1.0' } } })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    const tool = params?.name
    try {
      const known = tools.some((candidate) => candidate.name === tool)
      const result = known ? await handleCall(tool, params.arguments || {}) : toolResult(`Unknown tool: ${tool ?? 'missing'}`, true)
      const text = String(result.content?.[0]?.text || '')
      audit({
        tool: tool ?? '?',
        ok: !result.isError,
        blocked: /recursion guard|NEEDS USER/i.test(text),
        workspace: typeof params?.arguments?.cwd === 'string' ? params.arguments.cwd : '',
        taskHead: typeof params?.arguments?.task === 'string' ? params.arguments.task.slice(0, 200) : '',
        replyHead: text.split('\n')[0].slice(0, 120),
      })
      send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      audit({ tool: tool ?? '?', ok: false, error: oneLine(error?.message || error, 200) })
      send({ jsonrpc: '2.0', id, result: toolResult(redact(oneLine(error?.stack || error?.message || error, 600)), true) })
    }
    return
  }
  if (method === 'ping') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`)
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let transportClosed = false
let mcpInflight = 0

// The persistent ACP engine keeps the event loop alive by design, so a client
// that hangs up has to be followed by an explicit exit once in-flight work is
// answered — otherwise the process lingers forever.
function maybeExit() {
  if (!transportClosed || mcpInflight > 0) return
  killLiveChildren()
  process.exit(0)
}

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
  mcpInflight += 1
  handleRequest(message)
    .catch((error) => {
      if (message.id !== undefined) rpcError(message.id, -32603, redact(oneLine(error?.message || error, 300)))
      else process.stderr.write(String(error) + '\n')
    })
    .then(() => {
      mcpInflight -= 1
      maybeExit()
    })
})
input.on('close', () => {
  transportClosed = true
  maybeExit()
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    killLiveChildren()
    process.exit(0)
  })
}
process.on('exit', killLiveChildren)
