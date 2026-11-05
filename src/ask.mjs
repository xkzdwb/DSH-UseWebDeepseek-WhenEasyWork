// 核心流程：把一个问题交给 chat.deepseek.com 的网页端，等它答完，把纯文本答案取回来。
//
// 纯浏览器自动化：全程不调用任何 API、不带 API Key、不走 SDK。
// 走的是页面自己的前端逻辑（含它自己的签名/风控），因此行为与真人手动提问一致。
//
// 状态机：
//   ensureBrowser → 打开页面 → 等编辑器出现（或判定“未登录”）
//   → 聚焦 + 输入 + 回车 → 轮询页面快照，直到答案文本连续两次不变且不在生成中
//   → 返回 { answer, url, elapsedMs }
import { Page, ensureBrowser, sleep } from './browser.mjs'

export const CHAT_URL = 'https://chat.deepseek.com/'

/** 未登录：需要人在打开的窗口里登录一次。 */
export class SignedOutError extends Error {
  constructor(url) {
    super(`网页端未登录（${url}）。请在弹出的浏览器窗口里登录一次，之后登录态会保存在专用 profile 里。`)
    this.name = 'SignedOutError'
    this.url = url
  }
}

/** 找不到输入框：通常是页面结构变了，或者还在加载。 */
export class ComposerNotFoundError extends Error {
  constructor(url, waitedMs) {
    super(`${waitedMs}ms 内没找到输入框（${url}）。可能是页面还没加载完，或网页端改版了；运行 tools/probe.mjs 看当前 DOM。`)
    this.name = 'ComposerNotFoundError'
    this.url = url
  }
}

/** 等答案超时。 */
export class AnswerTimeoutError extends Error {
  constructor(timeoutMs, partial) {
    super(`等待回答超时（${timeoutMs}ms）${partial ? '，只拿到不完整的文本' : ''}`)
    this.name = 'AnswerTimeoutError'
    this.partial = partial
  }
}

// 选择器按“尽量通用”排序：DeepSeek 用 ds-* 设计系统，输入框目前是 textarea，
// 但页面改版时可能是 contenteditable，所以两者都认。
const COMPOSER_SELECTORS = [
  'textarea[placeholder*="DeepSeek"]',
  'textarea[placeholder*="消息"]',
  'textarea[placeholder*="Message"]',
  'textarea',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  'div[role="textbox"]',
]

/** 在页面里跑：一次拿到判断所需的全部状态。 */
const SNAPSHOT = `(() => {
  const selectors = ${JSON.stringify(COMPOSER_SELECTORS)};
  const composer = selectors.map((s) => document.querySelector(s)).find(Boolean) || null;
  const blocks = [...document.querySelectorAll('.ds-markdown')];
  const last = blocks[blocks.length - 1];
  // “停止生成”按钮存在即为流式中；只在按钮类元素里找，避免扫全页。
  const streaming = [...document.querySelectorAll('button, [role="button"], .ds-button')]
    .some((el) => /停止生成|Stop generating|停止/.test((el.textContent || '').trim()));
  return {
    url: location.href,
    path: location.pathname,
    signedOut: /sign_in|login/i.test(location.pathname),
    hasComposer: composer !== null,
    markdownCount: blocks.length,
    lastText: last ? (last.innerText || '').trim() : '',
    streaming,
    bodyHead: (document.body.innerText || '').slice(0, 200),
  };
})()`

/** 点掉会让回答变慢的开关（深度思考 / 联网搜索），失败不影响主流程。 */
const DISABLE_TOGGLES = `(() => {
  const labels = [/深度思考/, /DeepThink/i, /联网搜索/, /Search/i];
  const clicked = [];
  const candidates = [...document.querySelectorAll('[role="button"], button, .ds-button')];
  for (const el of candidates) {
    const text = (el.textContent || '').trim();
    if (!labels.some((re) => re.test(text))) continue;
    const pressed = el.getAttribute('aria-pressed');
    const active = pressed === 'true' || /active|selected|checked/i.test(el.className || '');
    if (active) {
      el.click();
      clicked.push(text.slice(0, 12));
    }
  }
  return clicked;
})()`

/** 聚焦输入框，返回是否成功。 */
const focusComposer = (selectors) => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const el = selectors.map((s) => document.querySelector(s)).find(Boolean);
  if (!el) return false;
  el.focus();
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return document.activeElement === el || el.contains(document.activeElement);
})()`

/**
 * 问网页端一个问题。
 * @param {string} question 问题文本
 * @param {object} [options]
 * @param {number} [options.port] 调试端口（默认 9555）
 * @param {string} [options.userDataDir] 浏览器 profile（登录态所在）
 * @param {boolean} [options.headless] 无头模式；首次登录必须是 false
 * @param {string} [options.url] 目标页面，测试时可指向本地 fixture
 * @param {number} [options.timeoutMs] 等答案的总超时（默认 90s）
 * @param {number} [options.readyTimeoutMs] 等输入框出现的超时（默认 30s）
 * @param {number} [options.pollMs] 轮询间隔（默认 400ms）
 * @param {boolean} [options.newChat] 是否先回到新会话（默认 true）
 * @param {(message: string) => void} [options.log] 调试日志
 * @returns {Promise<{answer: string, url: string, elapsedMs: number, disabledToggles: string[]}>}
 */
export async function ask(question, options = {}) {
  const {
    port = 9555,
    userDataDir,
    headless = false,
    url: targetUrl = CHAT_URL,
    timeoutMs = 90_000,
    readyTimeoutMs = 30_000,
    pollMs = 400,
    newChat = true,
    signal,
    log = () => {},
  } = options

  if (typeof question !== 'string' || question.trim() === '') throw new Error('问题不能为空')
  const started = Date.now()
  // 取消是协作式的：每一轮轮询前看一眼调用方给的 signal。
  const checkAborted = () => {
    if (signal?.aborted) throw new Error('已取消')
  }

  const browser = await ensureBrowser({ port, userDataDir, headless })
  log(`浏览器就绪（${browser.launched ? '本次启动' : '复用已有窗口'}）：${browser.executable}`)

  const page = await Page.open(port, targetUrl, { reuse: true })
  try {
    if (newChat && targetUrl === CHAT_URL) {
      // 回根路径 = 新会话；避免上一次的上下文影响这次问答。
      const current = await page.currentUrl()
      if (!/^https:\/\/chat\.deepseek\.com\/?$/.test(current)) {
        await page.navigate(CHAT_URL)
        await sleep(1200)
      }
    }

    // 1) 等编辑器或登录墙
    const readyAt = Date.now() + readyTimeoutMs
    let snapshot = null
    while (Date.now() < readyAt) {
      checkAborted()
      snapshot = await page.evaluate(SNAPSHOT)
      if (snapshot.signedOut) throw new SignedOutError(snapshot.url)
      if (snapshot.hasComposer) break
      await sleep(300)
    }
    if (!snapshot?.hasComposer) throw new ComposerNotFoundError(snapshot?.url ?? targetUrl, readyTimeoutMs)
    log(`输入框已出现（markdown 块 ${snapshot.markdownCount} 个）`)

    // 2) 关掉深度思考 / 联网搜索（只对 light 问题有意义，失败不致命）
    let disabledToggles = []
    try {
      disabledToggles = await page.evaluate(DISABLE_TOGGLES)
      if (disabledToggles.length > 0) log(`已关闭开关：${disabledToggles.join('、')}`)
    } catch (error) {
      log(`关闭开关时出错（忽略）：${error.message}`)
    }

    // 3) 输入并发送
    checkAborted()
    const focused = await page.evaluate(focusComposer(COMPOSER_SELECTORS))
    if (!focused) throw new ComposerNotFoundError(snapshot.url, 0)
    await page.insertText(question)
    await sleep(150)
    await page.press('Enter')
    log('已发送，等待回答…')

    // 4) 轮询直到文本稳定
    const baseline = snapshot.markdownCount
    let lastText = ''
    let stable = 0
    let best = ''
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      checkAborted()
      await sleep(pollMs)
      const now = await page.evaluate(SNAPSHOT)
      if (now.signedOut) throw new SignedOutError(now.url)
      if (now.markdownCount <= baseline || now.lastText === '') continue
      if (now.lastText === lastText && !now.streaming) stable += 1
      else stable = 0
      lastText = now.lastText
      best = now.lastText
      // 连续两次采样都没变化、且没有“停止生成”按钮 → 认为答完了
      if (stable >= 2) {
        log(`回答完成（${Date.now() - started}ms，${best.length} 字符）`)
        return { answer: best, url: now.url, elapsedMs: Date.now() - started, disabledToggles }
      }
    }
    throw new AnswerTimeoutError(timeoutMs, best)
  } finally {
    page.close()
  }
}
