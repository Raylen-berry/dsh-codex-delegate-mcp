// 验「Codex 引擎退出后能否重新建连」（2026-09-14 审计 P1）。
//
// 缺陷形状：引擎是懒启动 + 缓存的 promise（enginePromise）。退出路径把 engine 置 null，
// 但那个 promise 已经 **resolve** 过（initialize 成功过），close 里的 reject 对已 resolve 的
// promise 是空操作 ⇒ enginePromise 留着、engine 为空、exited 无人再看 ⇒ 守卫判定"还能用"，
// 把那个装着死引擎的旧 promise 返回回去；后续请求往死进程里写 JSON-RPC。
//
// 本夹具用真进程做端到端：CODEX_BINARY 指向 node 自己，配一个名为 `mcp-server` 的假引擎脚本
// （server.mjs 的启动方式是 spawn(codexBinary, ['mcp-server'])，cwd 继承）。
// 假引擎：先正常回答 initialize（这样 promise 会 resolve），120ms 后 exit(7) 模拟崩溃。
// 判据只有一个：**第二次请求有没有真的再拉起一个引擎**（数假引擎的启动日志）。
//
// A/B：把 CODEX_SERVER 指到改动前的 server.mjs 应当**只启动 1 次**（复现），改动后应当 2 次。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SERVER = process.env.CODEX_SERVER || path.resolve(HERE, '../server.mjs')
const ROOT = path.join(os.tmpdir(), 'dsh-codex-restart-ab')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// 改动前那份：从 git HEAD 物化（避开 PowerShell 重定向的编码坑）
// 注意目录必须**在 ROOT 之外**：下面会 rmSync(ROOT) 清夹具，写在里面会被自己删掉。
if (process.env.CODEX_SERVER_BEFORE) {
  const SRCDIR = ROOT + '-srv'
  fs.mkdirSync(SRCDIR, { recursive: true })
  const dest = path.join(SRCDIR, 'server-before.mjs')
  const buf = execFileSync('git', ['-C', REPO, 'cat-file', 'blob', 'HEAD:server.mjs'], { maxBuffer: 1e8 })
  fs.writeFileSync(dest, buf)
  console.log('  （A：改动前的 server.mjs → ' + dest + '，' + buf.length + ' 字节）')
  process.env.CODEX_SERVER = dest
}

fs.rmSync(ROOT, { recursive: true, force: true })
const WORK = path.join(ROOT, 'workspace')
fs.mkdirSync(WORK, { recursive: true })
// 台账目录必须钉在**本套件自己的临时区**：桥的默认落点是 $DSH_HOME/dsh-codex-delegate-mcp/runs/，
// 而本套件起的是真 server.mjs（继承环境）⇒ 本机开发时会把假委派记录写进用户真实数据目录
// （2026-09-14 实测污染过 24 行）。run-all.mjs 也会统一注入，这里再本地兜一层：单独跑本文件同样安全。
if (typeof process.env.CODEX_DELEGATE_RUNS_DIR !== 'string' || process.env.CODEX_DELEGATE_RUNS_DIR.length === 0) {
  process.env.CODEX_DELEGATE_RUNS_DIR = path.join(ROOT, 'runs')
}
fs.mkdirSync(process.env.CODEX_DELEGATE_RUNS_DIR, { recursive: true })
// 引擎进程的 env 是 server.mjs 裁剪过的，所以日志**不能靠环境变量**传：
// 假引擎把启动记录写在它自己的目录（= allowedRoot = WORK）里。
const LOG = path.join(WORK, 'fake-launches.log')
fs.writeFileSync(LOG, '')

// 假引擎：文件名就叫 mcp-server，必须落在 allowedRoot —— server.mjs 用 `cwd: allowedRoot`
// 加 `spawn(codexBinary, ['mcp-server'])` 拉起它（实测：放别处会因为找不到脚本而 spawn 失败）。
const FAKE = `
const fs = require('fs')
const path = require('path')
const LOG = path.join(__dirname, 'fake-launches.log')
fs.appendFileSync(LOG, 'launch\\n')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m && m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake-codex', version: '0' } } }) + '\\n')
      // 握手成功之后才"崩溃"——这正是审计描述的场景（promise 已 resolve + 引擎已退出）
      setTimeout(() => process.exit(7), 120)
    }
  }
})
process.stdin.resume()
`
fs.writeFileSync(path.join(WORK, 'mcp-server'), FAKE)

const target = process.env.CODEX_SERVER || SERVER
const srv = spawn(process.execPath, [target], {
  cwd: ROOT,
  env: { ...process.env, CODEX_BINARY: process.execPath, CODEX_DELEGATE_ROOT: WORK, FAKE_LOG: LOG },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let srvOut = ''
srv.stdout.on('data', (c) => { srvOut += c.toString() })
srv.stderr.on('data', () => {})

const send = (obj) => srv.stdin.write(JSON.stringify(obj) + '\n')
const launches = () => fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim()).length
const callDelegate = (id) => send({
  jsonrpc: '2.0', id,
  method: 'tools/call',
  params: { name: 'delegate_to_codex', arguments: { prompt: '从 1 数到 3', workspace: WORK, mode: 'read-only', timeout_seconds: 10, include_activity: false } },
})

console.log('— 1. 起 MCP 会话 —')
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ab', version: '0' } } })
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
await sleep(400)
ok('服务端回话了', srvOut.includes('serverInfo') || srvOut.includes('dsh-codex-delegate'), srvOut.slice(0, 60).replace(/\s+/g, ' '))

console.log('\n— 2. 第一次请求：拉起引擎（假引擎握手成功后崩溃）—')
callDelegate(2)
await sleep(900)
const afterFirst = launches()
ok('第一次请求确实拉起了引擎', afterFirst === 1, 'launches=' + afterFirst)

console.log('\n— 3. 第二次请求：引擎已退出，必须**重新建连** —')
callDelegate(3)
await sleep(900)
const afterSecond = launches()
ok('引擎退出后第二次请求又拉起一个（这就是原缺陷卡住的地方）', afterSecond >= 2, 'launches=' + afterSecond)

srv.kill()
await sleep(120)
try { srv.kill('SIGKILL') } catch { /* ignore */ }
fs.rmSync(ROOT, { recursive: true, force: true })

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
