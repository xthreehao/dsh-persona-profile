/**
 * `persona_profile` 工具：让模型不必依赖沙箱文件权限，直接拿到档案全文。
 *
 * 为什么必须有它：档案在 `F:/性格`，而 DSH 的文件工具受沙箱策略约束
 * （workspace-write 下读工作区外的路径会被拒）。插件跑在宿主进程里，
 * 自己读文件不受这条限制，所以「读档案」这件事由工具兜底最稳。
 *
 * 注册契约（dsh-tools/lib/index.js:2974 register）：
 *   { name, description, parameters, output: { schema, render }, execute, isConcurrencySafe }
 * 两个 schema 都必须是**标准 JSON Schema**：
 *   · `required` 只能出现在对象顶层数组里，写在属性内部会抛
 *     `JsonSchemaError: schema.properties.x.required is not supported on type "string"`；
 *   · `parameters` 优先交给官方 defineTool() 转换，拿不到包时退回手写 schema。
 */

import { formatTime, oneLine } from './format.js'
import { renderSummary } from './profile.js'

const ACTIONS = ['read', 'summary', 'refresh', 'status']

const DESCRIPTION = [
  '读取或刷新本机自动维护的「用户性格档案」（personality profile）。',
  'action=read 返回 profile.md 全文（回答个性化问题前先调用它）；',
  'action=summary 只返回一句话画像与统计；',
  'action=refresh 立刻把当前会话里尚未总结的发言合并进档案（需要时间，通常不必主动调用）；',
  'action=status 返回运行状态（目录、上次更新时间、待总结条数）。',
].join('')

const PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'read | summary | refresh | status（默认 read）',
    },
  },
  required: ['action'],
}

/** 输出 schema：三个必填字段放在顶层 required 里。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    path: { type: 'string' },
    text: { type: 'string' },
    updatedAt: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['action', 'path', 'text'],
}

/** 惰性加载 defineTool：拿不到就用上面的手写 schema。 */
let defineTool = null
let defineLoading = null

async function loadDefineTool() {
  if (defineLoading === null) {
    defineLoading = import('@deepseek-ai/dsh-tools')
      .then((mod) => {
        if (typeof mod.defineTool === 'function') defineTool = mod.defineTool
      })
      .catch(() => { /* 宿主裁剪过也没有关系 */ })
  }
  await defineLoading
  return defineTool
}

/** 组装工具定义；defineTool 可用时由它把 parameters 的简写转成 JSON Schema。 */
function makeDefinition(execute) {
  const base = {
    name: 'persona_profile',
    description: DESCRIPTION,
    isConcurrencySafe: () => true,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    execute,
  }
  if (defineTool !== null) {
    return defineTool({
      ...base,
      parameters: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'read | summary | refresh | status（默认 read）',
        },
      },
    })
  }
  return { ...base, parameters: PARAMETERS_SCHEMA }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./settings.js').resolveSettings>} deps.settings
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {ReturnType<import('./summarizer.js').createSummarizer>} deps.summarizer
 */
export function createPersonaTool(deps) {
  const { settings, store, summarizer } = deps
  const profilePath = `${settings.dir}/profile.md`

  /** 读档案 JSON：磁盘异常时退回空档案，工具永远不因为读文件失败而报错。 */
  function safeProfile() {
    try {
      return store.readProfile()
    } catch {
      return { summary: '', traits: [], meta: { updatedAt: 0, observations: 0 } }
    }
  }

  /** 读档案 Markdown：读不到当「尚未生成」。 */
  function safeMarkdown() {
    try {
      return store.readProfileMarkdown()
    } catch {
      return ''
    }
  }

  /** status：运行状态，不含档案正文。 */
  function statusAction() {
    const state = store.status()
    return {
      action: 'status',
      path: profilePath,
      text: JSON.stringify(state, null, 2),
      updatedAt: formatTime(state.updatedAt, settings.timeZone),
    }
  }

  /** summary：一行画像 + 统计，最省上下文。 */
  function summaryAction() {
    const profile = safeProfile()
    return {
      action: 'summary',
      path: profilePath,
      text: renderSummary(profile),
      updatedAt: formatTime(profile.meta.updatedAt, settings.timeZone),
    }
  }

  /** read：档案 Markdown 全文（未生成时给明确说明）。 */
  function readAction() {
    const markdown = safeMarkdown()
    if (markdown.trim() === '') {
      return {
        action: 'read',
        path: profilePath,
        text: `档案尚未生成（目录 ${settings.dir}）。等积累到足够发言后会自动生成；现在请按用户当前指令行事。`,
        note: 'missing',
      }
    }
    const profile = safeProfile()
    return {
      action: 'read',
      path: profilePath,
      text: markdown,
      updatedAt: formatTime(profile.meta.updatedAt, settings.timeZone),
      note: oneLine(profile.summary, 80),
    }
  }

  /** refresh：立刻总结当前会话的待处理发言，然后返回刷新后的全文。 */
  async function refreshAction(sessionId) {
    if (sessionId === '') {
      return { action: 'refresh', path: profilePath, text: '当前没有会话上下文，无法刷新；请直接 read。', note: 'no-session' }
    }
    const result = await summarizer.summarize(sessionId, { force: true })
    if (result.ok !== true) {
      const text = result.reason === 'empty'
        ? '当前会话没有待总结的发言。'
        : `刷新未完成：${result.reason}${result.error === undefined ? '' : '（' + result.error + '）'}`
      return { action: 'refresh', path: profilePath, text, note: result.reason }
    }
    const profile = result.profile ?? safeProfile()
    const added = (result.added ?? []).join('、') || '无'
    return {
      action: 'refresh',
      path: profilePath,
      text: `已刷新（新增/加强：${added}）。\n\n${safeMarkdown()}`,
      updatedAt: formatTime(profile.meta.updatedAt, settings.timeZone),
    }
  }

  /** 工具入口：按 action 分发，非法值退回 read（宁可多读一次也不要报错）。 */
  async function execute(args, exec) {
    const requested = typeof args?.action === 'string' ? args.action : 'read'
    const action = ACTIONS.includes(requested) ? requested : 'read'
    if (action === 'status') return statusAction()
    if (action === 'summary') return summaryAction()
    if (action === 'refresh') return refreshAction(String(exec?.agent?.id ?? ''))
    return readAction()
  }

  /** 挂到 ctx.tools 上；返回 disposer（失败时返回 undefined）。 */
  async function install(ctx, tools) {
    await loadDefineTool()
    const definition = makeDefinition(execute)
    try {
      // 用 ctx.effect 包一层：插件条目被卸载时工具要跟着摘掉，
      // 否则重载后会撞上同名注册（tools.register 内部只按服务自己的 ctx 记账）。
      const disposer = ctx.effect(() => tools.register(definition), 'dsh-persona-profile: tool')
      store.appendDebug('tool registered name=' + definition.name
        + ' defineTool=' + (defineTool !== null)
        + ' params=' + JSON.stringify(definition.parameters).slice(0, 200))
      return disposer
    } catch (err) {
      store.appendDebug('tool register FAILED: ' + String(err))
      ctx.logger?.warn?.('[dsh-persona-profile] 注册 persona_profile 工具失败：' + String(err))
      return undefined
    }
  }

  return { install, execute, definition: () => makeDefinition(execute) }
}
