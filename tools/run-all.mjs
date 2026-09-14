#!/usr/bin/env node
// tools/run-all.mjs —— 发布前检查总入口：本地与 CI 跑的是同一条命令（npm test）。
//
//   node tools/run-all.mjs          跑全部：每套都跑完再汇总
//   node tools/run-all.mjs --list   只列清单，不执行
//
// 为什么不用 `a.mjs && b.mjs` 串：第一套一失败后面的根本不跑，一次 push 只能暴露一个错误。
// 这里每套都跑、逐套列结果，任一套非 0 退出 ⇒ 本进程退出码 1 ⇒ CI 变红。
//
// 本清单只含**离线套件**：不联网、不调真实模型、不读本机 DSH 安装目录。
// verify-engine-restart 用真进程做端到端（CODEX_BINARY 指向 node 自己 + 假引擎脚本），
// 但假引擎是本套件自己写出来的，不碰 network、不碰真 Codex。
//
// 2026-09-14 修：套件起的真 server.mjs 会**继承本进程的环境**，而台账默认落
// $DSH_HOME/dsh-codex-delegate-mcp/runs/ ⇒ 本机开发时跑测试会把假的委派记录写进用户真实
// 数据目录（实测污染过 24 行）。两处一起堵：下面 ENV 把 CODEX_DELEGATE_RUNS_DIR 钉到临时区
// （每个子进程都生效，新套件自动被覆盖），末尾 assertRealDshHomeUntouched() 再用 sha256
// 前后比对"真实 DSH_HOME 下有没有人动过 runs/"。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIST_ONLY = process.argv.includes('--list')

// ---- 仓库配置 -------------------------------------------------------------
const CHECKS = []

const SUITES = [
  'tools/verify-engine-restart.mjs',
  'tools/verify-runs.mjs',
  'tools/verify-config-drift.mjs',
]

const EXCLUDED = []

/**
 * 传给每个套件的环境（在它继承来的 process.env 之上覆盖）。
 * `CODEX_DELEGATE_RUNS_DIR` 用 os.tmpdir()：Windows 与 POSIX 都成立，且**不依赖 DSH_HOME**，
 * 所以本机开发（DSH_HOME 指向真实 harness）与裸 CI（没有 DSH_HOME）走的是同一条路。
 * 用 pid 隔开：并发跑两个 npm test 时两边互不覆盖。
 */
const RUNS_DIR_ISOLATED = path.join(os.tmpdir(), `dsh-codex-delegate-runs-selftest-${process.pid}`)
const ENV = { CODEX_DELEGATE_RUNS_DIR: RUNS_DIR_ISOLATED }

/** 隔离台账目录里现在有多少条记录（用于报告与"套件确实往临时区写了"的证据）。 */
function isolatedRecordCount() {
  let names
  try {
    names = fs.readdirSync(RUNS_DIR_ISOLATED)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      total += fs.readFileSync(path.join(RUNS_DIR_ISOLATED, name), 'utf8').split('\n').filter((l) => l.trim().length > 0).length
    } catch {
      /* ignore */
    }
  }
  return total
}

/** 清掉本进程的临时残留（套件的夹具目录 + 隔离台账）。只在整体通过时清，失败留证据。 */
function cleanTempAreas() {
  const targets = [
    path.join(os.tmpdir(), 'dsh-codex-restart-ab'),
    path.join(os.tmpdir(), 'dsh-codex-restart-ab-srv'),
    path.join(os.tmpdir(), 'dsh-codex-runs-ab'),
    path.join(os.tmpdir(), 'dsh-codex-drift-ab'),
    RUNS_DIR_ISOLATED,
  ]
  const cleaned = []
  for (const target of targets) {
    if (!fs.existsSync(target)) continue
    try {
      fs.rmSync(target, { recursive: true, force: true })
      cleaned.push(path.basename(target))
    } catch {
      /* 清不掉不影响结论：它们都在临时区，不在任何真实数据目录里 */
    }
  }
  return cleaned
}

// ---- 登记完备性 + 已知失败 ------------------------------------------------
// tools/ 下每个「看起来是套件」的文件都必须在 SUITES / EXCLUDED / KNOWN_FAILING 里登记，
// 否则本进程直接失败 —— 防止以后新增套件被静默漏掉（同一个不变量原来由 browser-live 的
// verify-manifest.mjs 断言 package.json 里那个长串来保证）。
const DISCOVERY = (n) => /^(verify|test|probe)-.*\.mjs$/.test(n) || n === 'selfcheck.mjs'

// 已知失败：仍然跑、结果照列，但**不**让整体变红（每条都必须写明原因）。
const KNOWN_FAILING = []

// ---- 执行器 ---------------------------------------------------------------
const results = []
const t = (ms) => (ms / 1000).toFixed(1) + 's'

function summarize(out) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  const cand = [...lines].reverse().find((l) => /passed|通过|failed|失败/.test(l))
  if (cand) return cand.trim()
  const n = lines.filter((l) => /^\s*(PASS|✓|✔|OK)\b/.test(l)).length
  return n ? n + ' 项（按 PASS 行计数）' : '（无输出）'
}

function run(kind, file) {
  const args = kind === 'check' ? ['--check', file] : [file]
  const started = Date.now()
  const s = spawnSync(process.execPath, args, {
    cwd: REPO, env: { ...process.env, ...ENV }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const out = (s.stdout || '') + (s.stderr || '')
  const code = s.status === null ? 1 : s.status
  const ok = code === 0
  results.push({ kind, file, ok, code, ms: Date.now() - started, summary: summarize(out) })
  console.log('\n' + '─'.repeat(72))
  console.log((ok ? '✅ ' : '❌ ') + file + '   exit=' + code + '  ' + t(Date.now() - started))
  console.log('─'.repeat(72))
  if (out.trim()) console.log(out.replace(/\s+$/, ''))
  if (s.error) console.log('!! spawn 失败：' + s.error.message)
  return ok
}

function checkRegistry() {
  const reg = new Set([...SUITES, ...EXCLUDED.map((e) => e[0]), ...KNOWN_FAILING.map((e) => e[0])]
    .map((f) => path.basename(String(f).split(' ')[0])))
  const missing = fs.readdirSync(path.join(REPO, 'tools')).filter(DISCOVERY).filter((n) => !reg.has(n))
  if (missing.length) {
    console.error('✗ 有套件没登记到 tools/run-all.mjs（SUITES / EXCLUDED / KNOWN_FAILING 三选一）：' + missing.join(', '))
    process.exit(1)
  }
}

// ---- 真实数据目录的隔离断言 -----------------------------------------------
/*
 * 契约：**套件只能往临时区写**。台账的默认落点是 $DSH_HOME/dsh-codex-delegate-mcp/runs/，
 * 而套件起的 server.mjs 会继承本进程的环境 ⇒ 本机开发时 DSH_HOME 指向真实 harness，
 * 测试记录就会混进用户真实数据里（2026-09-14 实测污染过 24 行，已清理）。
 * 这里的判据是**文件级 sha256 前后比对**（只读），不是"应该没有"的口头约定：
 *   · 文件新增/删除/内容变化 ⇒ 整体失败（放行会让污染再次静默发生）
 *   · 目录不存在 ⇒ 正常（CI 没有 DSH_HOME），只记录"目录不存在"
 * 与 runs.mjs 的落点规则保持一致：CODEX_DELEGATE_RUNS_DIR 优先，其次 $DSH_HOME。
 */
function realDshHome() {
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim().length > 0) return path.resolve(explicit.trim())
  const appData = process.env.APPDATA // Windows 的惯例：%APPDATA%\dsh-desktop\harness
  return typeof appData === 'string' && appData.trim().length > 0
    ? path.join(appData, 'dsh-desktop', 'harness')
    : ''
}

const REAL_RUNS_DIR = (() => {
  const override = process.env.CODEX_DELEGATE_RUNS_DIR
  if (typeof override === 'string' && override.trim().length > 0) return '' // 本进程已显式隔离 ⇒ 不适用
  const home = realDshHome()
  return home.length > 0 ? path.join(home, 'dsh-codex-delegate-mcp', 'runs') : ''
})()

/**
 * 只读快照：文件名 → { sha256, bytes, mtimeMs }。目录不存在返回 null（= 没有真实台账）。
 * 三个量一起比：**只看"文件在不在"是不够的** —— 实测踩过：往已存在的日文件里追加行，
 * 文件名没变、mtime 变了，如果快照只记文件名就会把这次污染判成"没动过"。
 */
function snapshotRealRuns() {
  if (REAL_RUNS_DIR.length === 0) return null
  let names
  try {
    names = fs.readdirSync(REAL_RUNS_DIR)
  } catch {
    return null
  }
  const files = new Map()
  for (const name of names.sort()) {
    try {
      const full = path.join(REAL_RUNS_DIR, name)
      const stat = fs.statSync(full)
      if (!stat.isFile()) continue
      const bytes = fs.readFileSync(full)
      files.set(name, {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        mtimeMs: stat.mtimeMs,
      })
    } catch {
      files.set(name, { sha256: '<unreadable>', bytes: -1, mtimeMs: -1 })
    }
  }
  return files
}

function sameSnapshotEntry(a, b) {
  if (a === undefined || b === undefined) return false
  return a.sha256 === b.sha256 && a.bytes === b.bytes && a.mtimeMs === b.mtimeMs
}

function compareRealRuns(before, after) {
  if (before === null && after === null) return { added: [], removed: [], changed: [] }
  if (before === null && after !== null) return { added: [...after.keys()], removed: [], changed: [] }
  if (before !== null && after === null) return { added: [], removed: [...before.keys()], changed: [] }
  const added = [...after.keys()].filter((n) => !before.has(n))
  const removed = [...before.keys()].filter((n) => !after.has(n))
  const changed = [...before.keys()].filter((n) => after.has(n) && !sameSnapshotEntry(before.get(n), after.get(n)))
  return { added, removed, changed }
}

function describeSnapshotEntry(entry) {
  if (entry === undefined) return '(无)'
  return entry.bytes + ' 字节 sha256=' + entry.sha256.slice(0, 12) + ' mtime=' + new Date(entry.mtimeMs).toISOString()
}

function describeRealRuns(files) {
  if (files === null) return '（不存在）'
  return files.size === 0 ? '（存在但为空）' : files.size + ' 个文件'
}

const realRunsBefore = snapshotRealRuns()

/*
 * 自检钩子：真台账**本来就干净**时，上面那套比对是"0 个变化 ⇒ 通过"，看不出判据有没有用
 * （实现里一个手滑就可能永远报 0 变化 —— 本文件第一版就真的漏了"追加行"这种改法）。
 * 设 DSH_RUNALL_SELFTEST_POLLUTE=1 时，本进程在跑套件前故意往真台账追加一行、结束时再删掉，
 * 用来证明这个断言**真的会变红**。默认关闭；且只在真台账本来就有文件时才写，
 * 绝不会把一个干净目录变成脏目录而给人留下残渣。
 */
const SELFTEST_POLLUTE = process.env.DSH_RUNALL_SELFTEST_POLLUTE === '1' && REAL_RUNS_DIR.length > 0 && realRunsBefore !== null && realRunsBefore.size > 0

function selfTestPollute() {
  if (!SELFTEST_POLLUTE) return
  const target = path.join(REAL_RUNS_DIR, [...realRunsBefore.keys()][0])
  fs.appendFileSync(target, JSON.stringify({ runId: 'selftest', status: 'running', kind: 'running' }) + '\n', 'utf8')
}

function selfTestCleanup() {
  if (!SELFTEST_POLLUTE) return
  const target = path.join(REAL_RUNS_DIR, [...realRunsBefore.keys()][0])
  const text = fs.readFileSync(target, 'utf8')
  const kept = text.split('\n').filter((line) => !line.includes('"runId":"selftest"'))
  fs.writeFileSync(target, kept.join('\n'), 'utf8')
  console.log('（自检：已把故意追加的那行从真台账里移除）')
}

checkRegistry()
if (LIST_ONLY) {
  console.log('语法门禁：' + (CHECKS.length ? CHECKS.join(', ') : '（无）'))
  console.log('测试套件：')
  for (const f of SUITES) console.log('  · ' + f)
  console.log('未纳入 CI：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + ' —— ' + why)
  if (KNOWN_FAILING.length) {
    console.log('已知失败（仍跑、不拦截）：')
    for (const [f, why] of KNOWN_FAILING) console.log('  · ' + f + ' —— ' + why)
  }
  console.log('隔离：套件一律带 CODEX_DELEGATE_RUNS_DIR=' + RUNS_DIR_ISOLATED + '，并且跑完断言真实台账没被动过')
  console.log('          断言口径：文件名 + 字节数 + sha256 + mtime 全部一致才算"没被动过"')
  console.log('真实台账：' + (REAL_RUNS_DIR.length > 0 ? REAL_RUNS_DIR : '（不适用）'))
  process.exit(0)
}

console.log('dsh-codex-delegate-mcp 发布前检查（离线）· node ' + process.version)
console.log('仓库：' + REPO)
console.log('套件隔离台账：' + RUNS_DIR_ISOLATED)
console.log('真实台账（只读比对，套件不得碰）：' + (REAL_RUNS_DIR.length > 0 ? REAL_RUNS_DIR + ' ' + describeRealRuns(realRunsBefore) : '（不适用）'))
for (const f of CHECKS) run('check', f)
selfTestPollute()
for (const f of SUITES) run('suite', f)

const realRunsDelta = compareRealRuns(realRunsBefore, snapshotRealRuns())
const leaked = realRunsDelta.added.length + realRunsDelta.removed.length + realRunsDelta.changed.length > 0

const checks = results.filter((r) => r.kind === 'check')
const suites = results.filter((r) => r.kind === 'suite')
const knownNames = new Set(KNOWN_FAILING.map((e) => path.basename(e[0])))
const isKnown = (r) => knownNames.has(path.basename(r.file))
const bad = results.filter((r) => !r.ok && !isKnown(r))
const known = results.filter((r) => !r.ok && isKnown(r))

console.log('\n' + '='.repeat(72))
console.log('汇总')
console.log('='.repeat(72))
for (const r of results) console.log((r.ok ? ' ✅ ' : ' ❌ ') + r.file.padEnd(38) + t(r.ms).padStart(6) + '  ' + r.summary)
console.log('-'.repeat(72))
console.log('语法门禁 ' + checks.filter((r) => r.ok).length + '/' + checks.length +
  '　套件 ' + suites.filter((r) => r.ok).length + '/' + suites.length + ' 通过')
if (EXCLUDED.length) {
  console.log('\n未纳入 CI 的套件（原因）：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + '\n      ' + why)
}
if (known.length) {
  console.log('\n⚠ 已知失败（不拦截整体退出码，原因见本文件 KNOWN_FAILING）：')
  for (const r of known) console.log('  · ' + r.file + '（exit=' + r.code + '）' + r.summary)
}
if (bad.length) {
  console.log('\n失败套件：')
  for (const r of bad) console.log('  · ' + r.file + '（exit=' + r.code + '）' + r.summary)
}
if (REAL_RUNS_DIR.length > 0) {
  console.log('\n隔离断言（真实台账 ' + REAL_RUNS_DIR + '）：' + (leaked ? '✗ 被动过' : '✓ ' + describeRealRuns(realRunsBefore) + ' 的文件名/字节数/sha256/mtime 前后一致，套件一行都没写进去'))
  if (leaked) {
    if (realRunsDelta.added.length) console.log('  新增文件：' + realRunsDelta.added.join(', '))
    if (realRunsDelta.changed.length) {
      for (const name of realRunsDelta.changed) {
        console.log('  内容变化：' + name)
        console.log('    之前: ' + describeSnapshotEntry(realRunsBefore.get(name)))
        console.log('    之后: ' + describeSnapshotEntry(snapshotRealRuns().get(name)))
      }
    }
    if (realRunsDelta.removed.length) console.log('  文件消失：' + realRunsDelta.removed.join(', '))
    console.log('  原因通常是某个套件起了真 server.mjs 却没带 CODEX_DELEGATE_RUNS_DIR：台账默认落 $DSH_HOME。')
  }
  if (SELFTEST_POLLUTE) console.log('  自检模式：本次故意追加过一行（用来证明这个断言真的会变红）')
} else {
  console.log('\n隔离断言：本机没有真实 DSH_HOME 台账可比对（CI 即此情形）—— 套件仍被钉在 ' + RUNS_DIR_ISOLATED)
}
selfTestCleanup()
const isolatedRecords = isolatedRecordCount()
console.log('套件写入隔离台账的记录数：' + isolatedRecords + (isolatedRecords > 0 ? '（都在 ' + RUNS_DIR_ISOLATED + '，不是真实台账）' : '（本机所有套件各自用更细的临时目录，这里是空的）'))
if (!bad.length && !leaked) {
  const cleaned = cleanTempAreas()
  if (cleaned.length > 0) console.log('已清理本进程的临时残留：' + cleaned.join(', '))
} else {
  console.log('本次没有清理临时区（留着当证据）：' + RUNS_DIR_ISOLATED)
}
console.log('\n' + (bad.length || leaked ? '✗ 有套件失败或污染了真实台账 —— 整体失败' : '✓ 全部通过'))
process.exit(bad.length || leaked ? 1 : 0)
