#!/usr/bin/env node
/*
 * 委派运行记录（run ledger）—— 每次 delegate_to_codex 调用产生一条可查询记录。
 *
 * 落盘：$DSH_HOME/dsh-codex-delegate-mcp/runs/YYYY-MM-DD.jsonl（可被 CODEX_DELEGATE_RUNS_DIR 覆盖）
 *   一天一个 JSONL；一条记录的**每次状态变化都追加一行**（同一 runId 后写覆盖先写）。
 *   为什么不是"一条一个 JSON"：运行中要更新（running → succeeded/failed/cancelled），
 *   单文件要就地改写，进程被超时杀掉时容易留下半截文件；追加是原子的、崩溃后仍可读。
 *
 * 只读回放：getRun() / listRuns() 按"同 runId 后写覆盖先写"归并后再排序，
 *   所以运行中的记录也能读，且列表天然是**按开始时间倒序**。
 *
 * 敏感面：与 server.mjs 的 redact() 同一口径（本模块自持一份，保持零依赖可单独测试）。
 *   prompt 只存**前 200 字**的 head（沿用 dsh-inbound-audit.jsonl 的 taskHead 手法），
 *   不存全文；写盘前所有字符串都过 redact()。
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled']

/** 机器可判定+可读的失败/取消原因分类（报告与断言都依赖这组枚举）。 */
export const RUN_KINDS = [
  'timeout',          // 桥自己的墙钟超时：已发 notifications/cancelled，视为取消
  'policy',           // 引擎报的策略与会话不符，桥主动取消该次运行
  'client_cancel',    // MCP 客户端发了 notifications/cancelled
  'engine_lost',      // 引擎进程在运行中退出/启动失败 ⇒ 运行被中断（不是"取消"）
  'tool_error',       // 引擎回了 JSON-RPC/工具层错误
  'thread_lost',      // codex-reply 报 Session not found（thread 已随引擎重启失效）
  'refused',          // 桥在 spawn 之前拒绝（工作区/write 围栏/thread 模式不符）
]

const PROMPT_HEAD_CHARS = 200
const ARTIFACT_LIMIT = 50
const STEP_LIMIT = 200
/** 台账保留天数：列表/单条查询都按它算扫描范围，清理也只删这个范围之外的日文件。 */
export const RUN_RETENTION_DAYS = 14

const DOC_KEYS = ['text', 'tokens', 'rateLimit', 'error', 'reason', 'detail']

function resolveRunsDir() {
  const explicit = process.env.CODEX_DELEGATE_RUNS_DIR
  if (typeof explicit === 'string' && explicit.trim().length > 0) return path.resolve(explicit.trim())
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim().length > 0) {
    return path.join(path.resolve(home.trim()), 'dsh-codex-delegate-mcp', 'runs')
  }
  // 没有 DSH_HOME（裸 CI、直接命令行起桥）就落到临时目录：绝不在仓库或用户主目录凭空建目录。
  return path.join(os.tmpdir(), 'dsh-codex-delegate-runs')
}

/** Runs directory for this process. Read it instead of recomputing the rules. */
export const RUNS_DIR = resolveRunsDir()

export function redact(value) {
  return String(value)
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1***')
}

function oneLine(value, limit) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function dayStamp(date) {
  return date.toISOString().slice(0, 10)
}

function fileFor(date) {
  return path.join(RUNS_DIR, `${dayStamp(date)}.jsonl`)
}

function writeRecord(record) {
  const line = JSON.stringify(record)
  mkdirSync(RUNS_DIR, { recursive: true })
  appendFileSync(fileFor(new Date(record.startedAt)), `${line}\n`, 'utf8')
}

function listRunFiles() {
  try {
    return readdirSync(RUNS_DIR)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
  } catch {
    return []
  }
}

/**
 * 归并文件里的记录：同 runId 后写覆盖先写。
 * 按**文件顺序**做（旧文件先、新文件后），所以跨午夜的更新也能正确合并。
 */
function loadRecords() {
  const byId = new Map()
  for (const name of listRunFiles()) {
    let text
    try {
      text = readFileSync(path.join(RUNS_DIR, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue // 半截行（进程被杀）直接跳过，不让它污染整个记录集
      }
      if (!record || typeof record.runId !== 'string' || record.runId.length === 0) continue
      byId.set(record.runId, record)
    }
  }
  return [...byId.values()]
}

export function pruneRuns(now = Date.now(), days = RUN_RETENTION_DAYS) {
  const cutoff = now - days * 24 * 60 * 60 * 1000
  for (const name of listRunFiles()) {
    const full = path.join(RUNS_DIR, name)
    try {
      const at = Date.parse(name.slice(0, 10) + 'T00:00:00.000Z')
      if (Number.isFinite(at) && at < cutoff) {
        rmSync(full, { force: true })
        pruneTemps(name)
      }
    } catch {
      /* 清理失败不影响委派 */
    }
  }
}

/** 日文件被删后，把同一前缀的 .tmp 残留也清掉（原子写的中转文件）。 */
function pruneTemps(name) {
  try {
    for (const candidate of readdirSync(RUNS_DIR)) {
      if (candidate.startsWith(name) && candidate.endsWith('.tmp')) rmSync(path.join(RUNS_DIR, candidate), { force: true })
    }
  } catch {
    /* ignore */
  }
}

/** 运行中的记录：steps 随事件滚动落盘，所以"当前步骤"在运行期间也可查。 */
export function openRun(fields) {
  const startedAt = Date.now()
  const record = {
    runId: fields.runId,
    batchId: asString(fields.batchId, ''),
    parentRunId: asString(fields.parentRunId, ''),
    status: 'running',
    kind: 'running',
    sequence: 0,
    startedAt,
    finishedAt: null,
    durationMs: null,
    workspace: asString(fields.workspace, ''),
    mode: asString(fields.mode, 'read-only'),
    timeoutSeconds: asNumber(fields.timeoutSeconds),
    threadId: asString(fields.threadId, ''),
    resumedFrom: asString(fields.resumedFrom, ''),
    resumable: false,
    engineGeneration: asNumber(fields.engineGeneration),
    promptChars: asNumber(fields.promptChars),
    promptHead: oneLine(redact(fields.promptHead || ''), PROMPT_HEAD_CHARS),
    stepCount: 0,
    currentStep: '',
    steps: [],
    artifacts: [],
    error: null,
    result: null,
    pid: process.pid,
  }
  writeRecord(record)
  return record
}

/**
 * 追加一版记录。`session` 是 openRun() 返回值本身（就地维护 sequence 等运行态），
 * patch 里只允许覆盖文档化的字段，避免半个对象把记录写坏。
 */
export function appendRun(session, patch) {
  const record = {
    ...session,
    ...patch,
    sequence: session.sequence + 1,
  }
  for (const key of DOC_KEYS) {
    if (typeof record[key] === 'string') record[key] = redact(record[key])
  }
  if (typeof record.error === 'object' && record.error !== null) {
    record.error = { kind: record.error.kind, detail: redact(record.error.detail || '') }
  }
  if (typeof record.result === 'object' && record.result !== null) {
    record.result = { ...record.result, text: redact(record.result.text || '') }
  }
  session.sequence = record.sequence
  writeRecord(record)
  return record
}

/** 收尾一版：多补 finishedAt/durationMs（运行中的那些版本里两者是 null）。 */
export function updateRun(session, patch) {
  const finishedAt = patch.finishedAt === undefined ? Date.now() : patch.finishedAt
  return appendRun(session, {
    ...patch,
    finishedAt,
    durationMs: finishedAt === null ? null : finishedAt - session.startedAt,
  })
}

export function getRun(runId) {
  if (typeof runId !== 'string' || runId.trim().length === 0) return null
  const wanted = runId.trim()
  return loadRecords().find((record) => record.runId === wanted) || null
}

/**
 * 最近若干条（默认按 startedAt 倒序）。statuses 可过滤；扫描范围限定在
 * `days` 天内的文件上，所以台账长期增长也不会把一次列表变成全库扫描。
 */
export function listRuns({ limit = 20, statuses = [], days = RUN_RETENTION_DAYS, now = Date.now() } = {}) {
  pruneRuns(now, days)
  const allowed = new Set(statuses.filter((status) => RUN_STATUSES.includes(status)))
  const records = loadRecords()
    .filter((record) => allowed.size === 0 || allowed.has(record.status))
    .sort((a, b) => asNumber(b.startedAt) - asNumber(a.startedAt) || asNumber(b.sequence) - asNumber(a.sequence))
  const capped = Math.max(1, Math.min(200, asNumber(limit, 20)))
  return records.slice(0, capped)
}

/** 记录概览：一行一条，够人读也够断言。 */
export function describeRun(record) {
  if (!record || typeof record !== 'object') return '(missing run record)'
  const when = new Date(asNumber(record.startedAt)).toISOString()
  const bits = [
    `${record.status}/${record.kind}`,
    oneLine(record.promptHead, 60),
    `thread=${record.threadId || '-'}`,
    `steps=${asNumber(record.stepCount)}`,
    `artifacts=${Array.isArray(record.artifacts) ? record.artifacts.length : 0}`,
  ]
  if (record.batchId) bits.push(`batch=${record.batchId}`)
  if (record.parentRunId) bits.push(`retryOf=${record.parentRunId}`)
  if (record.error && record.error.detail) bits.push(`error=${oneLine(record.error.detail, 120)}`)
  return `${when}  ${record.runId}  ${bits.join('  ')}`
}

export function stepsDigest(steps) {
  return Array.isArray(steps) ? steps.slice(-STEP_LIMIT) : []
}

export function artifactDigest(paths) {
  const seen = new Set()
  const out = []
  for (const value of paths) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= ARTIFACT_LIMIT) break
  }
  return out
}

export function runsFileSize() {
  try {
    return statSync(fileFor(new Date())).size
  } catch {
    return 0
  }
}

/** 原子写整文件（需要重写台账时用，避免半截文件）。 */
export function writeFileAtomic(target, text) {
  mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, target)
}
