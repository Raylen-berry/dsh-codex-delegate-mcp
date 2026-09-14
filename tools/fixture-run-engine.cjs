/*
 * 假 Codex 引擎（verify-runs.mjs 专用夹具；**不是**套件，所以不叫 verify-*.mjs）。
 *
 * 用法：verify-runs.mjs 把本文件复制成 `<workspace>/mcp-server`
 * （**不带扩展名、且必须落在 allowedRoot 里** —— 桥是 `spawn(node, ['mcp-server'], { cwd: root })`；
 * Node 只为"首个参数无扩展名"走"当脚本执行"，`node mcp-server.cjs` 会被当成模块名去找
 * `mcp-server` ⇒ MODULE_NOT_FOUND）。
 *
 * 它按 CONTROL 文件里的场景回答 `codex` / `codex-reply` 的 tools/call：
 *   第 N 次调用用第 N 行，用完了沿用最后一行。场景词：success / tool_error / crash / hang，
 *   可带延时（`success:8000` = 8 秒后才回 —— 客户端取消那条断言必须让"取消"落在运行进行中）。
 * 它把**收到过的 arguments 原样追加**到 REQUESTS 文件里 —— 续跑断言就是靠这里比对
 * `codex-reply` 有没有带上原来那个 threadId。
 *
 * 全部离线：不联网、不调模型、不读真 Codex。
 */
const fs = require('fs')
const path = require('path')

const LOG = path.join(__dirname, 'fake-launches.log')
const CONTROL = path.join(__dirname, 'control.txt')
const REQUESTS = path.join(__dirname, 'requests.jsonl')
const DEBUG = path.join(__dirname, 'debug.log')
const THREAD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

fs.appendFileSync(LOG, 'launch\n')

const scenarios = () => fs.existsSync(CONTROL)
  ? fs.readFileSync(CONTROL, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  : ['success']

/**
 * 场景按 harness 的调用序号取，而**不是**本进程内的计数：引擎崩掉之后桥会重新拉起一个
 * 新引擎（本文件被重新执行、计数从 0 开始），按进程内计数取就会把场景串位。
 * REQUESTS 文件是跨引擎累积的，它的行数就是 harness 的调用序号。
 */
function requestsSoFar() {
  try {
    return fs.readFileSync(REQUESTS, 'utf8').split('\n').filter((l) => l.trim()).length
  } catch {
    return 0
  }
}
const scenarioFor = (n) => {
  const list = scenarios()
  return list[Math.min(n, list.length - 1)]
}

let buf = ''

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function notify(id, msg) {
  write({ jsonrpc: '2.0', method: 'codex/event', params: { _meta: { requestId: id }, msg } })
}

function respond(scenario, id, name, threadId) {
  if (scenario === 'success') {
    notify(id, {
      type: 'session_configured',
      permission_profile: { type: 'managed', file_system: { entries: [{ path: __dirname, access: 'read' }] } },
      approval_policy: 'never',
      cwd: __dirname,
      model: 'fake-model',
      rollout_path: path.join(__dirname, 'rollout-fake.jsonl'),
    })
    notify(id, { type: 'token_count', info: { total_token_usage: { total_tokens: 4242 } }, rate_limits: { primary: { used_percent: 7, window_minutes: 60 } } })
    notify(id, {
      type: 'item_completed',
      item: { type: 'command_execution', command: ['node', '-e', 'console.log(1)'], exit_code: 0, aggregated_output: 'ran a command' },
    })
    notify(id, {
      type: 'item_completed',
      item: { type: 'file_change', changes: [{ path: path.join(__dirname, 'artifact.txt'), kind: 'add' }] },
    })
    write({ jsonrpc: '2.0', id, result: { isError: false, structuredContent: { threadId, content: `fake reply to ${name}` } } })
    return
  }

  if (scenario === 'tool_error') {
    write({ jsonrpc: '2.0', id, result: { isError: true, structuredContent: { content: 'fake engine refused the task: FAKE_FAILURE' } } })
    return
  }

  if (scenario === 'crash') {
    // 引擎进程直接退出：运行被**中断**，不是"取消"。
    setTimeout(() => process.exit(9), 60)
    return
  }

  if (scenario === 'hang') {
    // 什么都不回：让桥自己的墙钟超时把它判成 cancelled/timeout。
    return
  }

  write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'fake engine unknown scenario: ' + scenario } })
}

process.stdin.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index)
    buf = buf.slice(index + 1)
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.method === 'initialize') {
      write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake-codex', version: '0' } } })
      continue
    }
    if (message.method !== 'tools/call') continue
    const name = message.params && message.params.name
    const args = (message.params && message.params.arguments) || {}
    const seq = requestsSoFar() + 1
    const scenario = scenarioFor(seq - 1)
    fs.appendFileSync(REQUESTS, JSON.stringify({ call: seq, name, args, scenario }) + '\n')
    const id = message.id
    const threadId = typeof args.threadId === 'string' && args.threadId.length > 0 ? args.threadId : THREAD
    const [kind, delayText] = scenario.split(':')
    const delay = Number.parseInt(delayText || '0', 10) || 0
    fs.appendFileSync(DEBUG, `call=${seq} tool=${name} scenario=${scenario} delay=${delay}ms\n`)
    if (delay > 0) setTimeout(() => respond(kind, id, name, threadId), delay)
    else respond(kind, id, name, threadId)
  }
})
process.stdin.resume()
