// 验证“插件到底装上了没有”：直接读本机会话日志，看最新一轮请求里有什么。
// 不依赖 GUI、不依赖日志文件位置，重启后跑一下就知道结果。
//
//   node tools/inspect-session.mjs
//
// 输出三件事：
//   1) 最新请求的工具清单里有没有 ask_deepseek_web
//   2) 系统提示里有没有“轻问题优先走网页端”那段偏置
//   3) 一句话结论
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const TOOL = 'ask_deepseek_web'
const BIAS = '先调用 ask_deepseek_web 交给网页端'

/** 找最近写过的会话日志：~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd。 */
function newestSessionLog(root) {
  let best = null
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, depth + 1)
      } else if (entry.name === 'session.v4.jsonl.zstd') {
        const mtime = statSync(path).mtimeMs
        if (best === null || mtime > best.mtime) best = { path, mtime }
      }
    }
  }
  walk(root, 0)
  return best?.path
}

/** 日志是多帧 zstd（一个事件一帧），按帧魔数切开逐帧解压。 */
function decompressFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) starts.push(i)
  }
  const parts = []
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8'))
    } catch {
      // 坏帧跳过，不影响其它帧
    }
  }
  return parts.join('')
}

const root = join(homedir(), '.dsh', 'sessions')
const file = newestSessionLog(root)
if (!file) {
  console.error(`没找到会话日志：${root}`)
  process.exit(1)
}
console.log(`会话日志：${file}`)

const text = decompressFrames(readFileSync(file))
const lines = text.split('\n').filter(Boolean)

// 1) 最新一条带 tools 数组的请求
let request = null
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes('"tools":[')) {
    request = lines[i]
    break
  }
}
if (request === null) {
  console.log('日志里没有找到带 tools 数组的请求记录（可能还没发过请求）')
} else {
  const names = [...new Set([...request.matchAll(/"name":"([A-Za-z0-9_.:-]+)"/g)].map((m) => m[1]))]
  const has = request.includes(`"name":"${TOOL}"`)
  console.log(`工具清单共 ${names.length} 个，${TOOL} ${has ? '✅ 在里面' : '❌ 不在里面'}`)
  if (!has) console.log(`  清单：${names.join(', ')}`)
}

// 2) 提示偏置
const biasHits = text.split(BIAS).length - 1
console.log(`提示偏置（“${BIAS}…”）出现 ${biasHits} 次 ${biasHits > 0 ? '✅ 已注入' : '❌ 没注入'}`)

// 3) 结论
const ok = request?.includes(`"name":"${TOOL}"`) === true
console.log(ok ? '\n结论：插件已加载，工具对模型可见。' : '\n结论：工具对模型不可见 —— 检查 cordis.patch.yml 与 HOST 是否重启过。')
process.exit(ok ? 0 : 2)
