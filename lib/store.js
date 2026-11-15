/**
 * 工作区读写 + 待总结缓冲。
 *
 * 目录结构（默认 F:/性格）：
 *   profile.md        给模型读的档案
 *   profile.json      结构化状态
 *   journal.md        逐次总结流水（追加）
 *   sessions/<id>.md  按会话的原始片段（追加，人工核对证据用）
 *   state.json        待总结缓冲 + 时间戳（重启不丢）
 *   debug.log         排障日志（debug: true 时才写）
 *   README.md         目录说明（首次运行生成）
 *
 * 全部写操作走「tmp + rename」，避免进程被杀时留下半个 JSON——
 * 这个文件同时被插件和用户手工查看，读到半个 JSON 的代价太高。
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { PROFILE_VERSION, STORE_VERSION } from './settings.js'
import { clip, formatTime, oneLine } from './format.js'
import { normalizeProfile, renderMarkdown, renderReadme } from './profile.js'

const STATE_SAVE_DELAY_MS = 2_000
/** 会话 id → 文件名（保留可读前缀 + 短哈希防撞）。 */
export function sessionFileName(sessionId) {
  const raw = String(sessionId ?? '')
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'session'
  const digest = createHash('sha1').update(raw).digest('hex').slice(0, 8)
  return `${safe}-${digest}.md`
}

function readJson(filePath) {
  if (existsSync(filePath) === false) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' })
    renameSync(tmp, filePath)
  } catch (err) {
    // 统一带上路径再抛：调用方（总结器）据此退避并保留缓冲，绝不静默丢数据
    throw new Error('写 ' + filePath + ' 失败：' + String(err))
  }
}

function writeText(filePath, text) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, text, { encoding: 'utf8' })
    renameSync(tmp, filePath)
  } catch (err) {
    throw new Error('写 ' + filePath + ' 失败：' + String(err))
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./settings.js').resolveSettings>} deps.settings
 * @param {() => number} [deps.clock]
 * @param {{info?:Function,warn?:Function}} [deps.logger]
 */
export function createStore(deps) {
  const settings = deps.settings
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now()
  const logger = deps.logger

  const paths = {
    dir: settings.dir,
    profileMd: join(settings.dir, 'profile.md'),
    profileJson: join(settings.dir, 'profile.json'),
    journal: join(settings.dir, 'journal.md'),
    sessions: join(settings.dir, 'sessions'),
    state: join(settings.dir, 'state.json'),
    readme: join(settings.dir, 'README.md'),
    debug: join(settings.dir, 'debug.log'),
  }

  let saveTimer = null
  let state = loadState()
  /** 档案写入版本号：提示词 section 靠它判断「缓存过期了没有」，比定时刷新精确。 */
  let revision = 0

  // ── state ────────────────────────────────────────────────────────────────

  function emptyState() {
    return { version: STORE_VERSION, updatedAt: 0, sessions: {} }
  }

  function loadState() {
    const raw = readJson(paths.state)
    const base = emptyState()
    if (raw === null || typeof raw !== 'object' || raw.sessions === null || typeof raw.sessions !== 'object') return base
    for (const [sessionId, entry] of Object.entries(raw.sessions)) {
      if (entry === null || typeof entry !== 'object') continue
      base.sessions[sessionId] = {
        lastSummarizedAt: Number(entry.lastSummarizedAt) || 0,
        lastAttemptAt: Number(entry.lastAttemptAt) || 0,
        dropped: Math.max(0, Math.round(Number(entry.dropped) || 0)),
        samples: Math.max(0, Math.round(Number(entry.samples) || 0)),
        pending: normalizePending(entry.pending),
      }
    }
    return base
  }

  function normalizePending(raw) {
    if (Array.isArray(raw) === false) return []
    const out = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const text = typeof item.text === 'string' ? item.text : ''
      if (text.trim() === '') continue
      out.push({ at: Number(item.at) || 0, text })
      if (out.length >= settings.pendingMessageLimit) break
    }
    return out
  }

  function scheduleSave() {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      flush()
    }, settings.stateSaveDelayMs ?? STATE_SAVE_DELAY_MS)
    saveTimer?.unref?.()
  }

  function flush() {
    try {
      state.updatedAt = clock()
      writeJson(paths.state, state)
      return true
    } catch (err) {
      logger?.warn?.('[dsh-persona-profile] 写 state.json 失败：' + String(err))
      return false
    }
  }

  function entryOf(sessionId) {
    const key = String(sessionId ?? '')
    if (key === '') return undefined
    const existing = state.sessions[key]
    if (existing !== undefined) return existing
    const created = { lastSummarizedAt: 0, lastAttemptAt: 0, dropped: 0, samples: 0, pending: [] }
    state.sessions[key] = created
    return created
  }

  // ── 缓冲 ─────────────────────────────────────────────────────────────────

  /**
   * 记一条真人发言。超长消息截断（贴进来的日志不该把缓冲撑爆），
   * 超量时丢最旧的并计数（丢弃量会出现在 /state 里，便于发现「怎么不总结」）。
   */
  function note(sessionId, rawText, at = clock()) {
    const entry = entryOf(sessionId)
    if (entry === undefined) return 0
    const text = clip(String(rawText ?? '').replace(/\s+\n/g, '\n').trim(), settings.maxMessageChars)
    if (text === '') return 0
    entry.pending.push({ at, text })
    while (entry.pending.length > settings.pendingMessageLimit) {
      entry.pending.shift()
      entry.dropped += 1
    }
    scheduleSave()
    return entry.pending.length
  }

  function pendingOf(sessionId) {
    return entryOf(sessionId)?.pending ?? []
  }

  /** 取一份待总结快照（不清理；成功后才 commit）。 */
  function snapshot(sessionId, maxChars = settings.maxInputChars) {
    const entry = entryOf(sessionId)
    if (entry === undefined) return { items: [], count: 0, chars: 0, truncated: false }
    const items = []
    let chars = 0
    let truncated = false
    for (let index = entry.pending.length - 1; index >= 0; index -= 1) {
      const item = entry.pending[index]
      if (chars + item.text.length > maxChars && items.length > 0) {
        truncated = true
        break
      }
      items.unshift(item)
      chars += item.text.length
    }
    return { items, count: items.length, chars, truncated }
  }

  /** 总结成功：清空缓冲、记时间戳与累计样本数。 */
  function commit(sessionId, { at = clock(), sampleCount = 0 } = {}) {
    const entry = entryOf(sessionId)
    if (entry === undefined) return
    entry.pending = []
    entry.lastSummarizedAt = at
    entry.lastAttemptAt = 0
    entry.samples += Math.max(0, Math.round(sampleCount))
    flush()
  }

  /** 总结失败：只记「试过了」，缓冲原样留着下轮再试。 */
  function defer(sessionId, { at = clock() } = {}) {
    const entry = entryOf(sessionId)
    if (entry === undefined) return
    entry.lastAttemptAt = at
    scheduleSave()
  }

  /**
   * 到点该总结的会话。
   * 触发条件：距上次总结（或上次失败）≥ intervalMs，且样本量达到 minNewMessages 或 minChars。
   */
  function due(now = clock()) {
    const out = []
    for (const [sessionId, entry] of Object.entries(state.sessions)) {
      if (entry.pending.length === 0) continue
      const last = Math.max(entry.lastSummarizedAt, entry.lastAttemptAt)
      if (now - last < settings.intervalMs) continue
      const chars = entry.pending.reduce((sum, item) => sum + item.text.length, 0)
      if (entry.pending.length < settings.minNewMessages && chars < settings.minChars) continue
      out.push({
        sessionId,
        count: entry.pending.length,
        chars,
        lastAt: entry.pending.at(-1)?.at ?? 0,
        dueAt: last + settings.intervalMs,
      })
    }
    out.sort((a, b) => b.lastAt - a.lastAt)
    return out
  }

  /** 所有会话的待总结条数（提示词 section 每 step 会读，必须 O(1) 级别）。 */
  function pendingTotal() {
    let total = 0
    for (const entry of Object.values(state.sessions)) total += entry.pending.length
    return total
  }

  /** 某个会话是否到点（回合结束时用，避免等下一个 tick）。 */
  function isDue(sessionId, now = clock()) {
    const entry = state.sessions[String(sessionId ?? '')]
    if (entry === undefined || entry.pending.length === 0) return false
    const last = Math.max(entry.lastSummarizedAt, entry.lastAttemptAt)
    if (now - last < settings.intervalMs) return false
    const chars = entry.pending.reduce((sum, item) => sum + item.text.length, 0)
    return entry.pending.length >= settings.minNewMessages || chars >= settings.minChars
  }

  // ── 档案文件 ─────────────────────────────────────────────────────────────

  function ensureWorkspace() {
    mkdirSync(paths.sessions, { recursive: true })
    if (existsSync(paths.readme) === false) {
      writeText(paths.readme, renderReadme({ dir: settings.dir, timeZone: settings.timeZone }))
    }
    if (existsSync(paths.profileJson) === false) {
      const empty = normalizeProfile({ version: PROFILE_VERSION }, clock())
      writeJson(paths.profileJson, empty)
    }
    if (existsSync(paths.profileMd) === false) {
      writeText(paths.profileMd, renderMarkdown(normalizeProfile({ version: PROFILE_VERSION }, clock()), {
        dir: settings.dir,
        timeZone: settings.timeZone,
        maxChars: settings.maxProfileChars,
      }))
    }
    return true
  }

  function readProfile() {
    const raw = readJson(paths.profileJson)
    return normalizeProfile(raw ?? { version: PROFILE_VERSION }, clock())
  }

  function writeProfile(profile) {
    writeJson(paths.profileJson, profile)
    writeText(paths.profileMd, renderMarkdown(profile, {
      dir: settings.dir,
      timeZone: settings.timeZone,
      maxChars: settings.maxProfileChars,
    }))
    revision += 1
    return profile
  }

  function readProfileMarkdown() {
    if (existsSync(paths.profileMd) === false) return ''
    try {
      return readFileSync(paths.profileMd, 'utf8')
    } catch {
      return ''
    }
  }

  /** 追加一条总结流水。 */
  function appendJournal({ sessionId, at = clock(), sampleCount = 0, added = [], summary = '', raw = '' }) {
    const lines = []
    lines.push(`## ${formatTime(at, settings.timeZone)} · 会话 ${oneLine(sessionId, 40)}`)
    lines.push(`- 样本：${sampleCount} 条`)
    if (summary !== '') lines.push(`- 一句话：${summary}`)
    if (added.length > 0) lines.push(`- 新增/加强：${added.join('、')}`)
    if (raw !== '') lines.push(`- 原始输出片段：${clip(oneLine(raw, 600), 600)}`)
    lines.push('')
    try {
      mkdirSync(dirname(paths.journal), { recursive: true })
      if (existsSync(paths.journal) === false) {
        appendFileSync(paths.journal, '# 性格档案 · 观察流水\n\n', 'utf8')
      }
      appendFileSync(paths.journal, lines.join('\n') + '\n', 'utf8')
    } catch (err) {
      logger?.warn?.('[dsh-persona-profile] 写 journal.md 失败：' + String(err))
    }
  }

  /** 追加一个会话的原始片段（每条消息一行，方便人工核对证据）。 */
  function appendSessionLog(sessionId, items) {
    if (items.length === 0) return
    const file = join(paths.sessions, sessionFileName(sessionId))
    const lines = items.map((item) => `- ${formatTime(item.at, settings.timeZone)} ${oneLine(item.text, settings.excerptChars)}`)
    try {
      mkdirSync(paths.sessions, { recursive: true })
      if (existsSync(file) === false) {
        appendFileSync(file, `# 会话 ${sessionId}\n\n`, 'utf8')
      }
      appendFileSync(file, lines.join('\n') + '\n', 'utf8')
    } catch (err) {
      logger?.warn?.('[dsh-persona-profile] 写会话片段失败：' + String(err))
    }
  }

  function appendDebug(line) {
    if (settings.debug !== true) return
    try {
      mkdirSync(dirname(paths.debug), { recursive: true })
      appendFileSync(paths.debug, `[${new Date(clock()).toISOString()}] ${line}\n`, 'utf8')
    } catch {
      /* 日志写不了不能影响主流程 */
    }
  }

  /** /state 与工具 status 用的快照。 */
  function status() {
    const profile = readProfile()
    const sessions = Object.entries(state.sessions)
      .filter(([, entry]) => entry.pending.length > 0 || entry.lastSummarizedAt > 0)
      .map(([sessionId, entry]) => ({
        sessionId,
        pending: entry.pending.length,
        dropped: entry.dropped,
        samples: entry.samples,
        lastSummarizedAt: entry.lastSummarizedAt,
        lastAttemptAt: entry.lastAttemptAt,
      }))
    return {
      enabled: settings.enabled,
      dir: settings.dir,
      intervalMinutes: settings.intervalMinutes,
      updatedAt: profile.meta.updatedAt,
      rounds: profile.meta.rounds,
      observations: profile.meta.observations,
      summary: profile.summary,
      traits: profile.traits.map((trait) => trait.label),
      pendingSessions: sessions,
      stateUpdatedAt: state.updatedAt,
    }
  }

  return {
    paths,
    ensureWorkspace,
    readProfile,
    writeProfile,
    readProfileMarkdown,
    appendJournal,
    appendSessionLog,
    appendDebug,
    note,
    pendingOf,
    snapshot,
    commit,
    defer,
    due,
    isDue,
    pendingTotal,
    status,
    flush,
    /** 档案写入版本号（提示词 section 的缓存判据）。 */
    revision: () => revision,
    /** 仅供测试：直接拿到内部 state。 */
    _state: () => state,
    /** 仅供测试：从磁盘重载（模拟重启）。 */
    _reload: () => {
      state = loadState()
      return state
    },
  }
}
