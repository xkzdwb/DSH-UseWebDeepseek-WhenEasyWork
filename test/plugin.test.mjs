// 插件装配的离线测试：不需要 DSH、不需要浏览器。用一个假 ctx 验证注册出来的东西对不对。
//
//   node test/plugin.test.mjs
import { apply, inject, name } from '../src/plugin.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 假 ctx：只记录 tools.register 和 systemPrompt.section 的调用。 */
function makeContext({ withPrompt = true } = {}) {
  const tools = []
  const sections = []
  const ctx = { tools: { register: (definition) => { tools.push(definition); return () => {} } } }
  if (withPrompt) {
    ctx.systemPrompt = {
      getSectionOrder: () => 5000,
      section: (section) => { sections.push(section) },
    }
  }
  return { ctx, tools, sections }
}

console.log('用例 1：默认配置注册出完整的工具')
{
  const { ctx, tools, sections } = makeContext()
  apply(ctx, { port: 9556 })
  const tool = tools[0]
  check('插件名', name === 'tool-deepseek-web', name)
  check('声明依赖 tools 服务', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject))
  check('注册了一个工具', tools.length === 1, String(tools.length))
  check('工具名默认 ask_deepseek_web', tool?.name === 'ask_deepseek_web', tool?.name)
  check('参数 schema 是 object 且必填 question',
    tool?.parameters?.type === 'object' && tool?.parameters?.required?.[0] === 'question',
    JSON.stringify(tool?.parameters))
  check('输出 schema 是 object', tool?.output?.schema?.type === 'object')
  check('输出 render 是函数', typeof tool?.output?.render === 'function')
  check('render 直接给出答案文本',
    JSON.stringify(tool.output.render({ question: '1+1' }, { answer: '2', url: 'u', elapsedMs: 1 }))
      === JSON.stringify([{ type: 'text', text: '2' }]))
  check('execute 是函数', typeof tool?.execute === 'function')
  check('声明为不可并发（浏览器只有一个页面）', tool?.isConcurrencySafe?.() === false)
  check('timeoutMs 比问答超时更宽裕', tool?.timeoutMs === 105_000, String(tool?.timeoutMs))

  check('注册了系统提示偏置', sections.length === 1, String(sections.length))
  const text = sections[0]?.text?.() ?? ''
  check('提示里点名了工具', text.includes('ask_deepseek_web'))
  check('提示里划了适用边界', text.includes('不要用它'))
  check('提示带了排序号', sections[0]?.order === 5000, String(sections[0]?.order))
}

console.log('用例 2：promptBias: false 只留工具')
{
  const { ctx, tools, sections } = makeContext()
  apply(ctx, { promptBias: false })
  check('不注册提示偏置', sections.length === 0, String(sections.length))
  check('工具仍然注册', tools.length === 1, String(tools.length))
}

console.log('用例 3：宿主没有 systemPrompt 服务也不影响工具')
{
  const { ctx, tools } = makeContext({ withPrompt: false })
  apply(ctx, {})
  check('工具照样注册', tools.length === 1 && tools[0].name === 'ask_deepseek_web')
}

console.log('用例 4：配置写错时只告警、不抛、不注册')
{
  const { ctx, tools } = makeContext()
  let threw = false
  try {
    apply(ctx, { port: 'abc' })
  } catch {
    threw = true
  }
  check('不会把异常抛给宿主', threw === false)
  check('不合法的端口不会注册工具', tools.length === 0, String(tools.length))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
