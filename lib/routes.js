/**
 * 管理面：给排障 / 未来的设置页留的 HTTP 端点。
 *
 * 全部只允许回环访问 + 同源校验（与官方插件同一套判定），
 * 因为档案属于用户隐私，任何跨站页面都不该读到它。
 *
 *   GET  /api/dsh-persona-profile/state    运行状态（不返回档案正文）
 *   GET  /api/dsh-persona-profile/profile  档案 Markdown 全文
 *   POST /api/dsh-persona-profile/refresh  立即总结（body: { sessionId? }）
 */

import { renderSummary } from './profile.js'

const API_PREFIX = '/api/dsh-persona-profile'
const MAX_JSON_BODY_BYTES = 64 * 1024

function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch {
    /* 客户端提前断开：没有补救余地，也不该把异常抛回 webServer */
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./settings.js').resolveSettings>} deps.settings
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {ReturnType<import('./summarizer.js').createSummarizer>} deps.summarizer
 */
export function createRoutes(deps) {
  const { settings, store, summarizer } = deps

  const stateRoute = {
    kind: 'exact',
    path: API_PREFIX + '/state',
    handler: (req, res) => {
      if (isLoopbackRequest(req) === false) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      try {
        const status = store.status()
        writeJson(res, 200, {
          ...status,
          summaryText: renderSummary(store.readProfile()),
          running: summarizer.running(),
          paths: {
            profile: store.paths.profileMd,
            json: store.paths.profileJson,
            journal: store.paths.journal,
            sessions: store.paths.sessions,
          },
        })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const profileRoute = {
    kind: 'exact',
    path: API_PREFIX + '/profile',
    handler: (req, res) => {
      if (isLoopbackRequest(req) === false) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      try {
        const profile = store.readProfile()
        writeJson(res, 200, {
          dir: settings.dir,
          updatedAt: profile.meta.updatedAt,
          markdown: store.readProfileMarkdown(),
          profile,
        })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const refreshRoute = {
    kind: 'exact',
    path: API_PREFIX + '/refresh',
    handler: async (req, res) => {
      if (isLoopbackRequest(req) === false) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { error: 'invalid json body' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== ''
        ? body.sessionId
        : store.status().pendingSessions[0]?.sessionId
      if (sessionId === undefined) {
        writeJson(res, 200, { ok: false, reason: 'no-pending-session' })
        return
      }
      try {
        const result = await summarizer.summarize(sessionId, { force: true })
        writeJson(res, 200, {
          ok: result.ok === true,
          reason: result.reason,
          sessionId,
          added: result.added ?? [],
          updatedAt: store.readProfile().meta.updatedAt,
        })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  return [stateRoute, profileRoute, refreshRoute]
}

/**
 * 挂到 webServer 上。`webServer` 是可选服务：没声明 inject 时只能 ctx.get()，
 * 拿不到就退化成「管理面不可用」，总结逻辑照常工作。
 */
export function mountRoutes(ctx, webServer, routes, logger) {
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return false
  for (const route of routes) {
    try {
      ctx.effect(() => webServer.register(route), 'dsh-persona-profile: route ' + route.path)
    } catch (err) {
      logger?.warn?.('[dsh-persona-profile] 注册路由 ' + route.path + ' 失败：' + String(err))
    }
  }
  return true
}
