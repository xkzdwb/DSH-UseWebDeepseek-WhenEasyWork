// 命令行入口：把一个问题丢给网页端 DeepSeek，把答案打到 stdout。
//
//   node src/cli.mjs "1+1=?"            普通输出
//   node src/cli.mjs "1+1=?" --json     输出 JSON（含耗时、URL）
//   node src/cli.mjs "1+1=?" --headed   显示浏览器窗口（首次登录必须这样）
//
// 退出码：0 成功；2 未登录；3 等待超时；1 其他错误。
import { ask, SignedOutError, AnswerTimeoutError, ComposerNotFoundError } from './ask.mjs'
import { closeBrowser, defaultUserDataDir } from './browser.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const next = argv[index + 1]
  return next === undefined || next.startsWith('--') ? true : next
}
const question = argv.find((arg, index) => !arg.startsWith('--') && !String(argv[index - 1] ?? '').startsWith('--'))

if (!question) {
  console.error('用法：node src/cli.mjs "问题" [--json] [--headless] [--port 9555] [--profile <dir>] [--timeout 90000]')
  process.exit(1)
}

const options = {
  port: Number(flag('port', 9555)),
  userDataDir: flag('profile', undefined),
  headless: argv.includes('--headless'),
  timeoutMs: Number(flag('timeout', 90_000)),
  log: (message) => process.stderr.write(`[web-deepseek] ${message}\n`),
}

try {
  const result = await ask(question, options)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${result.answer}\n`)
  }
  // 默认留着浏览器（下次更快、登录态也在）；--close 时用完就关。
  if (argv.includes('--close')) await closeBrowser(options.port)
} catch (error) {
  process.stderr.write(`[web-deepseek] ${error.name}: ${error.message}\n`)
  if (error instanceof SignedOutError) {
    process.stderr.write(`[web-deepseek] 登录一次即可：浏览器窗口停在 ${error.url}，登录后本 profile 会记住状态（${options.userDataDir ?? defaultUserDataDir()}）\n`)
    process.exit(2)
  }
  if (error instanceof AnswerTimeoutError) process.exit(3)
  if (error instanceof ComposerNotFoundError) process.exit(1)
  process.exit(1)
}
