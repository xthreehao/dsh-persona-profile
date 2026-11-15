/**
 * install-profile.mjs —— 把一个插件装进指定 profile 的 patch 层（幂等，UTF-8 安全）。
 *
 * 为什么需要它：手工改 cordis.patch.yml 踩过两个坑
 *   1. 文件里混用「flow 数组行 + block 序列」→ YAML 解析直接失败，整层 patch 全废；
 *   2. PowerShell 的 [IO.File]::ReadAllLines 在无 BOM 时按 ANSI 解码 → 中文路径被写成乱码。
 * 所以统一用 Node（显式 utf8）做：先规范化 YAML 结构，再按 insert 形式追加条目。
 *
 * 用法：
 *   node scripts/install-profile.mjs --patch <cordis.patch.yml> --id persona-profile \
 *        --name dsh-persona-profile [--config '<json>'] [--dry]
 *
 * 不带 --config 时对 persona-profile 使用内置默认值（dir: F:/性格, intervalMinutes: 30）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

function parseArgs(argv) {
  const out = { config: undefined, dry: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry') out.dry = true
    else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++index]
  }
  return out
}

/** 按顶层逗号切分 flow 数组内容（跳过字符串与嵌套括号）。 */
function splitFlow(body) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (const char of body) {
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/** 把「flow 数组行」展开成 block 序列条目，返回新行数组。 */
function normalizeFlowArray(lines) {
  const index = lines.findIndex((line) => line.trimStart().startsWith('[ {'))
  if (index < 0) return lines
  const trimmed = lines[index].trim()
  if (trimmed.startsWith('[') === false || trimmed.endsWith(']') === false) return lines
  const block = splitFlow(trimmed.slice(1, -1)).map((part) => '- ' + part)
  return [...lines.slice(0, index), ...block, ...lines.slice(index + 1)]
}

/** 删掉「patch 形式」的同 id 条目（它们要求目标条目已存在，会报 entry not found）。 */
function dropPatchEntries(lines, ids) {
  const pattern = new RegExp('^-\\s*\\{\\s*id:\\s*(' + ids.join('|') + ')\\b')
  return lines.filter((line) => pattern.test(line) === false)
}

/** 生成 insert 块。 */
function insertBlock(id, name, config) {
  const lines = ['- insert:', `    - id: ${id}`, `      name: '${name}'`]
  if (config !== undefined) {
    lines.push('      config:')
    for (const [key, value] of Object.entries(config)) {
      lines.push(`        ${key}: ${typeof value === 'string' ? `'${value}'` : value}`)
    }
  }
  return lines
}

/** 不传 --config 时的默认配置（PowerShell 传 JSON 容易把引号吃掉，所以给一份内置默认值）。 */
function defaultConfigFor(id) {
  if (id === 'persona-profile') return { dir: 'F:/性格', intervalMinutes: 30, enabled: true }
  return undefined
}

const args = parseArgs(process.argv.slice(2))
if (args.patch === undefined || args.id === undefined || args.name === undefined) {
  console.error('用法: node scripts/install-profile.mjs --patch <file> --id <id> --name <name> [--config <json>] [--dry]')
  process.exit(2)
}

const config = args.config === undefined ? defaultConfigFor(args.id) : JSON.parse(args.config)
const original = readFileSync(args.patch, 'utf8')
let lines = original.split(/\r?\n/)
lines = normalizeFlowArray(lines)
lines = dropPatchEntries(lines, ['hidden-session', 'persona-profile'])

// 已经有我们的 insert 块就只更新（幂等）：删掉旧的，再追加新的
const marker = `    - id: ${args.id}`
const existing = lines.findIndex((line) => line === marker)
if (existing >= 0) {
  let start = existing
  while (start > 0 && lines[start - 1] !== '- insert:') start -= 1
  let end = existing
  while (end + 1 < lines.length && (lines[end + 1].startsWith('    ') || lines[end + 1].startsWith('      '))) end += 1
  lines = [...lines.slice(0, start - 1), ...lines.slice(end + 1)]
}

const trimmedTail = [...lines]
while (trimmedTail.length > 0 && trimmedTail.at(-1).trim() === '') trimmedTail.pop()

const hiddenBlock = trimmedTail.some((line) => line === '    - id: hidden-session')
  ? []
  : insertBlock('hidden-session', 'dsh-hidden-session')
const next = [...trimmedTail, '', ...hiddenBlock, ...insertBlock(args.id, args.name, config), '']

const output = next.join('\n')
if (args.dry) {
  console.log(output.slice(-1200))
  process.exit(0)
}
writeFileSync(args.patch, output, 'utf8')
console.log('已写入 ' + args.patch + '（insert ' + args.id + '）')
