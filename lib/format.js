/**
 * 时间与文本小工具。全部纯函数，方便单测。
 */

/** 时间戳 → `2026-11-15 12:30`（按指定时区）。 */
export function formatTime(ms, timeZone = 'Asia/Shanghai') {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '（从未）'
  try {
    // 不用 toLocaleString：不同 ICU 版本给出的分隔符不一样（2023/11/15 vs 2023-11-15），
    // 而日志/档案里的时间戳需要稳定可读，所以按 parts 自己拼。
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(value))
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
    return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
  } catch {
    return new Date(value).toISOString()
  }
}

/** 一行化：压掉换行与多余空白。 */
export function oneLine(value, limit = 200) {
  const raw = typeof value === 'string' ? value : ''
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return flat.slice(0, Math.max(0, limit - 1)) + '…'
}

/** 截断但保留尾部（日志/片段用）。 */
export function clip(value, limit) {
  const raw = typeof value === 'string' ? value : ''
  if (raw.length <= limit) return raw
  return raw.slice(0, Math.max(0, limit - 1)) + '…'
}

/**
 * 从一条 user 消息里抠出纯文本。
 * 内容块形状来自 @deepseek-ai/dsh-llm：`content: [{ type: 'text', text }]`。
 * 非文本块（图片/文件）在这里丢弃——性格总结用不到，也不该把 base64 塞进提示词。
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content) === false) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 会话里的 `user/message` 事件到底是不是真人输入。
 *
 * 一个会话里的 user/message 至少有这些来源：
 *   user（真人）/ runtime-context(snapshot) / skill-catalog(catalog) /
 *   agent-message(relay，子代理回报) / *-policy(notice，别的插件 steer 的提醒)
 * 只有 `source.kind === 'user'` 且不是 notice 才算——否则性格档案会被
 * 插件自己的提醒和运行时快照污染（那是最典型的「总结出机器性格」）。
 */
export function isRealUserMessage(message) {
  if (message === null || typeof message !== 'object') return false
  const source = message.source
  if (source === null || typeof source !== 'object') return false
  if (source.kind !== 'user') return false
  if (source.form === 'notice') return false
  return true
}
