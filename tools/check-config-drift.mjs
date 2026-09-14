#!/usr/bin/env node
/*
 * tools/check-config-drift.mjs —— 只读比对"仓库里的模板"与"本机生效那份"，不一致就报漂移。
 *
 * 为什么需要它：DSH Desktop 是用 `%DSH_HOME%\profiles\web\cordis.patch.yml` 生效的，仓库里
 * 那份只是模板。两份靠人手抄 ⇒ 必然漂移。实测（2026-09-14）就先漂移过一次：本机那份
 * `CODEX_BRIDGE_REV` 早就是 14，仓库那份还是 13，且本机那份停在 09-11 —— 于是"把仓库改成 14"
 * 看起来是对齐，实际上**没有产生配置 diff**，宿主不会重挂 stdio 子进程，新工具也就不会挂上。
 *
 * 判据：两份文件里 `mcp-codex-delegate` 那个 insert 块的**关键键值**必须一致，
 * 并单独把 `CODEX_BRIDGE_REV` 拎出来说清楚（它是"宿主重不重挂"的开关）。
 *
 * 只读：本脚本不写任何文件。用法：
 *   node tools/check-config-drift.mjs
 *   node tools/check-config-drift.mjs --live <path> --template <path>
 *   node tools/check-config-drift.mjs --quiet     （只在漂移时输出）
 * 环境变量兜底：DSH_CODEX_LIVE_PATCH / DSH_CODEX_TEMPLATE_PATCH / DSH_HOME
 * 退出码：0 = 一致（或本机那份不存在 ⇒ 不适用）/ 1 = 漂移 / 2 = 用法错误（文件缺失等）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/** 关键键：这些不一致都会改变桥的实际行为（REV 决定宿主会不会重挂）。 */
export const WATCHED_KEYS = [
  'CODEX_BRIDGE_REV',
  'CODEX_DELEGATE_ROOT',
  'CODEX_DELEGATE_ALLOW_WRITE',
  'CODEX_DELEGATE_WRITE_ROOT',
  'CODEX_DELEGATE_RUNS_DIR',
  'CODEX_BINARY',
  'toolCallTimeoutMs',
  'failOnStartupError',
  'cwd',
  'command',
  'serverName',
  'transport',
]

/*
 * 一边没写≠漂移的键：`CODEX_DELEGATE_RUNS_DIR` 的默认值就是
 * `$DSH_HOME/dsh-codex-delegate-mcp/runs`（见 runs.mjs 的 resolveRunsDir），所以
 * "本机那份没写、模板里写了同一个默认值"是**等价**的，报成漂移只会制造噪声。
 * 仍然把它列出来（标 equivalent），但不算失败 —— 只读脚本不许靠猜来判 fail。
 */
const EQUIVALENT_WHEN_ABSENT = new Set(['CODEX_DELEGATE_RUNS_DIR'])

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : ''
}

function defaultLivePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? path.resolve(process.env.DSH_HOME.trim())
    : (process.env.APPDATA && process.env.APPDATA.trim().length > 0 ? path.join(process.env.APPDATA, 'dsh-desktop', 'harness') : '')
  return home.length > 0 ? path.join(home, 'profiles', 'web', 'cordis.patch.yml') : ''
}

const LIVE = path.resolve(argValue('--live') || process.env.DSH_CODEX_LIVE_PATCH || defaultLivePath() || path.join(os.tmpdir(), 'no-live-patch.yml'))
const TEMPLATE = path.resolve(argValue('--template') || process.env.DSH_CODEX_TEMPLATE_PATCH || path.join(REPO, 'dsh-codex-delegate.cordis.patch.yml'))
const QUIET = process.argv.includes('--quiet')

/**
 * 从 patch 里抽出关键键值。刻意做成"看不懂的结构直接报出来"，而不是猜 —— 这个脚本的
 * 价值全在判据可靠，猜错一次就会给出错误的"一致"结论。
 */
function extract(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const found = new Map()
  const lines = raw.split(/\r?\n/)
  const isOurBlock = raw.includes('mcp-codex-delegate')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const key = match[1]
    if (!WATCHED_KEYS.includes(key)) continue
    const value = match[2].trim().replace(/^['"]|['"]$/g, '')
    if (!found.has(key)) found.set(key, value)
  }
  return { found, isOurBlock, bytes: Buffer.byteLength(raw, 'utf8') }
}

function readBoth() {
  const missing = []
  const out = {}
  for (const [label, file] of [['live', LIVE], ['template', TEMPLATE]]) {
    if (!fs.existsSync(file)) {
      missing.push({ label, file })
      continue
    }
    out[label] = { file, ...extract(file) }
  }
  return { out, missing }
}

const { out, missing } = readBoth()
const missingLive = missing.some((m) => m.label === 'live')
const missingTemplate = missing.some((m) => m.label === 'template')

if (missingTemplate) {
  console.error('✗ 仓库模板不存在：' + TEMPLATE)
  process.exit(2)
}

if (!QUIET) console.log('本机生效那份：' + (missingLive ? '(不存在)' : LIVE))
if (!QUIET) console.log('仓库模板：' + TEMPLATE)

if (missingLive) {
  // CI / 别人的机器上没有这份本机配置，这是正常情形，不是失败。
  console.log('✓ 不适用：本机没有生效那份 patch（CI 即此情形），只有仓库模板可比。')
  process.exit(0)
}

const live = out.live
const template = out.template
if (!live.isOurBlock || !template.isOurBlock) {
  console.error('✗ 至少一份文件里找不到 mcp-codex-delegate 块，无法比对（判据不成立，请人工检查）')
  process.exit(2)
}

const drifts = []
const onlyLive = []
const onlyTemplate = []
const equivalent = []
for (const key of WATCHED_KEYS) {
  const a = live.found.get(key)
  const b = template.found.get(key)
  if (a === undefined && b === undefined) continue
  if (a !== undefined && b === undefined) { (EQUIVALENT_WHEN_ABSENT.has(key) ? equivalent : onlyLive).push(key); continue }
  if (a === undefined && b !== undefined) { (EQUIVALENT_WHEN_ABSENT.has(key) ? equivalent : onlyTemplate).push(key); continue }
  if (a !== b) drifts.push({ key, live: a, template: b })
}

if (!QUIET) {
  console.log('本机那份: ' + live.bytes + ' 字节   仓库模板: ' + template.bytes + ' 字节')
  console.log('\n关键键对照：')
  for (const key of WATCHED_KEYS) {
    const a = live.found.has(key) ? live.found.get(key) : '(缺省)'
    const b = template.found.has(key) ? template.found.get(key) : '(缺省)'
    const same = live.found.get(key) === template.found.get(key)
    const mark = same ? '  ' : (equivalent.includes(key) ? '≈ ' : '≠ ')
    console.log(`  ${mark}${key.padEnd(26)} 本机=${a}   模板=${b}`)
  }
}

const liveRev = live.found.get('CODEX_BRIDGE_REV') || '(缺省)'
const templateRev = template.found.get('CODEX_BRIDGE_REV') || '(缺省)'

if (drifts.length === 0 && onlyLive.length === 0 && onlyTemplate.length === 0) {
  const extra = equivalent.length > 0 ? `；另有 ${equivalent.join(', ')} 只在一边出现，按默认值等价处理（≈）` : ''
  console.log(`\n✓ 一致：${WATCHED_KEYS.length} 个关键键逐一相同（CODEX_BRIDGE_REV = ${liveRev}）${extra}`)
  process.exit(0)
}

console.error('\n✗ 检测到漂移（仓库模板 ≠ 本机生效那份）：')
for (const d of drifts) console.error(`  · ${d.key}: 本机=${d.live}  模板=${d.template}`)
if (onlyLive.length) console.error('  · 只在本机那份里出现：' + onlyLive.join(', '))
if (onlyTemplate.length) console.error('  · 只在仓库模板里出现：' + onlyTemplate.join(', '))
if (equivalent.length) console.error('  （按默认值等价、不算漂移：' + equivalent.join(', ') + '）')
console.error('\n该怎么做：')
console.error('  1. 想让它**真的在下次重挂/重启后生效**，改的是本机那份，而且要产生 diff ——')
if (liveRev === templateRev) {
  // 2026-09-14 真实踩到的形状：本机那份 REV 已经是最新的、仓库那份落后，
  // 于是"把仓库改成同一个数字"看着像对齐，实际没有任何 diff ⇒ 宿主不重挂 ⇒ 新工具挂不上。
  console.error(`     两份 CODEX_BRIDGE_REV 都是 ${liveRev}，光对齐这一项**不会**产生 diff；`)
  console.error('     要挂载新代码请把 REV 再 +1（两份一起改），改动本机那份才会真的重挂子进程。')
} else {
  console.error(`     CODEX_BRIDGE_REV：本机=${liveRev} 模板=${templateRev} ⇒ 把两份改成同一个**更大的**值。`)
}
if (drifts.length === 0) {
  console.error('     另外：关键键其实都一样，这次"漂移"只是其中一份多了/少了非关键内容（注释、别的块）。')
}
console.error('  2. 两份都要改（本机那份决定生效，仓库那份是模板/文档）。')
console.error('  3. 这份比对本来该由 dsh-doctor 的"配置已生效"那一层收编；在没有 doctor 的情况下它就是那个检查。')
process.exit(1)
