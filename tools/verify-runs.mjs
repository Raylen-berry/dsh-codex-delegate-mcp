// 验「委派运行记录」（0.3.0：run ledger + 查询/续跑/重试）。
//
// 覆盖 6 件事（全部离线：CODEX_BINARY 指向 node 自身 + tools/fixture-run-engine.cjs 假引擎）：
//   ① 一次成功委派 ⇒ 一条字段齐全的 run 记录
//   ② 失败 / 超时 ⇒ status 与失败原因正确（failed/tool_error、failed/engine_lost、
//      cancelled/timeout、cancelled/client_cancel）
//   ③ 记录能按 runId 查回、列表按开始时间倒序
//   ④ 续跑（retry_codex_run）用**原来那个 threadId**（假引擎把收到的 arguments 记下来了）
//   ⑤ 取消/超时的语义正确（超时=已发 notifications/cancelled 后不再等待 ⇒ cancelled；
//      引擎进程没了 ⇒ failed/engine_lost；客户端发 notifications/cancelled ⇒ cancelled/client_cancel）
//   ⑥ 记录里不出现 prompt 原文之外的敏感内容（Bearer / sk- / api_key= 一律被 redact 掉）
//
// 反向验证：设 CODEX_SERVER=改动前那份 server.mjs（例如 git worktree 里 HEAD 的那份），
// 本套件应当大量失败 —— 那一版根本没有运行记录。失败数会打在结尾。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const FIXTURE = process.env.CODEX_FIXTURE || path.join(HERE, 'fixture-run-engine.cjs')
const SERVER = path.resolve(process.env.CODEX_SERVER || path.join(REPO, 'server.mjs'))
const LABEL = process.env.CODEX_SERVER ? '（A：指定的 server.mjs → ' + SERVER + '）' : ''
const ROOT = path.join(os.tmpdir(), 'dsh-codex-runs-ab')
const WORK = path.join(ROOT, 'workspace')
const RUNS_DIR = path.join(ROOT, 'runs')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let pass = 0
let fail = 0
const failures = []
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : ''))
  } else {
    fail++
    failures.push(name)
    console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : ''))
  }
}

fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(RUNS_DIR, { recursive: true })
/*
 * 假引擎必须落在 **allowedRoot**（= WORK）里，名字叫 `mcp-server`、**不带扩展名**：
 *   · 桥是按 `spawn(node, ['mcp-server'], { cwd: allowedRoot })` 起的，cwd 是 allowedRoot，
 *     名字解析不到别处；
 *   · Node 只为「首个参数无扩展名」走"当脚本执行"，`node mcp-server.cjs` 会被当成模块名
 *     去找 `mcp-server` ⇒ MODULE_NOT_FOUND（本套件第一版就踩在这里）。
 * verify-engine-restart.mjs 用的是同一套手法。
 */
const FAKE_ENGINE = path.join(WORK, 'mcp-server')
fs.copyFileSync(FIXTURE, FAKE_ENGINE)

const CONTROL = path.join(WORK, 'control.txt')
const LAUNCHES = path.join(WORK, 'fake-launches.log')
const REQUESTS = path.join(WORK, 'requests.jsonl')
const setScenarios = (list) => fs.writeFileSync(CONTROL, list.join('\n') + '\n', 'utf8')
/*
 * 场景按**委派调用序号**对齐（假引擎用 requests.jsonl 的行数取序号，所以跨引擎重启也不会串位）：
 *   1 成功 · 2 工具层错误 · 3 挂着等超时 · 4 续跑成功 · 5 引擎崩溃 · 6 崩溃后重连成功
 *   7 客户端取消（回包拖 8 秒，保证"取消"落在运行进行中）· 8 成功
 */
setScenarios(['success', 'tool_error', 'hang', 'success', 'crash', 'success', 'success:8000', 'success'])
fs.writeFileSync(LAUNCHES, '')
fs.writeFileSync(REQUESTS, '')

console.log('假引擎：' + FAKE_ENGINE)
console.log('被测服务端：' + SERVER + ' ' + LABEL)
console.log('台账目录：' + RUNS_DIR)

const srv = spawn(process.execPath, [SERVER], {
  cwd: WORK,
  env: {
    ...process.env,
    CODEX_BINARY: process.execPath,
    CODEX_DELEGATE_ROOT: WORK,
    CODEX_DELEGATE_RUNS_DIR: RUNS_DIR,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let srvOut = ''
let srvErr = ''
let srvLineBuffer = ''
const responses = new Map()
srv.stdout.on('data', (chunk) => {
  srvOut += chunk.toString()
  // 必须自己缓冲**不完整行**：chunk 边界会切在 JSON 中间，逐行 try/catch 会把
  // 被切断的那两半都丢掉 ⇒ 某些响应永远读不到（本套件第一版就踩在这里）。
  srvLineBuffer += chunk.toString()
  const lines = srvLineBuffer.split('\n')
  srvLineBuffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      responses.set(message.id, message)
    }
  }
})
srv.stderr.on('data', (chunk) => {
  const text = chunk.toString()
  srvErr += text
  if (process.env.VERIFY_RUNS_VERBOSE) process.stdout.write('[server stderr] ' + text)
})

const send = (obj) => srv.stdin.write(JSON.stringify(obj) + '\n')
const call = (id, tool, args) => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } })
const takeText = (id) => {
  const message = responses.get(id)
  if (!message || !message.result) return ''
  return (message.result.content || []).map((block) => block.text || '').join('\n')
}
const isError = (id) => responses.get(id)?.result?.isError === true

/** 从结果头里取 `Key: value` 一行。 */
const header = (text, key) => {
  const match = new RegExp('^' + key + ': (.+)$', 'm').exec(text)
  return match ? match[1].trim() : ''
}

function readAllRecords() {
  const records = []
  for (const name of fs.readdirSync(RUNS_DIR).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(RUNS_DIR, name), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        /* 半截行忽略 */
      }
    }
  }
  return records
}

/** 一条 run 的最终形态：同 runId 后写覆盖先写。 */
function finalRecord(runId) {
  const mine = readAllRecords().filter((record) => record.runId === runId)
  return mine.length > 0 ? mine[mine.length - 1] : null
}

function recordRaw(runId) {
  return readAllRecords().filter((record) => record.runId === runId)
}

const REQUIRED_FIELDS = ['runId', 'status', 'kind', 'startedAt', 'finishedAt', 'durationMs', 'workspace', 'mode', 'timeoutSeconds', 'threadId', 'steps', 'stepCount', 'artifacts', 'resumable', 'promptChars', 'promptHead']

async function main() {
  console.log('\n— 1. 起 MCP 会话 —')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify-runs', version: '0' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await sleep(400)
  ok('服务端回话了', srvOut.includes('dsh-codex-delegate'), srvOut.slice(0, 60).replace(/\s+/g, ' '))

  console.log('\n— 2. ① 成功委派 ⇒ 一条字段齐全的记录 —')
  call(10, 'delegate_to_codex', { prompt: '列出工作区里的文件', workspace: WORK, mode: 'read-only', timeout_seconds: 30, include_activity: false, batch_id: 'batch-alpha' })
  await sleep(700)
  const successText = takeText(10)
  const runA = header(successText, 'Run').split(' ')[0]
  ok('结果头里给了 runId', /^[0-9a-f-]{36}$/.test(runA), 'runId=' + runA)
  const recordA = finalRecord(runA)
  ok('产生了 run 记录', recordA !== null)
  if (recordA) {
    const missing = REQUIRED_FIELDS.filter((field) => recordA[field] === undefined)
    ok('字段齐全', missing.length === 0, missing.length ? 'missing=' + missing.join(',') : REQUIRED_FIELDS.length + ' 字段')
    ok('status=succeeded', recordA.status === 'succeeded' && recordA.kind === 'completed', recordA.status + '/' + recordA.kind)
    ok('threadId 落盘', recordA.threadId === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', recordA.threadId)
    ok('steps 摘要非空（当前步骤也在）', Array.isArray(recordA.steps) && recordA.steps.length >= 3 && recordA.currentStep.length > 0, 'steps=' + recordA.stepCount + ' current=' + recordA.currentStep.slice(0, 40))
    ok('产物路径落盘', Array.isArray(recordA.artifacts) && recordA.artifacts.some((p) => p.endsWith('artifact.txt')), JSON.stringify(recordA.artifacts))
    ok('起止时间与耗时可用', recordA.finishedAt > recordA.startedAt && recordA.durationMs > 0, 'durationMs=' + recordA.durationMs)
    ok('可续跑标记为真', recordA.resumable === true)
    ok('batchId 落盘', recordA.batchId === 'batch-alpha', recordA.batchId)
    ok('记录里带引擎代数与 prompt 长度', recordA.engineGeneration === 1 && recordA.promptChars === '列出工作区里的文件'.length, 'gen=' + recordA.engineGeneration + ' chars=' + recordA.promptChars)
    ok('运行期间也写过 running 版本（不只是收尾写一次）', recordRaw(runA).some((r) => r.status === 'running'))
  }

  console.log('\n— 3. ② 失败：引擎回工具层错误 ⇒ failed/tool_error —')
  call(11, 'delegate_to_codex', { prompt: '这个会被假引擎拒绝', workspace: WORK, mode: 'read-only', timeout_seconds: 30, include_activity: false })
  await sleep(700)
  const failText = takeText(11)
  const runB = header(failText, 'Run').split(' ')[0]
  ok('失败结果被标成 isError', isError(11) === true)
  const recordB = finalRecord(runB)
  ok('重复了失败原因（DELEGATION FAILED 仍在）', failText.includes('DELEGATION FAILED'))
  ok('status=failed 且 kind=tool_error', recordB?.status === 'failed' && recordB?.kind === 'tool_error', recordB ? recordB.status + '/' + recordB.kind : '(no record)')
  ok('失败原因可读且含引擎原文', typeof recordB?.error?.detail === 'string' && recordB.error.detail.includes('FAKE_FAILURE'), recordB?.error?.detail || '')
  ok('失败运行不可续跑（thread 未被信任）', recordB?.resumable === false)

  console.log('\n— 4. ② 超时 ⇒ cancelled/timeout（复用既有的超时取消语义）—')
  // timeout_seconds 的下界是 10（server.mjs 的既有约束），所以这里必须真等过 10s；
  // 挂着的假引擎什么都不回，超时一定由桥自己的墙钟触发。
  call(12, 'delegate_to_codex', { prompt: '这个会挂到超时', workspace: WORK, mode: 'read-only', timeout_seconds: 10, include_activity: false })
  await sleep(11500)
  const timeoutText = takeText(12)
  const runC = header(timeoutText, 'Run').split(' ')[0]
  ok('超时结果报 DELEGATION FAILED 且提示 timed out', isError(12) === true && timeoutText.includes('timed out after 10s'), timeoutText.split('\n')[0].slice(0, 70))
  const recordC = finalRecord(runC)
  ok('status=cancelled 且 kind=timeout', recordC?.status === 'cancelled' && recordC?.kind === 'timeout', recordC ? recordC.status + '/' + recordC.kind : '(no record)')
  ok('超时的失败原因写进了记录', typeof recordC?.error?.detail === 'string' && recordC.error.detail.includes('timed out after 10s'))

  console.log('\n— 5. ④ 续跑：retry_codex_run 必须用原来那个 threadId —')
  call(13, 'retry_codex_run', { run_id: runA, prompt: '接着上次那条 thread 继续', include_activity: false })
  await sleep(700)
  const retryText = takeText(13)
  const runD = header(retryText, 'Run').split(' ')[0]
  const recordD = finalRecord(runD)
  ok('续跑产生了**新**记录', runD.length > 0 && runD !== runA, 'parent=' + runA + ' child=' + runD)
  ok('新记录 parentRunId 指向原 run', recordD?.parentRunId === runA, recordD?.parentRunId || '')
  ok('新记录沿用同一 threadId', recordD?.threadId === recordA?.threadId, recordD?.threadId || '')
  const retryCall = fs.readFileSync(REQUESTS, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.name === 'codex-reply')
  ok('假引擎**收到的**是 codex-reply + 原 threadId', retryCall !== undefined && retryCall.args.threadId === recordA?.threadId, retryCall ? 'tool=codex-reply thread=' + retryCall.args.threadId : 'no codex-reply call seen')
  ok('续跑那次没把自己的 workspace/mode 塞进 codex-reply（引擎不接受）', retryCall !== undefined && retryCall.args.cwd === undefined && retryCall.args.sandbox === undefined)
  ok('原记录没被改写（仍在，succeeded）', finalRecord(runA)?.status === 'succeeded')

  console.log('\n— 6. ② 引擎进程没了 ⇒ failed/engine_lost（不是 cancelled）—')
  const launchesBeforeCrash = fs.readFileSync(LAUNCHES, 'utf8').split('\n').filter(Boolean).length
  call(14, 'delegate_to_codex', { prompt: '这个会让假引擎崩掉', workspace: WORK, mode: 'read-only', timeout_seconds: 30, include_activity: false })
  await sleep(2000)
  const crashText = takeText(14)
  const runE = header(crashText, 'Run').split(' ')[0]
  const recordE = finalRecord(runE)
  ok('status=failed 且 kind=engine_lost', recordE?.status === 'failed' && recordE?.kind === 'engine_lost', recordE ? recordE.status + '/' + recordE.kind : '(no record)')
  const launchesAfterCrash = fs.readFileSync(LAUNCHES, 'utf8').split('\n').filter(Boolean).length
  ok('崩溃那次运行不标成可续跑', recordE?.resumable === false)
  ok('记录里带引擎代数（崩溃前是第 1 代）', recordE?.engineGeneration >= 1, 'gen=' + recordE?.engineGeneration)
  // 引擎是被**懒启动**的：崩溃不会自己拉一个新的，下一次委派才拉（既有设计）。
  // 所以这里用"崩溃之后再委派一次"作为重启的观测点，而不是等一个不存在的自动重启。
  call(21, 'delegate_to_codex', { prompt: '崩溃之后再来一次', workspace: WORK, mode: 'read-only', timeout_seconds: 30, include_activity: false })
  await sleep(700)
  const recoveryText = takeText(21)
  const runH = header(recoveryText, 'Run').split(' ')[0]
  ok('引擎崩溃后下一次委派仍能成功（既有行为没破）', finalRecord(runH)?.status === 'succeeded', 'runH=' + runH + ' status=' + (finalRecord(runH)?.status ?? '(none)'))
  const launchesAfterRecovery = fs.readFileSync(LAUNCHES, 'utf8').split('\n').filter(Boolean).length
  ok('引擎崩溃后确实重新拉起了一个新引擎', launchesAfterRecovery > launchesBeforeCrash, 'launches ' + launchesBeforeCrash + ' → ' + launchesAfterRecovery)
  // 代数在引擎退役时归零，所以崩溃后拉起的**新**引擎又是第 1 代；这个数字回答的是
  // "记录里那次运行用的引擎还活着吗"，不是"本进程一共起过几个引擎"。
  ok('新引擎在记录里是第 1 代（代数随退役归零）', finalRecord(runH)?.engineGeneration === 1, 'gen=' + finalRecord(runH)?.engineGeneration)

  console.log('\n— 7. ⑤ 客户端取消 ⇒ cancelled/client_cancel —')
  // 这一步的假引擎是 success:8000（8 秒后才回，见 setScenarios），所以"取消"必然落在
  // 运行**进行中**：改前 400ms 就发取消，假引擎早就回完了，取消到的只是收尾之后的空档。
  call(20, 'delegate_to_codex', { prompt: '这个会被客户端取消', workspace: WORK, mode: 'read-only', timeout_seconds: 30, include_activity: false })
  await sleep(300)
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 20 } })
  await sleep(700)
  const cancelText = takeText(20)
  const runF = header(cancelText, 'Run').split(' ')[0]
  const recordF = finalRecord(runF)
  ok('status=cancelled 且 kind=client_cancel', recordF?.status === 'cancelled' && recordF?.kind === 'client_cancel', recordF ? recordF.status + '/' + recordF.kind : '(no record)')
  ok('取消的错误原因写进记录', typeof recordF?.error?.detail === 'string' && recordF.error.detail.length > 0, recordF?.error?.detail?.slice(0, 60) || '')
  ok('取消的运行不标成可续跑', recordF?.resumable === false)

  console.log('\n— 8. ③ 查询入口：单条明细 + 列表倒序 —')
  const secret = 'sk-abcdefghijklmnopqrst'
  call(15, 'delegate_to_codex', { prompt: `帮我看看 https://example.com/api?q=1 这个接口。Authorization: Bearer ${secret} api_key=${secret}`, workspace: WORK, mode: 'read-only', timeout_seconds: 30, include_activity: false })
  await sleep(900)
  const secretText = takeText(15)
  const runG = header(secretText, 'Run').split(' ')[0]
  ok('第六条记录也产生了', finalRecord(runG) !== null, 'runG=' + runG)

  call(16, 'get_codex_run', { run_id: runA })
  await sleep(300)
  const detail = takeText(16)
  ok('get_codex_run 能按 runId 取回单条', detail.includes(`runId: ${runA}`) && detail.includes('status: succeeded'))
  ok('明细里有失败原因/产物/步骤/threadId 四块', detail.includes('artifacts (') && detail.includes('steps digest:') && detail.includes('threadId: ') && detail.includes('failure: '))
  call(17, 'get_codex_run', { run_id: 'no-such-run' })
  await sleep(200)
  ok('未知 runId 明确报错（isError）', isError(17) === true, takeText(17).slice(0, 60))

  call(18, 'list_codex_runs', { limit: 20 })
  await sleep(400)
  const list = takeText(18)
  // describeRun 的一行长这样：`<ISO 时间>  <runId>  <status>/<kind>  …` ⇒ runId 是第 2 个词
  const listOrder = list.split('\n').filter((line) => line.includes('  · ')).map((line) => line.trim().split(/\s+/)[2])
  const expectedOrder = [runG, runF, runH, runE, runD, runC, runB, runA]
  ok('列表按开始时间倒序（最新在前）', JSON.stringify(listOrder) === JSON.stringify(expectedOrder), listOrder.join(' > '))
  ok('列表给了台账目录', list.includes(RUNS_DIR))

  call(19, 'list_codex_runs', { status: 'cancelled' })
  await sleep(300)
  const cancelledList = takeText(19)
  ok('可以只列 cancelled', cancelledList.includes(runC) && cancelledList.includes(runF) && !cancelledList.includes(runA), cancelledList.split('\n')[0])

  call(22, 'list_codex_runs', { limit: 50 })
  await sleep(300)
  const allRuns = takeText(22)
  ok('可以放大 limit 列出全部', allRuns.includes(runA) && allRuns.includes(runG), allRuns.split('\n')[0])

  console.log('\n— 9. 桥在 spawn 之前就拒绝 ⇒ 也留一条可查的痕 —')
  call(23, 'delegate_to_codex', { prompt: '这个工作区在允许根之外', workspace: path.join(os.tmpdir(), 'outside-the-root'), mode: 'read-only', timeout_seconds: 30, include_activity: false })
  await sleep(500)
  const refusalText = takeText(23)
  const runI = header(refusalText, 'Run').split(' ')[0]
  const recordI = finalRecord(runI)
  ok('拒绝响应里带 runId（否则这条记录等于查不到）', /^[0-9a-f-]{36}$/.test(runI), 'runI=' + runI)
  ok('原有报错文案一字未改', refusalText.includes('workspace must stay inside the allowed root'), refusalText.split('\n').slice(-1)[0].slice(0, 70))
  ok('拒绝也产生了记录', recordI !== null && runI.length > 0, 'runI=' + runI)
  ok('拒绝记成 failed/refused', recordI?.status === 'failed' && recordI?.kind === 'refused', recordI ? recordI.status + '/' + recordI.kind : '(no record)')
  ok('拒绝原因写进记录', typeof recordI?.error?.detail === 'string' && recordI.error.detail.includes('must stay inside the allowed root'), recordI?.error?.detail?.slice(0, 60) || '')
  ok('拒绝的记录不可续跑（没有 thread、没有步骤）', recordI?.resumable === false && recordI?.threadId === '' && recordI?.stepCount === 0, 'thread=' + (recordI?.threadId ?? '?') + ' steps=' + (recordI?.stepCount ?? '?'))

  console.log('\n— 10. ⑥ 记录里不得出现敏感内容 —')
  const recordG = finalRecord(runG)
  ok('prompt 只存前 200 字的 head', recordG?.promptHead.length <= 201, 'head 长度=' + (recordG?.promptHead?.length ?? -1) + ' chars=' + recordG?.promptChars)
  ok('head 里不含 sk- 原文', !String(recordG?.promptHead).includes(secret), recordG?.promptHead || '')
  ok('head 里不含 Bearer 原文', !/Bearer\s+(?!\*\*\*)/.test(String(recordG?.promptHead)), recordG?.promptHead || '')
  ok('URL 仍在（证明只脱敏凭证，不是把整行糊掉）', String(recordG?.promptHead).includes('https://example.com/api?q=1'))
  const dump = JSON.stringify(readAllRecords())
  ok('整本台账没有 sk- 明文', !dump.includes(secret))
  ok('整本台账没有 Bearer 明文', !/Bearer\s+(?!\*\*\*)/.test(dump))
  ok('整本台账没有 api_key= 明文值', !/api[_-]?key\s*[=:]\s*(?!\*\*\*)/i.test(dump))
  ok('记录里没有存整段 prompt 原文的字段', [...readAllRecords()].every((record) => !Object.values(record).some((value) => typeof value === 'string' && value.length > 600)))
}

try {
  await main()
} catch (error) {
  fail++
  failures.push('套件异常：' + (error?.message || error))
  console.log('  FAIL  套件异常：' + (error?.stack || error))
}

/*
 * 失败时把服务端/引擎 stderr 的尾部打出来：诊断假引擎起不来、握手失败这类问题全靠它，
 * 而套件平时不该刷屏。
 */
if (process.env.VERIFY_RUNS_VERBOSE) {
  console.log('\n[verbose] 假引擎调用流水：')
  console.log(fs.existsSync(path.join(WORK, 'debug.log')) ? fs.readFileSync(path.join(WORK, 'debug.log'), 'utf8').trim() : '(无)')
  console.log('[verbose] 假引擎启动次数：' + fs.readFileSync(LAUNCHES, 'utf8').split('\n').filter(Boolean).length)
}
srv.kill()
await sleep(150)
try { srv.kill('SIGKILL') } catch { /* ignore */ }
fs.rmSync(ROOT, { recursive: true, force: true })

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
if (failures.length > 0) console.log('失败项：\n  · ' + failures.join('\n  · '))
if (fail > 0 && srvErr.trim().length > 0) console.log('\n服务端/引擎 stderr 尾部：\n' + srvErr.trim().split('\n').slice(-12).join('\n'))
process.exit(fail === 0 ? 0 : 1)
