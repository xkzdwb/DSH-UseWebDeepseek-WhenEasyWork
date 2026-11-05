// 浏览器生命周期：启动/复用 Edge（或 Chrome）、开标签页、给页面一组小工具函数。
//
// 设计取舍：
// - 不装 playwright/puppeteer：直接用 CDP，靠 Node 自带的全局 WebSocket。
// - 浏览器独立于调用者存活（detached），这样登录态（cookie）留在专用 profile 里，
//   下次调用直接复用，不用反复登录。
// - 只用专用 user-data-dir。Chrome 136+ 起，默认 profile 不允许开远程调试端口，
//   所以必须给一个独立目录，并在里面登录一次 DeepSeek。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Cdp, fetchVersion, listTargets, openTarget } from './cdp.mjs'

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/** 找浏览器可执行文件：环境变量优先，其次常见安装路径。 */
export function resolveBrowserExecutable(explicit) {
  const wanted = explicit || process.env.DSH_WEB_DEEPSEEK_BROWSER
  if (wanted) {
    if (!existsSync(wanted)) throw new Error(`指定的浏览器不存在：${wanted}`)
    return wanted
  }
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate
  throw new Error('找不到 Edge/Chrome，请用 DSH_WEB_DEEPSEEK_BROWSER 指定浏览器路径')
}

/** 专用浏览器 profile 目录（登录态就存在这里）。 */
export function defaultUserDataDir() {
  const base = process.env.DSH_WEB_DEEPSEEK_PROFILE
    || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-web-deepseek', 'profile')
  return base
}

/**
 * 保证有一个开着调试端口的浏览器。
 * @returns {{ port:number, launched:boolean, executable:string, userDataDir:string }}
 */
export async function ensureBrowser({
  port = 9555,
  userDataDir = defaultUserDataDir(),
  executable,
  headless = false,
  extraArgs = [],
} = {}) {
  try {
    await fetchVersion(port)
    return { port, launched: false, executable: resolveBrowserExecutable(executable), userDataDir }
  } catch {
    // 没起来，往下启动
  }

  const bin = resolveBrowserExecutable(executable)
  mkdirSync(userDataDir, { recursive: true })

  const args = [
    `--remote-debugging-port=${port}`,
    // Chrome 111+ 会拒绝带 Origin 头的 WebSocket，Node 的 WebSocket 会带，所以放开来源。
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    ...(headless ? ['--headless=new'] : ['--window-position=1200,80']),
    ...extraArgs,
    'about:blank',
  ]

  const child = spawn(bin, args, { stdio: 'ignore', detached: true, windowsHide: false })
  let exited
  child.on('exit', (code) => { exited = code })
  child.unref()

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (exited !== undefined && exited !== null) {
      throw new Error(`浏览器启动后立即退出（退出码 ${exited}）；profile 可能正被另一个窗口占用：${userDataDir}`)
    }
    try {
      await fetchVersion(port)
      return { port, launched: true, executable: bin, userDataDir }
    } catch {
      await sleep(250)
    }
  }
  throw new Error(`等待浏览器调试端口超时：http://127.0.0.1:${port}/json/version`)
}

/**
 * 关掉这个调试端口上的浏览器。
 * 默认不关（登录态与预热都在同一个浏览器里，关了下次要重开）；
 * 测试、一次性脚本、换 profile 时才需要显式关闭。
 */
export async function closeBrowser(port = 9555) {
  try {
    const version = await fetchVersion(port)
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
    // Browser.close 会优雅退出整个浏览器（含所有标签页）。
    await cdp.send('Browser.close')
    cdp.close()
  } catch {
    // 本来就没起来、或已经关了，都算成功
  }
}

/** 页面对象：一层薄封装，把常用 CDP 命令翻译成好用的方法。 */export class Page {
  constructor(cdp, target) {
    this.cdp = cdp
    this.target = target
    this.id = target.id
  }

  static async open(port, url, { reuse = true } = {}) {
    if (reuse) {
      const existing = (await listTargets(port)).find((target) => target.url.startsWith(url))
      if (existing) {
        const cdp = await Cdp.connect(existing.webSocketDebuggerUrl)
        await cdp.send('Runtime.enable')
        await cdp.send('Page.enable')
        return new Page(cdp, existing)
      }
    }
    const target = await openTarget(port, url)
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    return new Page(cdp, target)
  }

  /** 在页面里求值；返回可序列化的值。 */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`页面内脚本出错：${text}`)
    }
    return result.result.value
  }

  async navigate(url) {
    await this.cdp.send('Page.navigate', { url })
  }

  async currentUrl() {
    return this.evaluate('location.href')
  }

  /** 往当前焦点里输入文本（产生真实输入事件，React 会收到）。 */
  async insertText(text) {
    await this.cdp.send('Input.insertText', { text })
  }

  /** 发一次真正的按键（默认回车）。 */
  async press(key = 'Enter', { code = key, keyCode = 13 } = {}) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key === 'Enter' ? '\r' : undefined })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  close() {
    this.cdp.close()
  }
}

export { sleep }
