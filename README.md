# dsh-persona-profile

DSH 插件：**隔一段时间自动总结用户性格**，落盘到 `F:/性格`，并在任何模型需要时告诉它去哪里看。

- 采集：只收真人发言（`source.kind === 'user'`），按会话攒进缓冲，重启不丢。
- 总结：到点（默认 30 分钟）调一次模型，把新样本**增量合并**进档案；模型跑偏时保留旧档案。
- 提示：向所有 agent 注入一段极短的系统提示，说明档案在哪、什么时候去读。
- 工具：`persona_profile`，模型不受沙箱文件权限限制也能读到全文，还能 `refresh` 立即刷新。

## 安装（本机已装到 web profile）

```powershell
# 1) 插件目录挂进 profile
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-persona-profile" `
  -Target 'F:\code\dsh插件\dsh-persona-profile'

# 2) package.json 的 dependencies 加一行（profile 侧解析用）
#    "dsh-persona-profile": "link:F:/code/dsh插件/dsh-persona-profile"

# 3) 注册到 cordis.patch.yml（幂等，UTF-8 安全）
node scripts/install-profile.mjs --patch "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" `
  --id persona-profile --name dsh-persona-profile
```

改完 patch 需要**重启 DSH** 才生效（配置层只在启动时组合）。

## 配置

写在 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: persona-profile
      name: 'dsh-persona-profile'
      config:
        dir: 'F:/性格'        # 工作区（必须是绝对路径）
        intervalMinutes: 30   # 自动总结间隔
        enabled: true
```

| 键 | 默认 | 说明 |
|---|---|---|
| `dir` | `F:/性格` | 工作区；相对路径会退回默认值 |
| `enabled` | `true` | 总开关（关掉后不采集、不注入、不注册工具） |
| `intervalMinutes` | `30` | 两次总结的最小间隔（1–1440） |
| `minNewMessages` | `4` | 至少攒够几条发言才总结 |
| `minChars` | `120` | 或者攒够多少字符（两者满足其一） |
| `maxInputChars` | `12000` | 单次喂给模型的原始文本上限 |
| `maxProfileChars` | `6000` | `profile.md` 长度上限（超出截断并提示） |
| `maxTraits` | `12` | 最多保留多少条特征（按置信度裁） |
| `provider` / `model` | 空 | 留空 = 跟随会话自己的模型 |
| `timeZone` | `Asia/Shanghai` | 时间戳时区 |
| `injectSection` | `true` | 是否注入系统提示段 |
| `registerTool` | `true` | 是否注册 `persona_profile` 工具 |
| `summarizeSubagents` | `false` | 是否连子代理会话的发言也算 |
| `tickSeconds` | `60` | 扫描间隔（到点检查的粒度） |
| `requestTimeoutMs` | `120000` | 单次总结请求超时 |
| `retryBackoffMs` | `300000` | 失败后退避 |
| `debug` | `false` | 往 `<dir>/debug.log` 写排障日志 |

## 工作区结构（`F:/性格`）

| 文件 | 说明 |
|---|---|
| `profile.md` | **给模型读的**档案（自动生成，别手改） |
| `profile.json` | 结构化状态，插件合并用 |
| `journal.md` | 每次总结的流水（新增了什么、来自哪个会话） |
| `sessions/<id>.md` | 按会话记录的原始发言片段（人工核对证据） |
| `state.json` | 待总结缓冲 + 时间戳（重启不丢） |
| `debug.log` | `debug: true` 时的排障日志 |

## 模型怎么用

1. 系统提示里会出现一段 `[用户性格档案]`，给出路径、最后更新时间、一句话画像；
2. 需要个性化取舍时调 `persona_profile`（`action=read` 全文 / `summary` 一句话 / `refresh` 立即刷新 / `status` 运行状态）；
3. 档案是**推断**，不是用户自述；与用户当前指令冲突时以指令为准；
4. 不要在无关回答里复述档案内容。

## 工作原理

```
session/event(user/message, source.kind=user)
        │  过滤掉运行时快照 / 子代理回报 / 别的插件的 notice
        ▼
   store.note()  ──►  state.json（按会话缓冲，重启不丢）
        │
        │  setInterval(tickSeconds) + turn/end 到点触发
        ▼
   summarizer.summarize()
        │  ctx.llm.stream({provider, model, messages, signal, maxTokens})
        ▼
   模型返回 JSON ──► parseProfileJson() ──► mergeProfile() ──► profile.json + profile.md
        │                                   （失败则退避、缓冲保留）
        ▼
   systemPrompt.section(text 函数) 每 step 求值 ──► 所有 agent 看到最新时间戳/画像
```

关键设计取舍：

- **只收真人发言**：DSH 会话里的 `user/message` 还有运行时快照、技能目录、子代理回报、别的插件 steer 的提醒；混进来就会总结出「机器性格」。
- **增量合并而非覆盖**：模型这轮没提到的条目保留，避免上下文抖动导致档案反复清空；`open_questions` 例外（用新值覆盖）。
- **提示段极短**：它每 step 都进上下文，细节交给工具按需读。
- **工具兜底**：`workspace-write` 沙箱下读不到工作区外的路径，工具在宿主进程里读文件不受此限。
- **写盘原子化**：`tmp + rename`，避免进程被杀留下半个 JSON。
- **全局串行**：一次只发一个总结请求；同一会话并发时后到的等待前一个，而不是报 busy。

## 排障

| 现象 | 先看什么 |
|---|---|
| 模型没有 `persona_profile` 工具 | `<dir>/debug.log` 里的 `tool register FAILED`；或 profile 里 `tools` 服务是否可用 |
| 档案一直不更新 | `/api/dsh-persona-profile/state` 的 `pendingSessions`；`intervalMinutes` 与 `minNewMessages` 是否满足 |
| 档案是空的 | 是否只有插件消息/子代理会话；`summarizeSubagents: false` 时子代理发言不计入 |
| 提示段没出现 | `injectSection` 是否为 true；profile 里是否有 `system-prompt` 行 |
| 管理面 404 | profile 没有 `webServer`（headless/tui），属正常 |

管理面（回环 + 同源校验）：

```bash
curl http://127.0.0.1:<port>/api/dsh-persona-profile/state
curl http://127.0.0.1:<port>/api/dsh-persona-profile/profile
curl -X POST http://127.0.0.1:<port>/api/dsh-persona-profile/refresh -d '{}'
```

## 测试

```bash
npm test          # 25 个单测 + 16 个假宿主集成用例
```

真实宿主验证（headless + 真模型，工作区指向临时目录）：

```bash
node tools/asar-peek.mjs ...   # 查 API 用
dsh --profile headless --patch ./sandbox/patch-persona.yml "调用 persona_profile action=refresh ..."
```

## 代码质量

用 [fuck-u-code](https://github.com/Done-0/fuck-u-code)（`npm i -g eff-u-code`）检查：

| 轮次 | 糟糕指数 | 等级 | 主要问题 |
|---|---|---|---|
| 初版 | 93.08 / 100 | 🌸 偶有异味 | `mergeProfile` 复杂度 21、`runOnce` 嵌套 6、多处未处理易出错调用 |
| 重构后 | 96.63 / 100 | 🌱 清新可人 | 仅剩参数数量与静态误报 |

```bash
fuck-u-code analyze ./dsh-persona-profile -l zh -v -t 20 -f markdown -o report.md
```

## 已知限制

- 总结依赖模型输出 JSON；模型持续不听话时会一直走失败退避（`journal.md` 里有 `PARSE-ERROR` 记录）。
- 档案只从「用户发言」推断，不读助手回复，所以「用户对什么满意」这类信息只能间接得到。
- 不做加密：`F:/性格` 里的内容就是明文画像，介意的话自己加盘符级加密。
