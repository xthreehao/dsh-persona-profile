/** 工作区读写 + 缓冲：用临时目录跑，绝不碰真实的 F:/性格。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { resolveSettings } from '../lib/settings.js'
import { createStore, sessionFileName } from '../lib/store.js'

const sandboxes = []

function makeStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-persona-store-'))
  sandboxes.push(dir)
  let now = options.now ?? 1_000_000
  const settings = resolveSettings({ dir, intervalMinutes: 1, minNewMessages: 2, minChars: 10, ...options.settings })
  const store = createStore({ settings, clock: () => now })
  return { store, settings, dir, advance: (ms) => { now += ms }, setNow: (value) => { now = value } }
}

after(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
})

test('ensureWorkspace：建目录、写 README 与空档案', () => {
  const { store, dir } = makeStore()
  store.ensureWorkspace()
  for (const file of ['README.md', 'profile.md', 'profile.json', 'sessions']) {
    assert.ok(existsSync(join(dir, file)), '缺少 ' + file)
  }
  const readme = readFileSync(join(dir, 'README.md'), 'utf8')
  assert.ok(readme.includes('persona_profile'), 'README 应告诉模型怎么用')
  const markdown = readFileSync(join(dir, 'profile.md'), 'utf8')
  assert.ok(markdown.includes('# 用户性格档案'))
})

test('note / snapshot / commit：缓冲进出与时间戳', () => {
  const { store, advance } = makeStore()
  store.ensureWorkspace()

  assert.equal(store.note('s1', '   '), 0, '空白消息不该入库')
  assert.equal(store.note('s1', '直接说结论就行'), 1)
  advance(1000)
  assert.equal(store.note('s1', '别写那么多客套话'), 2)
  assert.equal(store.pendingTotal(), 2)

  const snapshot = store.snapshot('s1', 100)
  assert.equal(snapshot.count, 2)
  assert.ok(snapshot.chars > 0)

  // 快照不清理：失败时还能重试
  assert.equal(store.pendingOf('s1').length, 2)
  store.commit('s1', { sampleCount: 2 })
  assert.equal(store.pendingOf('s1').length, 0, 'commit 应清空缓冲')
  assert.equal(store._state().sessions.s1.lastSummarizedAt, 1_001_000)
  assert.equal(store._state().sessions.s1.samples, 2)
})

test('snapshot：超过 maxChars 时保留最近的样本并标记 truncated', () => {
  const { store } = makeStore()
  store.ensureWorkspace()
  for (let index = 0; index < 5; index += 1) store.note('s1', 'x'.repeat(50) + index)
  const snapshot = store.snapshot('s1', 120)
  assert.equal(snapshot.truncated, true)
  assert.ok(snapshot.chars <= 120)
  assert.ok(snapshot.items.at(-1).text.endsWith('4'), '应保留最新一条')
})

test('note：超量丢最旧并计数', () => {
  const { store } = makeStore({ settings: { pendingMessageLimit: 3 } })
  store.ensureWorkspace()
  for (let index = 0; index < 5; index += 1) store.note('s1', 'msg' + index)
  assert.equal(store.pendingOf('s1').length, 3)
  assert.equal(store._state().sessions.s1.dropped, 2)
  assert.deepEqual(store.pendingOf('s1').map((item) => item.text), ['msg2', 'msg3', 'msg4'])
})

test('due / isDue：到点 + 样本量双条件', () => {
  const { store, advance } = makeStore()
  store.ensureWorkspace()

  store.note('s1', '第一条')
  assert.equal(store.due().length, 0, '样本量不够不该触发')
  store.note('s1', '第二条消息够长了')
  assert.equal(store.isDue('s1'), true, '首次达到样本量就该总结，不用先等一个间隔')

  store.commit('s1', { sampleCount: 2 })
  assert.equal(store.due().length, 0, '没有新样本就没什么可总结的')

  store.note('s1', '第三条')
  store.note('s1', '第四条消息够长了')
  assert.equal(store.isDue('s1'), false, '刚总结过，间隔没到')
  assert.equal(store.due().length, 0)

  advance(61_000)
  assert.equal(store.isDue('s1'), true)
  assert.equal(store.due().length, 1)

  store.defer('s1')
  assert.equal(store.due().length, 0, '失败退避期内不该重试')

  advance(61_000)
  assert.equal(store.due().length, 1, '退避结束后应重试')
})

test('持久化：重启后缓冲与时间戳都还在', () => {
  const { store, dir } = makeStore()
  store.ensureWorkspace()
  store.note('s1', '记住我讨厌寒暄')
  store.flush()

  const settings = resolveSettings({ dir, intervalMinutes: 1 })
  const reopened = createStore({ settings })
  assert.equal(reopened.pendingOf('s1').length, 1)
  assert.equal(reopened.pendingOf('s1')[0].text, '记住我讨厌寒暄')
})

test('writeProfile：json 与 md 同步生成', () => {
  const { store, dir } = makeStore()
  store.ensureWorkspace()
  const profile = store.readProfile()
  profile.summary = '要求结论先行'
  profile.traits.push({ label: '注重效率', detail: '结论先行', confidence: 0.8, evidence: ['先说结论'], count: 1, firstAt: 1, lastAt: 1 })
  store.writeProfile(profile)

  const markdown = readFileSync(join(dir, 'profile.md'), 'utf8')
  assert.ok(markdown.includes('要求结论先行'))
  assert.ok(markdown.includes('注重效率'))
  const json = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))
  assert.equal(json.summary, '要求结论先行')
  assert.equal(store.readProfile().traits[0].label, '注重效率')
})

test('journal / session log：追加而不是覆盖', () => {
  const { store, dir } = makeStore()
  store.ensureWorkspace()
  store.appendJournal({ sessionId: 's1', at: 1_000_000, sampleCount: 3, added: ['注重效率'], summary: '要求结论先行' })
  store.appendJournal({ sessionId: 's1', at: 1_060_000, sampleCount: 2, added: [], summary: '要求结论先行' })
  const journal = readFileSync(join(dir, 'journal.md'), 'utf8')
  assert.equal(journal.split('## ').length - 1, 2, '两次总结应各留一条流水')

  store.appendSessionLog('s1', [{ at: 1_000_000, text: '直接说结论' }])
  const session = readFileSync(join(dir, 'sessions', sessionFileName('s1')), 'utf8')
  assert.ok(session.includes('直接说结论'))
})

test('sessionFileName：非法字符被替换且不撞车', () => {
  const a = sessionFileName('a/b:c*d')
  assert.ok(!/[/:*?]/.test(a), '实际：' + a)
  assert.notEqual(sessionFileName('session-1'), sessionFileName('session-2'))
  assert.equal(sessionFileName('session-1'), sessionFileName('session-1'))
})

test('status：给 /state 与工具用的快照', () => {
  const { store } = makeStore()
  store.ensureWorkspace()
  store.note('s1', '直接说结论')
  const status = store.status()
  assert.equal(status.enabled, true)
  assert.equal(status.dir, store.paths.dir)
  assert.equal(status.pendingSessions.length, 1)
  assert.equal(status.pendingSessions[0].sessionId, 's1')
  assert.equal(status.pendingSessions[0].pending, 1)
})
