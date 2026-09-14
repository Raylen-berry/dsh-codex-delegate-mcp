// 验「仓库模板 vs 本机生效那份」的漂移判据（tools/check-config-drift.mjs）。
//
// 为什么要有它：DSH Desktop 用的是 %DSH_HOME%\profiles\web\cordis.patch.yml，仓库那份只是模板，
// 两份靠人手抄 ⇒ 必然会漂移。实测（2026-09-14）漂移过一次：本机 REV 早就是 14、仓库还是 13，
// 于是"把仓库改成 14"看着像对齐，实际**没有产生配置 diff** ⇒ 宿主不重挂 ⇒ 新工具挂不上。
// 这条判据本身必须被测：判错一次就会给出错误的"一致"结论。
//
// 全部用**临时目录里的合成配置**：真实 %APPDATA% 与仓库模板都只读，不写、不改。
// 另外对真实那两份做一次"只读跑通"（跑得出结论即可，不规定是哪一种）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const CHECKER = path.join(HERE, 'check-config-drift.mjs')
const TEMPLATE = path.join(REPO, 'dsh-codex-delegate.cordis.patch.yml')
const ROOT = path.join(os.tmpdir(), 'dsh-codex-drift-ab')

/*
 * 关键键名单**从检查器源码里读**（不去 import 它：检查器是脚本，没有 ESM 的 import 守卫，
 * 一 import 就会执行它的主流程、跑出结论后 process.exit —— 那会把本套件本身直接杀掉）。
 * 这样既保持"名单只有一处定义"，又不会给检查器加副作用。
 */
const CHECKER_KEYS = (() => {
  const source = fs.readFileSync(CHECKER, 'utf8')
  const block = /const WATCHED_KEYS = \[([\s\S]*?)\]/.exec(source)
  if (!block) return []
  return [...block[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1])
})()

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

/**
 * 合成一份"本机生效那份"的形态（注释 + 另一个顶层块 + 我们的 insert 块）。
 * 键值**从仓库模板里读出来**再改指定的一项 —— 这样合成件只在这一个键上和模板不同，
 * 断言不会因为模板别处改动而误报（第一版手抄键值，抄错一个 unicode 路径就全红；
 * 第二版漏抄了 cwd/command，结论对但建议分支不对，也是同一个错）。
 */
function templateKeyLines() {
  const wanted = new Set(['serverName', 'command', 'cwd', 'toolCallTimeoutMs', 'failOnStartupError', ...CHECKER_KEYS])
  const values = {}
  const order = []
  for (const line of fs.readFileSync(TEMPLATE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || trimmed.length === 0) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(trimmed)
    if (!match || !wanted.has(match[1])) continue
    values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
    order.push(match[1])
  }
  return { values, order }
}

const TEMPLATE_VALUES = templateKeyLines()

function writePatch(file, override = {}) {
  const values = { ...TEMPLATE_VALUES.values, ...override }
  const envKeys = TEMPLATE_VALUES.order.filter((key) => /^CODEX_/.test(key))
  const configKeys = TEMPLATE_VALUES.order.filter((key) => !/^CODEX_/.test(key))
  const lines = [
    '# 合成配置（本套件临时产物，不是任何真实文件）',
    '- id: permission',
    '  name: \'@deepseek-ai/dsh-permission-presets\'',
    '  config:',
    '    presets: {}',
    '',
    '# ── DSH → Codex 委派桥（dsh-codex-delegate-mcp）',
    '- insert:',
    '    - id: mcp-codex-delegate',
    '      name: \'@deepseek-ai/dsh-mcp-client\'',
    '      config:',
  ]
  for (const key of configKeys.filter((k) => k === 'serverName' || k === 'command')) lines.push(`        ${key}: '${values[key]}'`)
  lines.push('        transport: \'stdio\'', '        args:', '          - \'D:\\DeepSeek\\dsh-codex-delegate-mcp\\server.mjs\'', '        env:')
  for (const key of envKeys) {
    if (values[key] === undefined) continue // 用 undefined 表示"这一份里不写这个键"
    lines.push(`          ${key}: '${values[key]}'`)
  }
  for (const key of ['cwd', 'toolCallTimeoutMs', 'failOnStartupError']) {
    if (configKeys.includes(key)) lines.push(`        ${key}: '${values[key]}'`)
  }
  lines.push('')
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

/** 不带 --quiet 跑检查器，返回 {code, out}。 */
function runChecker(live, template) {
  const s = spawnSync(process.execPath, [CHECKER, '--live', live, '--template', template], { encoding: 'utf8', cwd: REPO })
  return { code: s.status === null ? -1 : s.status, out: (s.stdout || '') + (s.stderr || '') }
}

/** 仓库模板里的真实 REV（断言用，证明"一致"不是靠写死数字蒙的）。 */
const repoRev = (/CODEX_BRIDGE_REV:\s*'?([0-9]+)'?/.exec(fs.readFileSync(TEMPLATE, 'utf8')) || [, ''])[1]

console.log('被测检查器：' + CHECKER)
console.log('仓库模板真实 REV = ' + (repoRev || '(读不到)'))
console.log('检查器声明的关键键（' + CHECKER_KEYS.length + ' 个）：' + CHECKER_KEYS.join(', '))
console.log('合成配置目录：' + ROOT)

ok('能从检查器源码里读到关键键名单（名单没被改坏）', CHECKER_KEYS.length >= 8 && CHECKER_KEYS.includes('CODEX_BRIDGE_REV'), CHECKER_KEYS.length + ' 个')

console.log('\n— 1. 两份一致 ⇒ 退出码 0 —')
const same = writePatch(path.join(ROOT, 'same.yml'))
const r1 = runChecker(same, TEMPLATE)
ok('退出码 0', r1.code === 0, 'exit=' + r1.code)
ok('明确说"一致"', r1.out.includes('✓ 一致'), r1.out.split('\n').filter((l) => l.includes('✓')).join(' | ').slice(0, 90))
ok('把 REV 报出来（证明读的是真值）', r1.out.includes('CODEX_BRIDGE_REV = ' + repoRev))

console.log('\n— 2. REV 不一致 ⇒ 退出码 1 + 明确指出漂移（反向验证）—')
const bumped = writePatch(path.join(ROOT, 'bumped.yml'), { CODEX_BRIDGE_REV: String(Number(repoRev) + 1) })
const r2 = runChecker(bumped, TEMPLATE)
ok('退出码 1', r2.code === 1, 'exit=' + r2.code)
ok('指出是 CODEX_BRIDGE_REV 漂移', r2.out.includes('检测到漂移') && r2.out.includes('CODEX_BRIDGE_REV'), r2.out.split('\n').find((l) => l.includes('CODEX_BRIDGE_REV: 本机')) || '')
ok('给出"两份都要改"的动作建议', r2.out.includes('两份都要改'))
// 这一课是真实事故的核心：本机那份 REV 已经是最新的、仓库那份落后 ⇒ "把仓库改成同值"不产生 diff。
const stale = writePatch(path.join(ROOT, 'stale.yml'), { CODEX_BRIDGE_REV: String(Number(repoRev) - 1) })
const r2b = runChecker(stale, TEMPLATE)
ok('仓库落后于本机（只有 REV 这一项不同）时，提醒"把 REV 改成更大的值"', r2b.out.includes('把两份改成同一个**更大的**值'), r2b.out.split('\n').find((l) => l.includes('CODEX_BRIDGE_REV：本机')) || '')
// 真实事故那一课只在"两份 REV 相同、但内容仍有差异"时才有意义：构造那个形状来断言它确实被说了。
const sameRevDrift = writePatch(path.join(ROOT, 'same-rev-drift.yml'), { CODEX_DELEGATE_ALLOW_WRITE: 'false' })
const r2c = runChecker(sameRevDrift, TEMPLATE)
ok('两份 REV 相同但仍报漂移时，点出"光对齐这一项不会产生 diff、要再 +1"', r2c.code === 1 && r2c.out.includes('光对齐这一项**不会**产生 diff'), 'exit=' + r2c.code + ' ' + (r2c.out.split('\n').find((l) => l.includes('两份 CODEX_BRIDGE_REV')) || '').slice(0, 60))
const commentsOnly = fs.readFileSync(same, 'utf8') + '\n# 只是多了一行注释（非关键差异）\n'
const commentsFile = path.join(ROOT, 'comments-only.yml')
fs.writeFileSync(commentsFile, commentsOnly, 'utf8')
const r2d = runChecker(commentsFile, same)
ok('两份只有注释差异时判为一致（不误报漂移）', r2d.code === 0, 'exit=' + r2d.code)

console.log('\n— 3. 只对齐 REV 数字（两份恰好相同）时不得误报 —')
// 复现真实事故的形状：本机那份和仓库那份 REV 相同，但本机那份才是生效的那份。
const aligned = writePatch(path.join(ROOT, 'aligned.yml'))
const r3 = runChecker(aligned, TEMPLATE)
ok('REV 相同时判为一致（不误报）', r3.code === 0 && r3.out.includes('✓ 一致'), 'exit=' + r3.code)

console.log('\n— 4. 别的关键键漂移照样抓住 —')
const otherKey = writePatch(path.join(ROOT, 'other.yml'), { CODEX_DELEGATE_RUNS_DIR: 'D:\\somewhere\\else\\runs' })
const r4 = runChecker(otherKey, TEMPLATE)
ok('CODEX_DELEGATE_RUNS_DIR 取不同值时（两边都有值）判为漂移', r4.code === 1 && r4.out.includes('CODEX_DELEGATE_RUNS_DIR'), 'exit=' + r4.code)

console.log('\n— 5. 一边缺省、按默认值等价的键，标 ≈ 但不算漂移 —')
// 真实形状：模板写了 RUNS_DIR（等于默认值），本机那份没写 —— 行为等价，不该报失败。
const noRunsDir = writePatch(path.join(ROOT, 'no-runsdir.yml'), { CODEX_DELEGATE_RUNS_DIR: undefined })
const r5 = runChecker(noRunsDir, TEMPLATE)
ok('本机没写 RUNS_DIR（= 默认 $DSH_HOME 路径）⇒ 退出码 0', r5.code === 0, 'exit=' + r5.code)
ok('但仍把这一项列出来并标 ≈', r5.out.includes('≈') && r5.out.includes('CODEX_DELEGATE_RUNS_DIR'))

console.log('\n— 6. 边界：缺文件/无本机配置 —')
const r6 = runChecker(path.join(ROOT, 'does-not-exist.yml'), TEMPLATE)
ok('本机那份不存在 ⇒ 不适用、退出码 0（CI 即此情形）', r6.code === 0 && r6.out.includes('不适用'), 'exit=' + r6.code)
const r7 = runChecker(same, path.join(ROOT, 'no-template.yml'))
ok('仓库模板不存在 ⇒ 退出码 2（用法错误，不是漂移）', r7.code === 2, 'exit=' + r7.code)
fs.writeFileSync(path.join(ROOT, 'no-block.yml'), '# 只有注释，没有我们那块\n- id: other\n  name: \'x\'\n', 'utf8')
const r8 = runChecker(path.join(ROOT, 'no-block.yml'), TEMPLATE)
ok('本机那份没有 mcp-codex-delegate 块 ⇒ 判据不成立、退出码 2（不猜）', r8.code === 2, 'exit=' + r8.code)

console.log('\n— 7. 真实那两份：只读跑通（不规定结论，只要求能下结论）—')
const real = runChecker('', '') // 空 ⇒ 走脚本自己的默认路径（真实 DSH_HOME / 仓库模板）
ok('真实配置能得出"一致"或"漂移"的明确结论', real.code === 0 || real.code === 1, 'exit=' + real.code + ' ' + (real.out.includes('✓ 一致') ? '✓ 一致' : (real.out.includes('检测到漂移') ? '✗ 漂移' : '?')))
const before = fs.statSync(TEMPLATE).mtimeMs
runChecker('', '')
ok('检查器是只读的（仓库模板 mtime 未变）', fs.statSync(TEMPLATE).mtimeMs === before)

fs.rmSync(ROOT, { recursive: true, force: true })

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
if (failures.length > 0) console.log('失败项：\n  · ' + failures.join('\n  · '))
process.exit(fail === 0 ? 0 : 1)
