/**
 * dsh-persona-profile 装配层。
 *
 * 目标：让模型「隔一段时间」自动积累一份用户性格档案，落盘到 F:/性格，
 * 并且在任何模型需要时都知道去哪里看。
 *
 * 四条腿：
 *   ① 采集：根上下文订阅 `session/event`，只收 `user/message` 且 `source.kind === 'user'` 的真人发言，
 *      攒进按会话的缓冲（state.json 持久化，重启不丢）。
 *   ② 总结：定时器每 tickMs 扫一遍到点的会话，调 `ctx.llm.stream()` 让模型把新样本合并进档案
 *      （增量合并见 profile.js，模型跑偏时保留旧档案）。
 *   ③ 提示：全局 systemPrompt section（text 是函数，每 step 求值）告诉所有 agent 档案在哪、何时去读。
 *   ④ 工具：`persona_profile`，让模型不必受沙箱文件权限限制就能读到档案全文，并能立即刷新。
 *
 * 对外契约（scripts/smoke.mjs 依赖，别改）：
 *   export const name = 'dsh-persona-profile'
 *   export const inject = []            ← webServer / tools / systemPrompt 全是可选服务
 *   export function apply(ctx, config)
 */

import { existsSync } from 'node:fs'

import { PLUGIN_NAME, SECTION_NAME, resolveSettings } from './settings.js'
import { createStore } from './store.js'
import { createSummarizer } from './summarizer.js'
import { createSectionText } from './prompt.js'
import { createPersonaTool } from './tools.js'
import { createRoutes, mountRoutes } from './routes.js'
import { isRealUserMessage, messageText } from './format.js'

export const name = PLUGIN_NAME

/**
 * 不声明任何必需服务：headless / tui 这类 profile 没有 webServer，
 * 但「采集 + 总结 + 提示」本身不依赖它。声明成必需会让插件在这些 profile 里装不上。
 */
export const inject = []

/**
 * 幂等保护：cordis.patch.yml 的 `insert` 无条件追加、不去重，
 * profile patch 与 bundle 同时启用时 apply 会被调用两次 → 双份定时器、双份 section（同名 section 会抛）。
 * 同一个 ctx 只装配一次；但「装配过」不等于「现在还装着」——被卸载后再 apply 必须重新装配。
 */
const installs = new WeakMap()

/** 单个会话的缓冲上限之外，还要防「一次性灌爆」：这些数字与 settings 里的默认值呼应。 */
const TURN_END_DEBOUNCE_MS = 3_000

/**
 * @param {object} ctx - cordis 上下文
 * @param {object} [config] - profile 里 `insert[].config`
 */
export function apply(ctx, config) {
  const previous = installs.get(ctx)
  if (previous !== undefined && previous.disposed === false) {
    ctx.logger?.warn?.('[dsh-persona-profile] 当前上下文已装配过，跳过重复 apply')
    return
  }
  const install = { disposed: false, timers: new Set() }
  installs.set(ctx, install)

  const settings = resolveSettings(config)
  const logger = ctx.logger
  const store = createStore({ settings, logger })

  /** sessionId → agent（取 provider/model、判子代理深度用）。 */
  const agents = new Map()

  /** 未声明 inject 的服务不能点属性（cordis 会抛），只能 ctx.get()。 */
  function getService(serviceName) {
    try {
      if (typeof ctx.get !== 'function') return undefined
      return ctx.get(serviceName)
    } catch {
      return undefined
    }
  }

  const summarizer = createSummarizer({
    settings,
    store,
    getService,
    agentOf: (sessionId) => agents.get(String(sessionId)),
    debug: (line) => store.appendDebug(line),
    logger,
  })

  const personaTool = createPersonaTool({ settings, store, summarizer })

  // ── 工作区：失败不能把插件带崩（比如 F: 盘暂时不可写） ─────────────────────
  let workspaceReady = false
  try {
    store.ensureWorkspace()
    workspaceReady = true
  } catch (err) {
    logger?.warn?.('[dsh-persona-profile] 初始化工作区 ' + settings.dir + ' 失败：' + String(err))
  }

  store.appendDebug('apply dir=' + settings.dir + ' enabled=' + settings.enabled
    + ' interval=' + settings.intervalMinutes + 'min workspaceReady=' + workspaceReady)

  // ── ① 采集 ────────────────────────────────────────────────────────────────
  installSessionCapture(ctx, { settings, store, agents, summarizer })

  // ── ② agent 生命周期 ──────────────────────────────────────────────────────
  installAgentTracking(ctx, { agents, store })

  // ── ③ 提示词 section ──────────────────────────────────────────────────────
  installSection(ctx, { settings, store, getService, logger })

  // ── ④ 工具 ────────────────────────────────────────────────────────────────
  installTool(ctx, { settings, personaTool, getService, logger })

  // ── ⑤ 定时总结 ────────────────────────────────────────────────────────────
  installTimer(ctx, { settings, summarizer, store, install })

  // ── ⑥ 管理面 ──────────────────────────────────────────────────────────────
  installManagement(ctx, { settings, store, summarizer, getService, logger })

  // ── ⑦ 卸载标记 ────────────────────────────────────────────────────────────
  try {
    ctx.effect(() => () => {
      install.disposed = true
      for (const timer of install.timers) clearTimeout(timer)
      install.timers.clear()
      store.flush()
    }, 'dsh-persona-profile: lifecycle')
  } catch (err) {
    logger?.warn?.('[dsh-persona-profile] 注册卸载回调失败：' + String(err))
  }
}

/** 这个 agent 是不是子代理派出来的（口径同官方 delegationDepthOf）。 */
function delegationDepth(agent) {
  const header = agent?.session?.header ?? {}
  const fromHeader = Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0
  const fromOptions = Number.isSafeInteger(agent?.options?.subagentDepth) ? agent.options.subagentDepth : 0
  return Math.max(fromHeader, fromOptions)
}

/**
 * 采集真人发言。
 *
 * `session/event` 的载荷是 `(session, event)`，event = `{ seq, type, data }`，
 * `user/message` 的 data 就是那条 message 本身（dsh-agent-loop/lib/index.js:1069-1073）。
 * 判据收紧到 `source.kind === 'user'`：运行时快照、技能目录、子代理回报、
 * 别的插件 steer 的提醒全都是 user/message，混进来就会总结出「机器性格」。
 */
function installSessionCapture(ctx, deps) {
  const { settings, store, agents } = deps
  function onSessionEvent(session, event) {
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return

    if (event?.type === 'user/message') {
      const data = event.data
      if (isRealUserMessage(data) === false) return
      const agent = agents.get(sessionId)
      if (settings.summarizeSubagents !== true && agent !== undefined && delegationDepth(agent) > 0) return
      const text = messageText(data)
      if (text.trim() === '') return
      const pending = store.note(sessionId, text)
      store.appendDebug('note session=' + sessionId + ' chars=' + text.length + ' pending=' + pending)
      return
    }

    // 回合结束：如果已经到点，就别等下一个 tick（用户聊完就该更新档案）
    if (event?.type === 'turn/end' && settings.enabled === true && store.isDue(sessionId) === true) {
      scheduleAfterTurnEnd(ctx, deps, sessionId)
    }
  }

  try {
    ctx.on('session/event', onSessionEvent)
  } catch (err) {
    ctx.logger?.warn?.('[dsh-persona-profile] 订阅 session/event 失败：' + String(err))
  }
}

/** 回合结束后延迟几秒再总结：等落库稳定，也避开「刚答完就占着模型」。 */
function scheduleAfterTurnEnd(ctx, deps, sessionId) {
  const { summarizer, store } = deps
  const timer = setTimeout(() => {
    summarizer.summarize(sessionId).then((result) => {
      if (result.ok !== true && result.reason !== 'not-due') {
        store.appendDebug('turn-end summarize skip session=' + sessionId + ' reason=' + result.reason)
      }
    }).catch((err) => {
      store.appendDebug('turn-end summarize threw session=' + sessionId + ' err=' + String(err))
    })
  }, TURN_END_DEBOUNCE_MS)
  timer?.unref?.()
}

/** 记 agent（provider/model 来源），并把插件加载前就存在的会话补挂上。 */
function installAgentTracking(ctx, deps) {
  const { agents, store } = deps

  function remember(agent) {
    if (agent === null || agent === undefined) return
    const sessionId = String(agent.id ?? '')
    if (sessionId === '') return
    agents.set(sessionId, agent)
  }

  try {
    ctx.on('agent/created', (payload) => {
      remember(payload?.agent ?? payload)
    })
  } catch (err) {
    ctx.logger?.warn?.('[dsh-persona-profile] 订阅 agent/created 失败：' + String(err))
  }

  try {
    ctx.on('agent/disposed', (payload) => {
      const agent = payload?.agent ?? payload
      const sessionId = String(agent?.id ?? '')
      if (sessionId !== '') agents.delete(sessionId)
    })
  } catch {
    /* 某些宿主没有 disposed 事件，无害 */
  }

  // agents 服务在 apply 时往往还没就绪，用 inject 延迟到就绪再枚举
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['agents'], (scope) => {
      const list = typeof scope.agents?.list === 'function' ? scope.agents.list() : []
      for (const agent of list) remember(agent)
      store.appendDebug('agents ready, known=' + agents.size)
      try {
        scope.effect(() => scope.agents.on?.('agent/created', (payload) => remember(payload?.agent ?? payload)),
          'dsh-persona-profile: agents-created')
      } catch {
        /* 根 ctx 已经收到过，重复订阅失败无所谓 */
      }
    })
  } catch (err) {
    ctx.logger?.warn?.('[dsh-persona-profile] 等待 agents 服务失败：' + String(err))
  }
}

/**
 * 全局提示词 section。
 *
 * 注册在**根 ctx**（不是 per-agent）：档案对每个 agent 都成立，
 * 全局层一次注册即可覆盖所有既有会话与将来新建的会话、子代理、团队成员。
 * text 是函数 → 每 step 求值，档案更新后下一轮立刻生效（dsh-system-prompt:388）。
 */
function installSection(ctx, deps) {
  const { settings, store, getService, logger } = deps
  if (settings.injectSection !== true) return

  let cached = null
  let cachedAt = 0
  let cachedRevision = -1

  /**
   * section 每 step 都会调，不能每次都碰磁盘。
   * 判据用 store.revision()（档案一写入就变），所以「刚总结完下一轮就能看到新内容」；
   * 另外每 5 秒兜底重读一次，覆盖用户手改 profile.json 的情况。
   */
  function state() {
    const now = Date.now()
    const revision = store.revision()
    if (cached !== null && revision === cachedRevision && now - cachedAt < 5_000) {
      return { ...cached, pending: store.pendingTotal() }
    }
    let profile = null
    try {
      profile = store.readProfile()
    } catch {
      profile = null
    }
    cached = profile === null
      ? { exists: false, updatedAt: 0, summary: '', observations: 0 }
      : {
        exists: existsSync(store.paths.profileMd) && (profile.meta.updatedAt > 0 || profile.traits.length > 0),
        updatedAt: profile.meta.updatedAt,
        summary: profile.summary,
        observations: profile.meta.observations,
      }
    cachedAt = now
    cachedRevision = revision
    return { ...cached, pending: store.pendingTotal() }
  }

  const text = createSectionText({ settings, state })

  function register(systemPrompt) {
    if (systemPrompt === null || systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
    try {
      const order = typeof systemPrompt.getSectionOrder === 'function'
        ? systemPrompt.getSectionOrder('FILE_REFERENCE')
        : 900
      ctx.effect(
        () => systemPrompt.section({
          name: SECTION_NAME,
          order: Number.isFinite(order) ? order : 900,
          text,
        }),
        'dsh-persona-profile: section',
      )
    } catch (err) {
      logger?.warn?.('[dsh-persona-profile] 注册提示词 section 失败：' + String(err))
    }
  }

  const direct = getService('systemPrompt')
  if (direct !== undefined && direct !== null) {
    register(direct)
    return
  }
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['systemPrompt'], (scope) => register(scope.systemPrompt))
  } catch (err) {
    logger?.warn?.('[dsh-persona-profile] 等待 systemPrompt 服务失败：' + String(err))
  }
}

/** 注册 persona_profile 工具（工具服务可能比插件晚就绪）。 */
function installTool(ctx, deps) {
  const { settings, personaTool, getService, logger } = deps
  if (settings.registerTool !== true) return

  function attach(tools) {
    if (tools === null || tools === undefined || typeof tools.register !== 'function') return
    personaTool.install(ctx, tools)
  }

  const direct = getService('tools')
  if (direct !== undefined && direct !== null) {
    attach(direct)
    return
  }
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['tools'], (scope) => attach(scope.tools))
  } catch (err) {
    logger?.warn?.('[dsh-persona-profile] 等待 tools 服务失败：' + String(err))
  }
}

/** 定时器：每 tickMs 扫一次到点的会话。unref，别把进程钉住。 */
function installTimer(ctx, deps) {
  const { settings, summarizer, store, install } = deps
  if (settings.enabled !== true) return
  try {
    ctx.effect(
      () => {
        const timer = setInterval(() => {
          summarizer.tick().then((done) => {
            if (done > 0) store.appendDebug('tick summarized=' + done)
          }).catch((err) => {
            store.appendDebug('tick threw: ' + String(err))
          })
        }, settings.tickMs)
        timer?.unref?.()
        install.timers.add(timer)
        return () => {
          install.timers.delete(timer)
          clearInterval(timer)
        }
      },
      'dsh-persona-profile: timer',
    )
  } catch (err) {
    ctx.logger?.warn?.('[dsh-persona-profile] 安装定时器失败：' + String(err))
  }
}

/** 管理面：有 webServer 才有（headless 没有，插件照常工作）。 */
function installManagement(ctx, deps) {
  const { settings, store, summarizer, getService, logger } = deps
  const routes = createRoutes({ settings, store, summarizer })

  const direct = getService('webServer')
  if (direct !== undefined && direct !== null) {
    mountRoutes(ctx, direct, routes, logger)
    return
  }
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (scope) => {
      mountRoutes(scope, scope.webServer, routes, logger)
    })
  } catch (err) {
    logger?.warn?.('[dsh-persona-profile] 等待 webServer 失败：' + String(err))
  }
}
