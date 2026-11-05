// 关掉某个调试端口上的浏览器（会优雅退出，不留后台进程）。
//
//   node tools/close-browser.mjs [port]
import { closeBrowser } from '../src/browser.mjs'

const port = Number(process.argv[2] ?? 9555)
await closeBrowser(port)
console.log(`已请求关闭 ${port} 端口上的浏览器`)
