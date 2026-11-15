/** 配置归一化：默认值、夹取、路径校验。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_DIR, normalizeDir, resolveSettings } from '../lib/settings.js'

test('默认值：工作区就是 F:/性格', () => {
  const settings = resolveSettings()
  assert.equal(settings.dir, DEFAULT_DIR)
  assert.equal(settings.dir, 'F:/性格')
  assert.equal(settings.enabled, true)
  assert.equal(settings.intervalMinutes, 30)
  assert.equal(settings.intervalMs, 30 * 60_000)
  assert.equal(settings.injectSection, true)
  assert.equal(settings.registerTool, true)
  assert.equal(settings.timeZone, 'Asia/Shanghai')
  assert.equal(settings.provider, '')
})

test('非法输入不会把插件带崩', () => {
  const settings = resolveSettings({
    dir: 'relative/path',
    intervalMinutes: 'abc',
    minNewMessages: -5,
    maxInputChars: 10,
    provider: 42,
    debug: 'true',
  })
  assert.equal(settings.dir, DEFAULT_DIR, '相对路径应退回默认工作区')
  assert.equal(settings.intervalMinutes, 30)
  assert.equal(settings.minNewMessages, 1, '负数应被夹到下限')
  assert.equal(settings.maxInputChars, 500, '过小应被夹到下限')
  assert.equal(settings.provider, '')
  assert.equal(settings.debug, true)
})

test('路径归一化：反斜杠、尾部分隔符、盘符', () => {
  assert.equal(normalizeDir('F:\\性格\\'), 'F:/性格')
  assert.equal(normalizeDir('F:/性格//'), 'F:/性格')
  assert.equal(normalizeDir('D:/profiles/persona'), 'D:/profiles/persona')
  assert.equal(normalizeDir('/home/user/persona'), '/home/user/persona')
  assert.equal(normalizeDir(''), DEFAULT_DIR)
  assert.equal(normalizeDir('  '), DEFAULT_DIR)
  assert.equal(normalizeDir(undefined), DEFAULT_DIR)
  assert.equal(normalizeDir('C:relative'), DEFAULT_DIR, '不是绝对路径')
})

test('布尔与数值：字符串形态也认', () => {
  const settings = resolveSettings({
    enabled: 'false',
    injectSection: 0,
    registerTool: 'true',
    intervalMinutes: '5',
    tickSeconds: 15,
    maxTraits: 999,
  })
  assert.equal(settings.enabled, false)
  assert.equal(settings.injectSection, false)
  assert.equal(settings.registerTool, true)
  assert.equal(settings.intervalMinutes, 5)
  assert.equal(settings.tickMs, 15_000)
  assert.equal(settings.maxTraits, 60, 'maxTraits 上限 60')
})

test('返回对象被冻结（运行期不允许被意外改写）', () => {
  const settings = resolveSettings()
  assert.equal(Object.isFrozen(settings), true)
})
