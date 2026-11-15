/**
 * 性格档案的数据模型：空档案、容错归一化、增量合并、渲染成 Markdown。
 *
 * 为什么要有 JSON + Markdown 两份：
 *   · profile.json 给插件自己用（可合并、可回滚、字段稳定）；
 *   · profile.md   给模型读（人/模型都看得懂，且能直接丢进上下文）。
 * 两者永远由 renderMarkdown() 从 JSON 生成，禁止手改 md 后再反向解析。
 */

import { PROFILE_VERSION } from './settings.js'
import { clip, formatTime, oneLine } from './format.js'

/** 一条特征最多留几条原始证据（多了只会把提示词撑大）。 */
const MAX_EVIDENCE = 5
/** 归一化时最多保留多少条特征（合并阶段还会按 maxTraits 再裁一次）。 */
const MAX_TRAITS = 40
/** 每个列表字段的条数上限。 */
const LIST_CAPS = Object.freeze({
  values: 8,
  dislikes: 12,
  interaction_tips: 12,
  open_questions: 6,
  preferences: 20,
})

// ───────────────────────────────────────────────────────── 基础工具

/** 收成单行字符串（非字符串一律当空）。 */
function str(value, limit = 400) {
  return typeof value === 'string' ? oneLine(value, limit) : ''
}

/** 字符串数组：去空、去重、限量。 */
function strList(value, limit, itemLimit = 200) {
  if (Array.isArray(value) === false) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    const text = str(item, itemLimit)
    if (text === '') continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/** 置信度夹到 0..1，保留两位。 */
function confidence(value, fallback = 0.5) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) === false) return fallback
  return Math.min(1, Math.max(0, Math.round(parsed * 100) / 100))
}

/** 合并键：忽略大小写与首尾空白，中文不受影响。 */
function keyOf(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

// ───────────────────────────────────────────────────────── 归一化

/** 空档案（首次运行 / 文件损坏时的基线）。 */
export function emptyProfile(now = 0) {
  return {
    version: PROFILE_VERSION,
    summary: '',
    traits: [],
    communication: { style: '', language: '', length: '', tone: '', pacing: '' },
    preferences: [],
    values: [],
    dislikes: [],
    interaction_tips: [],
    open_questions: [],
    meta: {
      createdAt: now,
      updatedAt: 0,
      rounds: 0,
      observations: 0,
      sessions: [],
      lastSession: '',
    },
  }
}

/** 沟通偏好：五个固定字段，非字符串退化为空。 */
function normalizeCommunication(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const field of ['style', 'language', 'length', 'tone', 'pacing']) {
    out[field] = str(source[field], 160)
  }
  return out
}

/** 单条特征；label 缺失视为无效。 */
function normalizeTrait(item) {
  const label = str(item?.label ?? item, 60)
  if (label === '') return undefined
  return {
    label,
    detail: str(item?.detail, 240),
    confidence: confidence(item?.confidence, 0.5),
    evidence: strList(item?.evidence, MAX_EVIDENCE, 160),
    count: Math.max(1, Math.round(Number(item?.count) || 1)),
    firstAt: Number(item?.firstAt) || 0,
    lastAt: Number(item?.lastAt) || 0,
  }
}

/** 特征数组：同 label 合并成一条（置信度取高、证据取并集）。 */
function normalizeTraits(rawTraits) {
  if (Array.isArray(rawTraits) === false) return []
  const seen = new Map()
  for (const item of rawTraits) {
    const trait = normalizeTrait(item)
    if (trait === undefined) continue
    const key = keyOf(trait.label)
    const existing = seen.get(key)
    if (existing === undefined) seen.set(key, trait)
    else mergeTraitInto(existing, trait)
    if (seen.size >= MAX_TRAITS) break
  }
  return [...seen.values()]
}

/** 把一条特征并进另一条（归一化阶段的去重用）。 */
function mergeTraitInto(target, incoming) {
  target.confidence = Math.max(target.confidence, incoming.confidence)
  target.detail = incoming.detail.length > target.detail.length ? incoming.detail : target.detail
  target.count = Math.max(target.count, incoming.count)
  const evidence = new Set(target.evidence)
  for (const item of incoming.evidence) evidence.add(item)
  target.evidence = [...evidence].slice(-MAX_EVIDENCE)
}

/** 偏好数组：topic 缺失归到「其它」，detail 为空则丢弃。 */
function normalizePreferences(rawPreferences) {
  if (Array.isArray(rawPreferences) === false) return []
  const out = []
  for (const item of rawPreferences) {
    const topic = str(item?.topic, 60) || '其它'
    const detail = str(item?.detail ?? item, 200)
    if (detail === '') continue
    out.push({ topic, detail, count: Math.max(1, Math.round(Number(item?.count) || 1)) })
    if (out.length >= LIST_CAPS.preferences) break
  }
  return out
}

/** meta 字段：全部退化成安全数字/数组。 */
function normalizeMeta(rawMeta, now) {
  const meta = rawMeta !== null && typeof rawMeta === 'object' ? rawMeta : {}
  return {
    createdAt: Number(meta.createdAt) || now,
    updatedAt: Number(meta.updatedAt) || 0,
    rounds: Math.max(0, Math.round(Number(meta.rounds) || 0)),
    observations: Math.max(0, Math.round(Number(meta.observations) || 0)),
    sessions: strList(meta.sessions, 64, 128),
    lastSession: str(meta.lastSession, 128),
  }
}

/** 把任意来源的对象（模型输出 / 旧版本文件 / 手改的 json）洗成合法档案。 */
export function normalizeProfile(raw, now = 0) {
  const base = emptyProfile(now)
  if (raw === null || typeof raw !== 'object') return base
  return {
    ...base,
    summary: str(raw.summary, 600),
    communication: normalizeCommunication(raw.communication),
    traits: normalizeTraits(raw.traits),
    preferences: normalizePreferences(raw.preferences),
    values: strList(raw.values, LIST_CAPS.values),
    dislikes: strList(raw.dislikes, LIST_CAPS.dislikes),
    interaction_tips: strList(raw.interaction_tips, LIST_CAPS.interaction_tips),
    open_questions: strList(raw.open_questions, LIST_CAPS.open_questions),
    meta: normalizeMeta(raw.meta, now),
  }
}

// ───────────────────────────────────────────────────────── 合并

/** 沟通偏好：新值非空才覆盖。 */
function mergeCommunication(current, patch) {
  const source = patch !== null && typeof patch === 'object' ? patch : {}
  const out = { ...current }
  for (const field of Object.keys(out)) {
    const value = str(source[field], 160)
    if (value !== '') out[field] = value
  }
  return out
}

/** 特征：按 label 合并，未提到的旧条目保留，最后按置信度裁剪。 */
function mergeTraits(currentTraits, patchTraits, { now, maxTraits }) {
  const byKey = new Map()
  for (const trait of currentTraits) byKey.set(keyOf(trait.label), trait)

  const incoming = Array.isArray(patchTraits) ? patchTraits : []
  for (const raw of incoming) {
    const candidate = normalizeTrait(raw)
    if (candidate === undefined) continue
    const key = keyOf(candidate.label)
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, { ...candidate, count: 1, firstAt: now, lastAt: now })
      continue
    }
    existing.detail = candidate.detail.length > existing.detail.length ? candidate.detail : existing.detail
    existing.confidence = Math.max(existing.confidence, candidate.confidence)
    existing.count += 1
    existing.lastAt = now
    const evidence = new Set(existing.evidence)
    for (const item of candidate.evidence) evidence.add(item)
    existing.evidence = [...evidence].slice(-MAX_EVIDENCE)
  }

  return [...byKey.values()]
    .sort((a, b) => (b.confidence - a.confidence) || (b.count - a.count))
    .slice(0, maxTraits)
}

/** 偏好：按 topic+detail 合并计数。 */
function mergePreferences(currentPreferences, patchPreferences) {
  const byKey = new Map()
  for (const pref of currentPreferences) byKey.set(keyOf(pref.topic + '|' + pref.detail), pref)

  const incoming = Array.isArray(patchPreferences) ? patchPreferences : []
  for (const raw of incoming) {
    const topic = str(raw?.topic, 60) || '其它'
    const detail = str(raw?.detail ?? raw, 200)
    if (detail === '') continue
    const key = keyOf(topic + '|' + detail)
    const existing = byKey.get(key)
    if (existing === undefined) byKey.set(key, { topic, detail, count: 1 })
    else existing.count += 1
  }

  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, LIST_CAPS.preferences)
}

/** 字符串列表：并集去重。 */
function mergeList(current, patch, limit) {
  const incoming = Array.isArray(patch) ? patch : []
  return strList([...current, ...incoming], limit)
}

/** meta：累加观察数/轮次，记下这次是哪个会话。 */
function mergeMeta(currentMeta, { now, sessionId, sampleCount }) {
  const sessions = new Set(currentMeta.sessions)
  const id = str(sessionId, 128)
  if (id !== '') sessions.add(id)
  return {
    createdAt: currentMeta.createdAt || now,
    updatedAt: now,
    rounds: currentMeta.rounds + 1,
    observations: currentMeta.observations + Math.max(0, Math.round(Number(sampleCount) || 0)),
    sessions: [...sessions].slice(-64),
    lastSession: id === '' ? currentMeta.lastSession : id,
  }
}

/**
 * 增量合并：`incoming` 是模型这一轮给出的「新档案」，`current` 是磁盘上的旧档案。
 *
 * 合并策略（保守优先，宁可少写也不要把一次性语气当成人格）：
 *   · 同 label 的特征：保留更长的 detail、更高的置信度，证据取并集（上限 5 条），count 累加；
 *   · 旧档案里模型这轮没提到的条目**保留**（避免模型上下文抖动导致档案反复清空）；
 *   · 列表字段：并集去重；open_questions 用新值覆盖（问题解决了就该消失）。
 *
 * @param {object} current - normalizeProfile() 的结果
 * @param {object} incoming - 模型输出的对象
 * @param {{now:number, sessionId?:string, sampleCount?:number, maxTraits?:number}} options
 * @returns {object} 新档案（不修改入参）
 */
export function mergeProfile(current, incoming, options = {}) {
  const now = Number(options.now) || Date.now()
  const maxTraits = Number(options.maxTraits) || 12
  const base = normalizeProfile(current, now)
  const patch = incoming !== null && typeof incoming === 'object' ? incoming : {}

  const summary = str(patch.summary, 600)
  return {
    ...base,
    summary: summary === '' ? base.summary : summary,
    communication: mergeCommunication(base.communication, patch.communication),
    traits: mergeTraits(base.traits, patch.traits, { now, maxTraits }),
    preferences: mergePreferences(base.preferences, patch.preferences),
    values: mergeList(base.values, patch.values, LIST_CAPS.values),
    dislikes: mergeList(base.dislikes, patch.dislikes, LIST_CAPS.dislikes),
    interaction_tips: mergeList(base.interaction_tips, patch.interaction_tips, LIST_CAPS.interaction_tips),
    // open_questions 是「还没确认的事」，用新值覆盖而不是并集
    open_questions: strList(patch.open_questions, LIST_CAPS.open_questions),
    meta: mergeMeta(base.meta, { now, sessionId: options.sessionId, sampleCount: options.sampleCount }),
  }
}

// ───────────────────────────────────────────────────────── 渲染

/** 一行摘要（给提示词 section / 工具 status 用，不占上下文）。 */
export function renderSummary(profile) {
  const safe = normalizeProfile(profile)
  const head = safe.summary !== '' ? safe.summary : (safe.traits[0]?.label ?? '')
  const stats = `${safe.traits.length} 条特征 / ${safe.meta.observations} 次观察`
  return head === '' ? `（尚未提炼出性格特征；${stats}）` : `${head}（${stats}）`
}

/** 特征段落：每条带置信度与证据，模型不会把一句话当铁律。 */
function renderTraits(traits) {
  if (traits.length === 0) return ['（暂无）']
  const lines = []
  for (const trait of traits) {
    lines.push(`- **${trait.label}**（置信度 ${trait.confidence.toFixed(2)}，出现 ${trait.count} 次）`)
    if (trait.detail !== '') lines.push(`  - ${trait.detail}`)
    if (trait.evidence.length > 0) {
      lines.push(`  - 证据：${trait.evidence.map((item) => `「${clip(item, 120)}」`).join('；')}`)
    }
  }
  return lines
}

/** 沟通偏好段落。 */
function renderCommunication(communication) {
  const rows = [
    ['风格', communication.style],
    ['语言', communication.language],
    ['篇幅', communication.length],
    ['语气', communication.tone],
    ['节奏', communication.pacing],
  ].filter(([, value]) => value !== '')
  if (rows.length === 0) return ['（暂无）']
  return rows.map(([label, value]) => `- ${label}：${value}`)
}

/** 偏好段落。 */
function renderPreferences(preferences) {
  if (preferences.length === 0) return ['（暂无）']
  return preferences.map((pref) => `- [${pref.topic}] ${pref.detail}（${pref.count} 次）`)
}

/** 普通字符串列表段落。 */
function renderList(items) {
  if (items.length === 0) return ['（暂无）']
  return items.map((item) => `- ${item}`)
}

/**
 * 渲染成 Markdown。这是模型唯一会读到的形态，所以：
 *   · 每个论断后面都跟证据，模型不会把「一句话」当铁律；
 *   · 显式写出「这是推断，不是用户自述」，减少过度迎合；
 *   · 末尾固定给数据来源，方便用户自己核对。
 */
export function renderMarkdown(profile, options = {}) {
  const safe = normalizeProfile(profile)
  const timeZone = options.timeZone ?? 'Asia/Shanghai'
  const maxChars = Number(options.maxChars) || 6_000
  const dir = typeof options.dir === 'string' ? options.dir : ''
  const source = `${dir === '' ? '' : `${dir}/`}journal.md（逐次观察流水）、profile.json（结构化状态）、sessions/（按会话的原始片段）`

  const blocks = [
    ['# 用户性格档案', ''],
    [
      `> 自动生成 · 最后更新 ${formatTime(safe.meta.updatedAt, timeZone)} · 由 dsh-persona-profile 维护`,
      `> 累计 ${safe.meta.rounds} 次总结 / ${safe.meta.observations} 条发言样本 / 覆盖 ${safe.meta.sessions.length} 个会话`,
      '> 这是从用户发言里推断出的画像，不是用户自述；与用户当前明确指令冲突时，以当前指令为准。',
      '',
    ],
    ['## 一句话', safe.summary === '' ? '（还在积累中）' : safe.summary, ''],
    ['## 性格特征', ...renderTraits(safe.traits), ''],
    ['## 沟通偏好', ...renderCommunication(safe.communication), ''],
    ['## 稳定偏好', ...renderPreferences(safe.preferences), ''],
    ['## 看重什么', ...renderList(safe.values), ''],
    ['## 不喜欢 / 雷区', ...renderList(safe.dislikes), ''],
    ['## 给模型的相处建议', ...renderList(safe.interaction_tips), ''],
    ['## 尚未确认', ...renderList(safe.open_questions), ''],
    ['---', `数据来源：${source}`],
  ]

  const body = blocks.map((block) => block.join('\n')).join('\n') + '\n'
  if (body.length <= maxChars) return body
  return body.slice(0, Math.max(0, maxChars - 80)) + '\n\n…（档案超出长度上限已截断，完整内容见 profile.json）\n'
}

/** 首次运行写进工作区的说明文件内容。 */
export function renderReadme(options = {}) {
  const dir = typeof options.dir === 'string' ? options.dir : 'F:/性格'
  const timeZone = options.timeZone ?? 'Asia/Shanghai'
  return `# 性格档案工作区

这个目录由 DSH 插件 **dsh-persona-profile** 自动维护，路径：\`${dir}\`

## 里面有什么

| 文件 | 说明 |
|---|---|
| \`profile.md\` | **给模型读的**性格档案（自动生成，别手改） |
| \`profile.json\` | 结构化状态，插件合并用 |
| \`journal.md\` | 每次总结的流水（新增了什么、来自哪个会话） |
| \`sessions/<id>.md\` | 按会话记录的原始发言片段（可人工核对证据） |
| \`state.json\` | 插件的运行状态（待总结的缓冲、上次总结时间） |
| \`debug.log\` | 打开 \`debug: true\` 时的排障日志 |

## 模型怎么用

1. 需要个性化取舍时（写作口吻、篇幅、称呼、推荐、排版习惯、"你了解我吗"）读 \`profile.md\`；
2. 有 \`persona_profile\` 工具时优先调它（\`action=read\` 取全文，\`action=refresh\` 立即刷新）；
3. 档案是推断，不是用户自述——与用户当前指令冲突时以当前指令为准；
4. 不要在无关回答里主动复述档案内容。

## 人工干预

- 想重置：删掉 \`profile.json\` 和 \`profile.md\`（下一轮会重建）；
- 想改口径：直接编辑 \`profile.json\` 里对应字段，下一轮会按合并规则继承；
- 想停掉自动总结：把 profile patch 里 \`persona-profile\` 的 \`config.enabled\` 改成 \`false\`。

生成时间：${formatTime(Date.now(), timeZone)}
`
}
