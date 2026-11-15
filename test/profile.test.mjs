/**
 * 档案数据模型 / 模型输出解析 / 消息判定的单测。
 * 这几块是纯函数，跑得最快，也最容易在重构时被改坏。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatTime, isRealUserMessage, messageText, oneLine } from '../lib/format.js'
import { emptyProfile, mergeProfile, normalizeProfile, renderMarkdown, renderSummary } from '../lib/profile.js'
import { buildMessages, parseProfileJson } from '../lib/summarizer.js'

test('emptyProfile：结构稳定', () => {
  const profile = emptyProfile(1000)
  assert.equal(profile.version, 1)
  assert.deepEqual(profile.traits, [])
  assert.deepEqual(profile.preferences, [])
  assert.equal(profile.summary, '')
  assert.equal(profile.meta.createdAt, 1000)
  assert.equal(profile.meta.updatedAt, 0)
  assert.equal(profile.meta.rounds, 0)
})

test('normalizeProfile：脏数据洗成合法档案', () => {
  const profile = normalizeProfile({
    summary: '  喜欢直接给结论  ',
    traits: [
      { label: '直接', detail: '讨厌寒暄', confidence: 3, evidence: ['别废话', '直接说'] },
      { label: '  直接 ', detail: '', confidence: 0.4, evidence: ['别废话'] },
      { detail: '没有 label 的条目' },
      'not-an-object',
    ],
    communication: { style: '极简', language: '', length: 42 },
    preferences: [{ topic: '格式', detail: '先结论后细节' }, { detail: '表格优先' }],
    values: ['效率', '效率', ''],
    dislikes: 'not-an-array',
    open_questions: ['他是否写代码'],
    meta: { observations: 7, rounds: 2, sessions: ['s1', 's1'] },
  }, 5000)

  assert.equal(profile.summary, '喜欢直接给结论')
  assert.equal(profile.traits.length, 2, '无 label 的对象条目应被丢弃、同 label 应合并')
  const direct = profile.traits.find((trait) => trait.label === '直接')
  assert.equal(direct.confidence, 1, '置信度应被夹到 0..1')
  assert.deepEqual(direct.evidence, ['别废话', '直接说'], '同 label 的证据应取并集')
  assert.ok(profile.traits.some((trait) => trait.label === 'not-an-object'), '纯字符串条目按 label 容忍')
  assert.equal(profile.communication.style, '极简')
  assert.equal(profile.communication.length, '', '非字符串字段应退化为空串')
  assert.equal(profile.preferences.length, 2)
  assert.equal(profile.preferences[1].topic, '其它', '缺 topic 的偏好应归到「其它」')
  assert.deepEqual(profile.values, ['效率'])
  assert.deepEqual(profile.dislikes, [])
  assert.deepEqual(profile.open_questions, ['他是否写代码'])
  assert.equal(profile.meta.observations, 7)
  assert.deepEqual(profile.meta.sessions, ['s1'])
})

test('mergeProfile：同标签合并证据、未提到的条目保留', () => {
  const current = normalizeProfile({
    summary: '旧的一句话',
    traits: [
      { label: '注重效率', detail: '要求结论先行', confidence: 0.6, evidence: ['先说结论'] },
      { label: '偏好中文', detail: '', confidence: 0.4, evidence: [] },
    ],
    preferences: [{ topic: '格式', detail: '表格优先', count: 2 }],
    open_questions: ['他是否写代码'],
    meta: { observations: 4, rounds: 1, sessions: ['s1'] },
  }, 1000)

  const merged = mergeProfile(current, {
    summary: '新的一句话',
    traits: [
      { label: '注重效率', detail: '要求结论先行，细节放后面', confidence: 0.8, evidence: ['细节放后面'] },
      { label: '讨厌反复确认', detail: '', confidence: 0.7, evidence: ['别再问我了'] },
    ],
    preferences: [{ topic: '格式', detail: '表格优先' }],
    open_questions: [],
  }, { now: 2000, sessionId: 's2', sampleCount: 3, maxTraits: 12 })

  assert.equal(merged.summary, '新的一句话')
  const efficiency = merged.traits.find((trait) => trait.label === '注重效率')
  assert.equal(efficiency.count, 2, '同标签应累加出现次数')
  assert.equal(efficiency.confidence, 0.8)
  assert.equal(efficiency.detail, '要求结论先行，细节放后面', '更长的 detail 应胜出')
  assert.deepEqual(efficiency.evidence, ['先说结论', '细节放后面'])
  assert.ok(merged.traits.some((trait) => trait.label === '偏好中文'), '模型这轮没提到的条目必须保留')
  assert.equal(merged.traits[0].label, '注重效率', '应按置信度排序')
  assert.equal(merged.preferences[0].count, 3, '同偏好应累加')
  assert.deepEqual(merged.open_questions, [], 'open_questions 用新值覆盖')
  assert.equal(merged.meta.observations, 7, '观察数应累加')
  assert.equal(merged.meta.rounds, 2)
  assert.deepEqual(merged.meta.sessions, ['s1', 's2'])
  assert.equal(merged.meta.updatedAt, 2000)
})

test('mergeProfile：maxTraits 生效且按置信度裁剪', () => {
  const current = emptyProfile(0)
  const incoming = {
    traits: Array.from({ length: 20 }, (_, index) => ({
      label: '特征' + index,
      confidence: index / 20,
      evidence: ['证据' + index],
    })),
  }
  const merged = mergeProfile(current, incoming, { now: 10, maxTraits: 3 })
  assert.equal(merged.traits.length, 3)
  assert.deepEqual(merged.traits.map((trait) => trait.label), ['特征19', '特征18', '特征17'])
})

test('renderMarkdown：模型能读到的关键段落都在', () => {
  const profile = normalizeProfile({
    summary: '要求结论先行、讨厌寒暄',
    traits: [{ label: '注重效率', detail: '结论先行', confidence: 0.8, evidence: ['先说结论'] }],
    communication: { style: '极简' },
    preferences: [{ topic: '格式', detail: '表格优先', count: 2 }],
    values: ['效率'],
    dislikes: ['客套'],
    interaction_tips: ['直接给结果'],
    open_questions: ['是否写代码'],
    meta: { observations: 9, rounds: 2, sessions: ['s1'], updatedAt: 1700000000000 },
  }, 0)

  const markdown = renderMarkdown(profile, { dir: 'F:/性格', timeZone: 'Asia/Shanghai', maxChars: 6000 })
  for (const needle of ['# 用户性格档案', '## 一句话', '## 性格特征', '## 沟通偏好', '## 稳定偏好', '## 给模型的相处建议', 'F:/性格', '先说结论', '表格优先']) {
    assert.ok(markdown.includes(needle), '缺少段落/内容：' + needle)
  }
  assert.ok(markdown.includes('不是用户自述'), '必须声明这是推断')
})

test('renderMarkdown：超长截断并留提示', () => {
  const profile = normalizeProfile({
    traits: Array.from({ length: 30 }, (_, index) => ({ label: '特征' + index, detail: 'x'.repeat(200), confidence: 0.5 })),
  }, 0)
  const markdown = renderMarkdown(profile, { dir: 'F:/性格', maxChars: 1200 })
  assert.ok(markdown.length <= 1300, '实际长度 ' + markdown.length)
  assert.ok(markdown.includes('已截断'))
})

test('renderSummary：给提示词用的一行摘要', () => {
  assert.ok(renderSummary(emptyProfile(0)).includes('尚未'))
  const summary = renderSummary(normalizeProfile({
    summary: '要求结论先行',
    traits: [{ label: '注重效率' }],
    meta: { observations: 5 },
  }, 0))
  assert.ok(summary.includes('要求结论先行'))
  assert.ok(summary.includes('5 次观察'))
})

test('parseProfileJson：容忍围栏、前后废话与尾随逗号', () => {
  assert.deepEqual(parseProfileJson('{"summary":"a"}'), { summary: 'a' })
  assert.deepEqual(parseProfileJson('```json\n{"summary":"b"}\n```'), { summary: 'b' })
  assert.deepEqual(parseProfileJson('好的，结果如下：\n{"summary":"c"}\n以上。'), { summary: 'c' })
  assert.deepEqual(parseProfileJson('{"summary":"d",}'), { summary: 'd' })
  assert.equal(parseProfileJson('完全不是 JSON'), undefined)
  assert.equal(parseProfileJson(''), undefined)
  assert.equal(parseProfileJson('[1,2,3]'), undefined, '数组不是合法档案')
})

test('buildMessages：带现有档案与新样本', () => {
  const messages = buildMessages({
    currentProfile: normalizeProfile({ summary: '旧画像' }, 0),
    items: [{ at: 1700000000000, text: '直接说结论就行' }],
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.ok(messages[0].text.includes('性格档案'))
  assert.ok(messages[1].text.includes('<current_profile>'))
  assert.ok(messages[1].text.includes('旧画像'))
  assert.ok(messages[1].text.includes('<new_samples>'))
  assert.ok(messages[1].text.includes('直接说结论就行'))
})

test('format 工具：时间、单行化、消息判据', () => {
  assert.equal(formatTime(0), '（从未）')
  assert.match(formatTime(1700000000000, 'Asia/Shanghai'), /^2023-11-15 06:13$/)
  assert.equal(oneLine('a\n\n  b   c'), 'a b c')
  assert.equal(oneLine('x'.repeat(10), 5), 'xxxx…')

  assert.equal(messageText({ content: [{ type: 'text', text: '你好' }, { type: 'image', data: 'x' }] }), '你好')
  assert.equal(messageText({ content: 'plain' }), 'plain')
  assert.equal(messageText({}), '')

  assert.equal(isRealUserMessage({ source: { kind: 'user' } }), true)
  assert.equal(isRealUserMessage({ source: { kind: 'user', form: 'notice' } }), false)
  assert.equal(isRealUserMessage({ source: { kind: 'runtime-context' } }), false)
  assert.equal(isRealUserMessage({ source: { kind: 'agent-message' } }), false)
  assert.equal(isRealUserMessage({}), false)
  assert.equal(isRealUserMessage(undefined), false)
})
