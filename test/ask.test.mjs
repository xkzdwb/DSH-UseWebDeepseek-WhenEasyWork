// 离线回归测试：不需要登录、不联网，验证 ask.mjs 的“输入 → 流式 → 判完 → 取值”时序。
//
//   node test/ask.test.mjs
//
// 注意：Chromium 在 DSH 的受限沙盒里会崩，所以这个测试要在“完全权限”或普通终端里跑。
import { fileURLToPath } from 'node:url'
import { ask } from '../src/ask.mjs'
import { closeBrowser } from '../src/browser.mjs'

const fixture = new URL('./fixture.html', import.meta.url).href
const profile = fileURLToPath(new URL('../.cache/test-profile', import.meta.url))
const port = 9559

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('用例 1：基础问答取回完整答案')
const first = await ask('1+1=?', {
  url: fixture,
  port,
  headless: true,
  userDataDir: profile,
  timeoutMs: 30_000,
  log: (message) => console.log(`       · ${message}`),
})
check('答案包含算式', first.answer.includes('1+1=?'), JSON.stringify(first.answer))
check('答案包含结果 2', first.answer.includes('2'), JSON.stringify(first.answer))
check('答案已收尾（不是截断）', first.answer.trim().endsWith('完毕。'), JSON.stringify(first.answer))
check('耗时为正数', first.elapsedMs > 0, String(first.elapsedMs))

console.log('用例 2：同一页面上第二次提问（复用标签页）')
const second = await ask('2+2=?', {
  url: fixture,
  port,
  headless: true,
  userDataDir: profile,
  timeoutMs: 30_000,
})
check('第二次也拿到答案', second.answer.includes('2+2=?'), JSON.stringify(second.answer))
check('第二次没有粘上上一次的答案', !second.answer.includes('1+1'), JSON.stringify(second.answer))

console.log('用例 3：超时能触发并带出部分文本')
try {
  await ask('3+3=?', {
    url: fixture,
    port,
    headless: true,
    userDataDir: profile,
    timeoutMs: 400, // 故意小于 1.5s 的流式时长
    pollMs: 100,
  })
  check('应当超时', false, '没有抛错')
} catch (error) {
  check('超时错误类型正确', error.name === 'AnswerTimeoutError', `${error.name}: ${error.message}`)
  check('超时错误带部分文本', typeof error.partial === 'string', String(error.partial))
}

// 测试用的浏览器是我们自己起的，收尾时关掉，别在后台留一个无头 Edge。
await closeBrowser(port)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
