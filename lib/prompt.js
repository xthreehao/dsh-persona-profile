/**
 * 系统提示段：告诉每个模型「性格档案在哪、什么时候去读」。
 *
 * 注册方式：`ctx.systemPrompt.section({ name, order, text })`，text 是函数 →
 * 每 step 重新求值（dsh-system-prompt/lib/index.js:388），所以档案更新后
 * 下一轮请求立刻看到新的时间戳/一句话，不用重建 section。
 *
 * 这里刻意保持极短（< 400 字）：它会被注入**每一次**请求，
 * 塞满细节等于每轮都在烧上下文，真正的档案内容应该由模型按需去读。
 */

import { formatTime, oneLine } from './format.js'

/**
 * @param {object} deps
 * @param {ReturnType<import('./settings.js').resolveSettings>} deps.settings
 * @param {() => {exists:boolean, updatedAt:number, summary:string, observations:number, pending:number}} deps.state
 */
export function createSectionText(deps) {
  const { settings } = deps
  const state = deps.state

  return function sectionText() {
    if (settings.enabled !== true) return ''
    const current = state()
    const path = `${settings.dir}/profile.md`

    // 两条尾巴对所有分支都成立：档案是推断（不是命令），且属于用户隐私。
    const tail = [
      '- 档案是推断，不是用户自述；与用户当前明确指令冲突时，以当前指令为准，不要为了迎合档案而改变用户明确要求的内容。',
      '- 不要在无关回答里主动复述档案内容（属于用户隐私）。',
    ]

    if (current.exists !== true) {
      return [
        '[用户性格档案]',
        `本机在自动积累用户性格档案，当前尚未生成（已收集 ${current.pending} 条发言），文件将出现在 ${path}。`,
        '现在按用户当前指令行事即可；等档案生成后，涉及个性化取舍时再用 persona_profile 工具（action=read）读取。',
        ...tail,
      ].join('\n')
    }

    const summary = oneLine(current.summary, 120)
    return [
      '[用户性格档案]',
      `本机维护着一份用户性格/偏好档案：${path}（最后更新 ${formatTime(current.updatedAt, settings.timeZone)}，累计 ${current.observations} 条发言样本）。`,
      summary === '' ? '' : `一句话画像：${summary}`,
      '- 需要个性化取舍时（口吻、篇幅、称呼、推荐、排版、节奏，"你了解我吗"这类问题），先读档案再回答：优先调用 persona_profile 工具（action=read）取全文；没有该工具时用 read 工具读上面的路径。',
      ...tail,
    ].filter((line) => line !== '').join('\n')
  }
}
