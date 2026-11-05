// DSH 插件：把“网页端 DeepSeek 问答”注册成一个工具。
//
// 关键在于它跑在 DSH 的 HOST 进程里：那个进程不受会话沙盒限制，所以能启动
// 真正的浏览器（Chromium 在受限令牌里会直接崩）。工具本身不发任何 HTTP 请求，
// 只是驱动 chat.deepseek.com 的页面。
//
// 装配（profile 的 cordis.patch.yml）：
//   - insert:
//       - id: tool-deepseek-web
//         name: "/absolute/path/to/DSH-UseWebDeepseek-WhenEasyWork/src/plugin.js"
//         config:
//           port: 9555
//  改完需要重启 DSH 才会加载。
import { ask, SignedOutError, AnswerTimeoutError, ComposerNotFoundError } from './ask.mjs'

const name = 'tool-deepseek-web'
const inject = ['tools']

const DEFAULTS = {
  toolName: 'ask_deepseek_web',
  port: 9555,
  userDataDir: undefined,
  headless: false,
  timeoutMs: 90_000,
  // 默认开：所有会话都被告知“轻问题优先走网页端”，而不是把工具摆在那里等人用。
  promptBias: true,
}

const DESCRIPTION =
  '把一句话就能答完的简单问题交给 chat.deepseek.com 的网页端 DeepSeek 回答（驱动真实浏览器，不消耗 API 额度、不新增 agent 对话）。'
  + '适用：算术、单位换算、事实性小问题、翻译一句、格式转换、写一小段样板代码。'
  + '不适用：需要读文件、跑命令、多步推理或与当前工作区交互的任务——那些直接用你手头的工具。'
  + '答案来自网页端，可能带它自己的口语化表达；转述时保持原样。'

/** cordis 的 Config 字段可能是即时引用（.get()），也可能已是纯值。 */
function value(input, fallback) {
  const raw = input !== null && typeof input === 'object' && typeof input.get === 'function' ? input.get() : input
  return raw === undefined || raw === null ? fallback : raw
}

function readSettings(rawConfig) {
  const input = rawConfig ?? {}
  return {
    toolName: String(value(input.toolName, DEFAULTS.toolName)),
    port: Number(value(input.port, DEFAULTS.port)),
    userDataDir: value(input.userDataDir, DEFAULTS.userDataDir),
    headless: value(input.headless, DEFAULTS.headless) === true,
    timeoutMs: Number(value(input.timeoutMs, DEFAULTS.timeoutMs)),
    promptBias: value(input.promptBias, DEFAULTS.promptBias) !== false,
  }
}

// 同一个页面不能并发问答：串行化，避免两次输入互相踩。
let queue = Promise.resolve()
function serialized(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

/** 把“要人做的事”翻译成模型能照做的说法，而不是一串英文堆栈。 */
function translate(error) {
  if (error instanceof SignedOutError) {
    return new Error(`网页端 DeepSeek 还没登录：先在弹出的浏览器窗口里登录一次（${error.url}），再重试。`)
  }
  if (error instanceof AnswerTimeoutError) {
    return new Error(`网页端 DeepSeek 回答超时：${error.message}。可以改用直接回答，或调大插件配置里的 timeoutMs。`)
  }
  if (error instanceof ComposerNotFoundError) {
    return new Error(`${error.message} 可能是未登录、页面还在加载，或网页端改版。`)
  }
  return error
}

function register(ctx, rawConfig) {
  const initial = readSettings(rawConfig)
  if (!Number.isFinite(initial.port) || initial.port <= 0) throw new Error(`[${name}] port 必须是正整数`)
  if (!Number.isFinite(initial.timeoutMs) || initial.timeoutMs <= 0) throw new Error(`[${name}] timeoutMs 必须是正整数`)

  ctx.tools.register({
    name: initial.toolName,
    description: DESCRIPTION,
    parameters: {
      // 与 defineTool 编译出来的形状保持一致：只有 type/properties/required。
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问网页端的问题原文，尽量一句话说清' },
      },
      required: ['question'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string' },
          url: { type: 'string' },
          elapsedMs: { type: 'number' },
        },
        required: ['answer', 'url', 'elapsedMs'],
      },
      render: (_args, result) => [{ type: 'text', text: result.answer }],
    },
    timeoutMs: initial.timeoutMs + 15_000,
    // 浏览器只有一个页面，必须串行执行。
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const settings = readSettings(rawConfig)
      try {
        const result = await serialized(() => ask(args.question, {
          port: settings.port,
          userDataDir: settings.userDataDir,
          headless: settings.headless,
          timeoutMs: settings.timeoutMs,
          signal: exec.signal,
          log: (message) => console.warn(`[${name}] ${message}`),
        }))
        return { answer: result.answer, url: result.url, elapsedMs: result.elapsedMs }
      } catch (error) {
        throw translate(error)
      }
    },
  })

  // 系统提示偏置：让“轻问题”默认就走网页端，而不是让模型自由发挥。
  // 这一段是尽力而为——systemPrompt 的具体形状在版本间会变，失败只告警，绝不阻断工具本身。
  if (initial.promptBias) {
    try {
      const order = typeof ctx.systemPrompt?.getSectionOrder === 'function'
        ? ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH')
        : undefined
      ctx.systemPrompt.section({
        name: `tool:${initial.toolName}`,
        ...(Number.isFinite(order) ? { order } : {}),
        text: () => `遇到一句话就能答完的轻问题（算术、单位换算、事实确认、翻译一句、格式转换、写一小段样板代码），`
          + `先调用 ${initial.toolName} 交给网页端 DeepSeek，不要自己长篇推演；答案以它返回的原文为准。`
          + `需要读写文件、执行命令、分析本工作区或多步推理时，不要用它，直接用现有工具。`,
      })
    } catch (error) {
      console.warn(`[${name}] 系统提示偏置注册失败（忽略，工具仍可用）：${error?.message ?? error}`)
    }
  }

  console.warn(`[${name}] 已注册工具 ${initial.toolName}（端口 ${initial.port}，profile ${initial.userDataDir ?? '默认'}，提示偏置 ${initial.promptBias ? '开' : '关'}）`)
}

/**
 * 插件入口。整体兜一层：这个功能属于“锦上添花”，配置写错不该把 DSH 启动拖下水。
 * 失败时只在 HOST 日志里留下完整原因，工具缺席，其它功能照常。
 */
function apply(ctx, rawConfig) {
  try {
    register(ctx, rawConfig)
  } catch (error) {
    console.warn(`[${name}] 加载失败，工具未注册：${error?.stack ?? error}`)
  }
}

export { apply, inject, name }