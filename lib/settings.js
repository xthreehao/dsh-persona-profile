/**
 * 配置归一化。
 *
 * 配置来源是 profile 的 cordis.patch.yml：
 *   - insert:
 *       - id: persona-profile
 *         name: 'dsh-persona-profile'
 *         config: { dir: 'F:/性格', intervalMinutes: 30, ... }
 *
 * 所有取值都在这里收敛成确定类型，运行时代码不再做兜底判断（少一层 if 就少一个坑）。
 */

export const PLUGIN_NAME = 'dsh-persona-profile'
export const TOOL_NAME = 'persona_profile'
export const SECTION_NAME = 'persona:profile'

/** 默认工作区：用户指定的 F:/性格。 */
export const DEFAULT_DIR = 'F:/性格'

/** state.json / profile.json 的结构版本。 */
export const STORE_VERSION = 1
export const PROFILE_VERSION = 1

const MINUTE = 60_000
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

function num(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return fallback
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 工作区路径归一化：必须是绝对路径（否则退回默认值），统一正斜杠，去掉尾部分隔符。
 * 不解析 `~`（宿主进程的 cwd 与用户 shell 不一定一致，解析错更危险）。
 */
export function normalizeDir(value) {
  const raw = text(value)
  const dir = raw === '' ? DEFAULT_DIR : raw
  if (ABSOLUTE_PATH.test(dir) === false) return DEFAULT_DIR
  return dir.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * @param {object} [config] - profile insert 里的 config
 * @returns {Readonly<object>} 归一化后的设置
 */
export function resolveSettings(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}

  const intervalMinutes = clamp(num(cfg.intervalMinutes, 30), 1, 24 * 60)
  const minNewMessages = clamp(Math.round(num(cfg.minNewMessages, 4)), 1, 200)
  const minChars = clamp(Math.round(num(cfg.minChars, 120)), 1, 100_000)
  const maxInputChars = clamp(Math.round(num(cfg.maxInputChars, 12_000)), 500, 200_000)
  const maxProfileChars = clamp(Math.round(num(cfg.maxProfileChars, 6_000)), 800, 100_000)
  const requestTimeoutMs = clamp(Math.round(num(cfg.requestTimeoutMs, 120_000)), 5_000, 600_000)
  const retryBackoffMs = clamp(Math.round(num(cfg.retryBackoffMs, 300_000)), 10_000, 3_600_000)
  const tickMs = clamp(Math.round(num(cfg.tickSeconds, 60) * 1000), 1_000, 600_000)
  const stateSaveDelayMs = clamp(Math.round(num(cfg.stateSaveDelayMs, 2_000)), 10, 60_000)
  const pendingMessageLimit = clamp(Math.round(num(cfg.pendingMessageLimit, 200)), 2, 5_000)
  const maxTraits = clamp(Math.round(num(cfg.maxTraits, 12)), 3, 60)

  return Object.freeze({
    enabled: bool(cfg.enabled, true),
    dir: normalizeDir(cfg.dir),
    intervalMs: intervalMinutes * MINUTE,
    intervalMinutes,
    minNewMessages,
    minChars,
    maxInputChars,
    maxProfileChars,
    maxTraits,
    pendingMessageLimit,
    // 留空 = 跟随会话自己的 provider/model（最省事，也不额外花钱）
    provider: text(cfg.provider),
    model: text(cfg.model),
    timeZone: text(cfg.timeZone) || 'Asia/Shanghai',
    injectSection: bool(cfg.injectSection, true),
    registerTool: bool(cfg.registerTool, true),
    summarizeSubagents: bool(cfg.summarizeSubagents, false),
    debug: bool(cfg.debug, false),
    tickMs,
    stateSaveDelayMs,
    requestTimeoutMs,
    retryBackoffMs,
    // 单条用户消息的入库上限（避免一条粘贴的日志把缓冲撑爆）
    maxMessageChars: clamp(Math.round(num(cfg.maxMessageChars, 2_000)), 200, 50_000),
    // 会话明细日志里每条消息保留的字符数
    excerptChars: clamp(Math.round(num(cfg.excerptChars, 240)), 40, 4_000),
  })
}
