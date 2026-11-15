/**
 * smoke.mjs —— 假宿主集成冒烟：不启动 DSH，用最小 cordis 仿真跑完整链路。
 *
 * 覆盖：
 *   1. 加载真实 lib/index.js，确认 exports.apply/inject/name 契约。
 *   2. 提示词 section 注册成功，文本里带工作区路径与「何时去读」的说明。
 *   3. persona_profile 工具注册成功（含 parameters/output 形状）。
 *   4. 只采集真人发言：运行时快照、子代理回报、别的插件 notice 都不算。
 *   5. 定时 tick → 调 llm.stream → 解析 JSON → 合并 → 写 profile.md/json/journal。
 *   6. 失败路径：模型返回垃圾 → 旧档案不丢、缓冲保留、写失败流水。
 *   7. 工具 read/summary/refresh/status 四个动作。
 *   8. 管理面 /state /profile /refresh，以及跨站拒绝。
 *   9. 重复 apply 幂等（不重复注册 section/工具/定时器）。
 *
 * 用法：node scripts/smoke.mjs（全部通过打印 PASS 并以 0 退出）
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../lib/index.js')

let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log('  ✓ ' + label)
  } catch (err) {
    failures += 1
    console.log('  ✗ ' + label + '\n      ' + (err instanceof Error ? err.message : String(err)))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ───────────────────────────────────────────────────────── 假模型

/** 一次「模型」返回：把 chunks 逐个吐出，最后给 finish。 */
function makeLlm(options = {}) {
  const calls = []
  const respond = options.respond ?? (() => JSON.stringify({
    summary: '要求结论先行、讨厌寒暄',
    traits: [{ label: '注重效率', detail: '结论先行，细节后置', confidence: 0.8, evidence: ['直接说结论'] }],
    communication: { style: '极简' },
    preferences: [{ topic: '格式', detail: '表格优先' }],
    values: ['效率'],
    dislikes: ['客套'],
    interaction_tips: ['直接给结果'],
    open_questions: [],
  }))
  return {
    calls,
    listProviders: () => [{ id: 'fake-provider', models: [{ id: 'fake-model' }] }],
    stream(request) {
      calls.push(request)
      const text = respond(request)
      const chunks = String(text).match(/[\s\S]{1,40}/g) ?? []
      return (async function* generate() {
        if (options.delayMs !== undefined) await sleep(options.delayMs)
        for (const piece of chunks) yield { type: 'text-delta', text: piece }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

// ───────────────────────────────────────────────────────── 假宿主

function createHost(options = {}) {
  const listeners = new Map()
  const routes = new Map()
  const effects = []
  const toolDefinitions = []
  const sections = new Map()

  const systemPrompt = {
    getSectionOrder: (name) => (name === 'FILE_REFERENCE' ? 900 : 600),
    section(spec) {
      if (sections.has(spec.name)) throw new Error('prompt section "' + spec.name + '" is already registered')
      sections.set(spec.name, spec)
      return () => sections.delete(spec.name)
    },
  }

  const tools = {
    register(definition) {
      if (toolDefinitions.some((item) => item.name === definition.name)) {
        throw new Error('duplicate tool ' + definition.name)
      }
      toolDefinitions.push(definition)
      return () => {
        const index = toolDefinitions.indexOf(definition)
        if (index >= 0) toolDefinitions.splice(index, 1)
      }
    },
  }

  const llm = options.llm ?? makeLlm()
  const agents = {
    list: () => options.agents ?? [],
    on: () => () => {},
  }
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate exact route ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  function makeCtx() {
    const scope = {
      logger: { info() {}, warn() {}, error() {} },
      effect(fn) {
        effects.push(fn())
      },
      on(event, fn) {
        const bucket = listeners.get(event) ?? []
        bucket.push(fn)
        listeners.set(event, bucket)
        return () => {}
      },
      get(service) {
        if (service === 'systemPrompt') return systemPrompt
        if (service === 'tools') return tools
        if (service === 'llm') return llm
        if (service === 'agents') return agents
        if (service === 'webServer') return webServer
        return undefined
      },
      inject(deps, callback) {
        const injected = {
          logger: scope.logger,
          effect: scope.effect,
          on: scope.on,
          get: (service) => scope.get(service),
        }
        for (const dep of deps) {
          if (dep === 'webServer') injected.webServer = webServer
          if (dep === 'agents') injected.agents = agents
          if (dep === 'tools') injected.tools = tools
          if (dep === 'systemPrompt') injected.systemPrompt = systemPrompt
        }
        callback(injected)
      },
    }
    return scope
  }

  const ctx = makeCtx()
  return {
    ctx,
    llm,
    routes,
    effects,
    sections,
    toolDefinitions,
    tool: () => toolDefinitions[0],
    async emit(event, ...args) {
      const bucket = (listeners.get(event) ?? []).slice()
      for (const fn of bucket) await fn(...args)
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}

// ───────────────────────────────────────────────────────── 假 req/res

function makeReq({ method = 'GET', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers: { host: '127.0.0.1:57321', 'sec-fetch-site': 'same-origin', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
    },
    end(chunk) {
      if (typeof chunk === 'string') res.body += chunk
      else if (chunk !== undefined) res.body += chunk.toString('utf8')
    },
  }
  return res
}

async function call(host, path, reqOptions) {
  const route = host.routes.get(path)
  assert.ok(route !== undefined, '没有注册路由 ' + path)
  const res = makeRes()
  await route.handler(makeReq(reqOptions), res)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

// ───────────────────────────────────────────────────────── 夹具

const dir = mkdtempSync(join(tmpdir(), 'dsh-persona-smoke-'))
/** 插件内部会把路径统一成正斜杠，比较时用同一形态。 */
const dirSlash = dir.replace(/\\/g, '/')
const API = '/api/dsh-persona-profile'

function userMessage(text, extra = {}) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra } }
}

const host = createHost()
const settings = {
  dir,
  intervalMinutes: 1,
  minNewMessages: 2,
  minChars: 5,
  tickSeconds: 3600, // 定时器别在用例里乱跑，tick 手动调
  stateSaveDelayMs: 10,
  debug: true,
}
plugin.apply(host.ctx, settings)
await sleep(30) // 等 persona_profile 的 defineTool 惰性加载落地

console.log('dsh-persona-profile 宿主半冒烟（工作区 ' + dir + '）')

await check('导出形状', () => {
  assert.equal(plugin.name, 'dsh-persona-profile')
  assert.deepEqual(plugin.inject, [], '不硬依赖任何服务：没有 webServer/tools 的 profile 也要能生效')
  assert.equal(typeof plugin.apply, 'function')
})

await check('工作区初始化：README / profile.md / profile.json / sessions', () => {
  for (const file of ['README.md', 'profile.md', 'profile.json', 'sessions']) {
    assert.ok(existsSync(join(dir, file)), '缺少 ' + file)
  }
})

await check('提示词 section 注册在全局层，文本指向 F:/性格 与 persona_profile', () => {
  const section = host.sections.get('persona:profile')
  assert.ok(section !== undefined, '缺 persona:profile section')
  assert.equal(section.order, 900, '应复用 FILE_REFERENCE 槽位')
  const text = section.text()
  assert.ok(text.includes(dirSlash), 'section 应给出档案路径，实际：' + text)
  assert.ok(text.includes('persona_profile'), 'section 应告诉模型用哪个工具')
  assert.ok(text.includes('隐私'), 'section 应包含隐私提醒')
})

await check('persona_profile 工具注册成功且形状合法', () => {
  const definition = host.tool()
  assert.ok(definition !== undefined, '缺工具注册')
  assert.equal(definition.name, 'persona_profile')
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['action'])
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(definition.isConcurrencySafe(), true)
})

await check('只采集真人发言（快照/回报/notice 一律忽略）', async () => {
  await host.emit('session/event', { id: 's1' }, { type: 'user/message', data: { content: [{ type: 'text', text: '快照' }], source: { kind: 'runtime-context', form: 'snapshot' } } })
  await host.emit('session/event', { id: 's1' }, { type: 'user/message', data: { content: [{ type: 'text', text: '子代理回报' }], source: { kind: 'agent-message', form: 'relay' } } })
  await host.emit('session/event', { id: 's1' }, { type: 'user/message', data: { content: [{ type: 'text', text: '插件提醒' }], source: { kind: 'subagent-policy', form: 'notice' } } })
  await host.emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(host.llm.calls.length, 0, '不该触发总结')

  await host.emit('session/event', { id: 's1' }, userMessage('直接说结论，别绕'))
  await host.emit('session/event', { id: 's1' }, userMessage('表格优先，别写大段文字'))
  await sleep(60) // 等 state.json 的防抖落盘

  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(state.sessions.s1.pending.length, 2, '两条真人发言应入库')
  assert.equal(state.sessions.s1.pending[0].text, '直接说结论，别绕')
})

await check('定时 tick → 调模型 → 合并 → 落盘三件套', async () => {
  const { createSummarizer } = await import('../lib/summarizer.js')
  assert.equal(typeof createSummarizer, 'function')
  // 通过管理面触发一次 tick 等价路径：直接用插件暴露的 refresh 路由（force）
  const result = await call(host, API + '/refresh', { method: 'POST', body: { sessionId: 's1' } })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.equal(host.llm.calls.length, 1, '应该只发一次模型请求')

  const request = host.llm.calls[0]
  assert.equal(request.provider, 'fake-provider')
  assert.equal(request.model, 'fake-model')
  assert.equal(request.maxTokens, 2000)
  assert.equal(request.messages.length, 2)
  assert.equal(request.messages[0].role, 'system')
  assert.equal(request.messages[1].role, 'user')
  assert.ok(request.messages[1].content[0].text.includes('直接说结论，别绕'))

  const markdown = readFileSync(join(dir, 'profile.md'), 'utf8')
  assert.ok(markdown.includes('要求结论先行'), 'profile.md 应写入模型给的一句话')
  assert.ok(markdown.includes('注重效率'), 'profile.md 应包含特征')
  assert.ok(markdown.includes('表格优先'), 'profile.md 应包含偏好')

  const json = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))
  assert.equal(json.traits[0].label, '注重效率')
  assert.equal(json.meta.observations, 2, '应记录样本数')

  const journal = readFileSync(join(dir, 'journal.md'), 'utf8')
  assert.ok(journal.includes('注重效率'), '流水里应记录新增特征')

  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(state.sessions.s1.pending.length, 0, '成功后缓冲应清空')
  assert.ok(state.sessions.s1.lastSummarizedAt > 0)
})

await check('section 文本随档案更新（每 step 求值）', () => {
  const section = host.sections.get('persona:profile')
  const text = section.text()
  assert.ok(text.includes('最后更新'), '应显示最后更新时间')
  assert.ok(text.includes('要求结论先行'), '应带上最新的一句话画像')
})

await check('工具 read / summary / status', async () => {
  const definition = host.tool()
  const exec = { agent: { id: 's1' } }

  const read = await definition.execute({ action: 'read' }, exec)
  assert.equal(read.action, 'read')
  assert.ok(read.text.includes('# 用户性格档案'))
  assert.ok(read.path.endsWith('profile.md'))

  const summary = await definition.execute({ action: 'summary' }, exec)
  assert.ok(summary.text.includes('要求结论先行'))
  assert.ok(summary.text.includes('次观察'))

  const status = await definition.execute({ action: 'status' }, exec)
  const parsed = JSON.parse(status.text)
  assert.equal(parsed.dir, dirSlash)
  assert.equal(parsed.rounds, 1)

  // 缺省 action 走 read
  const fallback = await definition.execute({}, exec)
  assert.equal(fallback.action, 'read')
})

await check('工具 refresh：没有新样本时给明确说明，不硬发请求', async () => {
  const definition = host.tool()
  const before = host.llm.calls.length
  const result = await definition.execute({ action: 'refresh' }, { agent: { id: 's1' } })
  assert.equal(host.llm.calls.length, before, '空缓冲不该再调模型')
  assert.ok(result.text.includes('没有待总结'))
  assert.equal(result.note, 'empty')
})

await check('模型返回垃圾：旧档案不丢、缓冲保留、失败留痕', async () => {
  const badHost = createHost({ llm: makeLlm({ respond: () => '我不知道该总结什么' }) })
  plugin.apply(badHost.ctx, { ...settings, tickSeconds: 3600 })
  await sleep(30)

  await badHost.emit('session/event', { id: 's2' }, userMessage('随便聊聊'))
  await badHost.emit('session/event', { id: 's2' }, userMessage('今天天气不错'))
  const before = readFileSync(join(dir, 'profile.md'), 'utf8')

  const definition = badHost.tool()
  const result = await definition.execute({ action: 'refresh' }, { agent: { id: 's2' } })
  assert.ok(result.text.includes('刷新未完成'), '应明确告知刷新失败')
  assert.equal(result.note, 'bad-json')

  assert.equal(readFileSync(join(dir, 'profile.md'), 'utf8'), before, '档案不该被垃圾输出覆盖')
  const journal = readFileSync(join(dir, 'journal.md'), 'utf8')
  assert.ok(journal.includes('PARSE-ERROR'), '流水里应留下解析失败记录')
})

await check('管理面 /state 与 /profile', async () => {
  const state = await call(host, API + '/state')
  assert.equal(state.status, 200)
  assert.equal(state.json.dir, dirSlash)
  assert.equal(state.json.rounds, 1)
  assert.ok(state.json.paths.profile.endsWith('profile.md'))

  const profile = await call(host, API + '/profile')
  assert.equal(profile.status, 200)
  assert.ok(profile.json.markdown.includes('# 用户性格档案'))
  assert.equal(profile.json.profile.traits[0].label, '注重效率')
})

await check('管理面拒绝跨站与非回环请求', async () => {
  const crossSite = await call(host, API + '/state', { headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  const remote = await call(host, API + '/profile', { remoteAddress: '10.0.0.8' })
  assert.equal(remote.status, 403)
  const wrongMethod = await call(host, API + '/state', { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
})

await check('重复 apply 幂等（不重复 section/工具/监听器）', () => {
  const sectionsBefore = host.sections.size
  const toolsBefore = host.toolDefinitions.length
  const listenersBefore = host.listenerCount('session/event')
  plugin.apply(host.ctx, settings)
  assert.equal(host.sections.size, sectionsBefore)
  assert.equal(host.toolDefinitions.length, toolsBefore)
  assert.equal(host.listenerCount('session/event'), listenersBefore)
})

await check('卸载后重新 apply 会重新装配（回归：重载后工具/路由整片消失）', async () => {
  const reload = createHost()
  plugin.apply(reload.ctx, { ...settings, tickSeconds: 3600 })
  await sleep(30)
  assert.ok(reload.sections.has('persona:profile'))
  assert.ok(reload.tool() !== undefined)

  // 模拟 cordis 卸载：把 ctx.effect 注册的东西全拆掉
  for (const dispose of reload.effects.splice(0)) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      /* 单个 disposer 失败不影响其他 */
    }
  }
  assert.equal(reload.sections.size, 0, '卸载后 section 应被摘掉')

  plugin.apply(reload.ctx, { ...settings, tickSeconds: 3600 })
  await sleep(30)
  assert.ok(reload.sections.has('persona:profile'), '重装后必须重新挂上 section')
  assert.ok(reload.tool() !== undefined, '重装后必须重新挂上工具')
})

await check('并发 refresh 会等在途任务，而不是直接报 busy', async () => {
  const slow = createHost({ llm: makeLlm({ delayMs: 80 }) })
  plugin.apply(slow.ctx, { ...settings, tickSeconds: 3600 })
  await sleep(30)
  await slow.emit('session/event', { id: 's4' }, userMessage('先给结论，别铺垫'))
  const definition = slow.tool()
  const [first, second] = await Promise.all([
    definition.execute({ action: 'refresh' }, { agent: { id: 's4' } }),
    definition.execute({ action: 'refresh' }, { agent: { id: 's4' } }),
  ])
  assert.notEqual(first.note, 'busy', '第一个不该 busy')
  assert.notEqual(second.note, 'busy', '第二个应等待而不是 busy')
  assert.equal(slow.llm.calls.length, 1, '第二个应复用第一个的结果，不该重复请求模型')
})

await check('定时器真的会跑（tick 到点自动总结）', async () => {
  const timed = createHost()
  plugin.apply(timed.ctx, { ...settings, tickSeconds: 1, intervalMinutes: 1, minNewMessages: 2 })
  await sleep(30)
  await timed.emit('session/event', { id: 's3' }, userMessage('先给结论'))
  await timed.emit('session/event', { id: 's3' }, userMessage('别铺垫太多'))
  await sleep(1400)
  assert.equal(timed.llm.calls.length, 1, '定时器应自动触发一次总结')
})

// 收尾
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉不影响结论 */
}

if (failures > 0) {
  console.log('\nFAIL：' + failures + ' 个用例未通过')
  process.exit(1)
}
console.log('\nPASS：全部用例通过')
