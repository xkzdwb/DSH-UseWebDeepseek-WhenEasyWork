// 诊断脚本：用真实浏览器打开一个页面，导出“这个页面长什么样”的结构化快照。
// 用途：改选择器之前先看清真实 DOM，而不是猜类名。
//
//   node tools/probe.mjs [url] [--headed] [--profile <dir>] [--port <n>]
import { fileURLToPath } from 'node:url'
import { ensureBrowser, Page, sleep } from '../src/browser.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}
const positional = argv.find((arg, index) => !arg.startsWith('--') && !String(argv[index - 1] ?? '').startsWith('--'))
const url = positional ?? 'https://chat.deepseek.com/'
const port = Number(flag('port') ?? 9555)
const profile = flag('profile') ?? fileURLToPath(new URL('../.cache/edge-profile-probe', import.meta.url))

const browser = await ensureBrowser({ port, userDataDir: profile, headless: !argv.includes('--headed') })
console.log(`browser: ${browser.executable} (launched=${browser.launched}, profile=${browser.userDataDir})`)

const page = await Page.open(port, url, { reuse: false })
try {
  await sleep(4000)
  const snapshot = await page.evaluate(`(() => {
    const pick = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      aria: el.getAttribute('aria-label') || undefined,
      role: el.getAttribute('role') || undefined,
      cls: (el.className && typeof el.className === 'string' ? el.className.slice(0, 100) : undefined),
      text: (el.innerText || '').trim().slice(0, 50) || undefined,
    })
    const all = (selector) => [...document.querySelectorAll(selector)]
    return {
      title: document.title,
      url: location.href,
      textareas: all('textarea').map(pick),
      editables: all('[contenteditable="true"], [contenteditable=""]').map(pick),
      buttons: all('button, [role="button"]').slice(0, 30).map(pick),
      markdownCount: all('.ds-markdown').length,
      bodyText: (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 800),
    }
  })()`)
  console.log(JSON.stringify(snapshot, null, 2))
} finally {
  page.close()
}
