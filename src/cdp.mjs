// 极简 Chrome DevTools Protocol 客户端：不依赖 playwright / puppeteer。
// 只做三件事：连上某个标签页的 WebSocket、发命令、收事件。
// Node ≥ 22 与 Electron 都自带全局 WebSocket（undici），所以零依赖。

/** 一个 CDP 命令失败时抛出的错误。 */
export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? JSON.stringify(error)}`)
    this.name = 'CdpError'
    this.method = method
    this.code = error?.code
    this.data = error?.data
  }
}

export class Cdp {
  #ws
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()

  constructor(ws) {
    this.#ws = ws
    ws.addEventListener('message', (event) => this.#receive(event.data))
    ws.addEventListener('close', () => this.#failAll(new Error('CDP 连接已断开')))
  }

  /** 连到一个 ws:// 端点；失败时给出可读的报错。 */
  static connect(wsUrl, { timeoutMs = 10_000 } = {}) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前运行时没有全局 WebSocket，无法直连 CDP（需要 Node ≥ 22 或 Electron 28+）')
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`连接 CDP 超时：${wsUrl}`))
      }, timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new Cdp(ws))
      }, { once: true })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`连接 CDP 失败：${wsUrl}`))
      }, { once: true })
    })
  }

  #receive(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.#pending.get(message.id)
      if (!entry) return
      this.#pending.delete(message.id)
      if (message.error) entry.reject(new CdpError(entry.method, message.error))
      else entry.resolve(message.result)
      return
    }
    if (typeof message.method === 'string') {
      for (const listener of this.#listeners.get(message.method) ?? []) {
        try {
          listener(message.params)
        } catch {
          // 监听器自己的异常不应打断收包
        }
      }
    }
  }

  #failAll(error) {
    for (const [, entry] of this.#pending) entry.reject(error)
    this.#pending.clear()
  }

  /** 发一条命令并等它的结果。 */
  send(method, params = {}) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      try {
        this.#ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  /** 订阅一个 CDP 事件（不返回取消函数：连接生命周期内有效）。 */
  on(method, listener) {
    const list = this.#listeners.get(method) ?? []
    list.push(listener)
    this.#listeners.set(method, list)
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      // 已经关了
    }
  }
}

/** 取浏览器端点信息（/json/version），用来判断“浏览器起来了没有”。 */
export async function fetchVersion(port, { timeoutMs = 2000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`/json/version 返回 ${response.status}`)
  return response.json()
}

/** 列出所有标签页。 */
export async function listTargets(port, { timeoutMs = 5000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`/json/list 返回 ${response.status}`)
  const targets = await response.json()
  return targets.filter((target) => target.type === 'page')
}

/**
 * 新开一个标签页并返回它的 target 描述。
 * 新版 Chrome/Edge 要求 PUT（GET 会 405），这里统一用 PUT。
 */
export async function openTarget(port, url, { timeoutMs = 15_000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`/json/new 返回 ${response.status}`)
  return response.json()
}

/** 关闭指定标签页。 */
export async function closeTarget(port, id) {
  await fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: AbortSignal.timeout(5000) }).catch(() => {})
}
