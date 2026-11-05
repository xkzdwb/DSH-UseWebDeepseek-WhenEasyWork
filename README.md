# DSH-UseWebDeepseek-WhenEasyWork

> 让 DSH 的「一句话小问题」自动走 **chat.deepseek.com 网页端**：真实浏览器 + 真实登录态，
> **不调 API、不带 Key、不走 SDK**，也不额外开一轮 agent 对话。

把「一加一等于几」这类一句话就能答完的问题，交给网页端的 DeepSeek 回答：

- **给 DSH 用**：插件把能力注册成工具 `ask_deepseek_web`，模型遇到轻问题直接调它；
- **自己用**：`node src/cli.mjs "1+1=?"` 一条命令拿答案。

零依赖：只用 Node 内置模块（`node:http` / `node:child_process` / 自己实现的极简 CDP 客户端），
`npm install` 都不需要。

---

## 1. 它到底怎么做的

```
调用方（DSH 工具 / 命令行）
  └─ src/ask.mjs
       ├─ src/browser.mjs   起 Edge（专用 profile，登录态常驻）→ 打开 https://chat.deepseek.com/
       ├─ CDP（DevTools 协议，WebSocket 直连，零依赖）
       │    ├─ 聚焦输入框 → Input.insertText 真实输入 → 回车发送
       │    └─ 每 400ms 取一次页面快照：答案文本长度 / 是否还有“停止生成”按钮
       └─ 判定：新的 .ds-markdown 出现 且 文本连续两次不变 且 无停止按钮 → 收工，返回纯文本
```

不做的事：不伪造请求、不抓包、不改页面 JS，只是**像人一样在页面上打字和读字**。
所以它天然复用网页端自己的风控与签名逻辑。

## 2. 文件

| 文件 | 作用 |
|---|---|
| [src/cdp.mjs](src/cdp.mjs) | 极简 CDP 客户端（连接、发命令、收事件） |
| [src/browser.mjs](src/browser.mjs) | 启动/复用浏览器、专用 profile、页面小工具、关闭浏览器 |
| [src/ask.mjs](src/ask.mjs) | 提问主流程与三个明确的错误类型（未登录 / 找不到输入框 / 超时） |
| [src/cli.mjs](src/cli.mjs) | 命令行入口，退出码 0/2/3/1 |
| [src/plugin.js](src/plugin.js) | DSH 插件：注册工具 `ask_deepseek_web` |
| [test/fixture.html](test/fixture.html) | 离线替身页面（模拟输入框 + 流式输出 + 停止按钮） |
| [test/ask.test.mjs](test/ask.test.mjs) | 离线回归测试，3 个用例，不联网不登录 |
| [test/plugin.test.mjs](test/plugin.test.mjs) | 插件装配测试：假 ctx 下验证注册出来的工具/提示是否正确（不需要 DSH、不需要浏览器） |
| [tools/probe.mjs](tools/probe.mjs) | DOM 探针：网页改版后用它看真实结构 |
| [tools/close-browser.mjs](tools/close-browser.mjs) | 关掉后台那个调试端口上的浏览器（优雅退出） |
| [tools/inspect-session.mjs](tools/inspect-session.mjs) | 验证插件是否真的加载：读最近的会话日志，看工具清单与提示偏置 |
| [examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml) | 装进 DSH 的配置片段 |

## 3. 先跑离线测试（30 秒，不需要登录）

```powershell
cd <解压或 clone 下来的目录>
node test/ask.test.mjs
```

实测输出（Windows + Edge 156）：

```
用例 1：基础问答取回完整答案
       · 浏览器就绪（本次启动）：C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
       · 输入框已出现（markdown 块 0 个）
       · 已发送，等待回答…
       · 回答完成（3159ms，24 字符）
  ok   答案包含算式
  ok   答案包含结果 2
  ok   答案已收尾（不是截断）
  ok   耗时为正数
...
全部通过
```

> ⚠️ 必须在**完全权限**或普通终端里跑。原因见第 6 节：沙盒里的 Chromium 会崩。

插件装配另有一个不需要浏览器的测试（21 项检查，普通权限就能跑，CI 里跑的就是它）：

```powershell
node test/plugin.test.mjs
```

## 4. 首次登录（只做一次）

```powershell
node src/cli.mjs "1+1=?" --headed
```

第一次会弹出 Edge，停在登录页（`https://chat.deepseek.com/sign_in`）。**手动登录一次**
（手机验证码 / 密码 / 微信扫码都行），登录态就写进专用 profile：

```
%LOCALAPPDATA%\dsh-web-deepseek\profile
```

之后所有调用都复用这个窗口和登录态，不再需要登录。未登录时命令会报：

```
[web-deepseek] SignedOutError: 网页端未登录（https://chat.deepseek.com/sign_in）...
```

—— 这正是“请你登录”的信号，不是故障。登录完再执行一次同样的命令即可。

## 5. 装进 DSH

把下面这段追加到你的 profile 配置 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `insert`
列表里（`name` 改成你本机插件的**绝对路径**），完整示例见
[examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml)：

```yaml
    - id: tool-deepseek-web
      name: "/absolute/path/to/DSH-UseWebDeepseek-WhenEasyWork/src/plugin.js"
      config:
        toolName: ask_deepseek_web
        port: 9555
        headless: false
        timeoutMs: 90000
        promptBias: true
```

接着**重启 DSH**（插件在 HOST 启动时加载）。重启后：

1. 任意会话里问一句轻问题（比如「1+1 等于几」），模型应当直接调用 `ask_deepseek_web`；
2. 第一次会弹出 Edge 停在登录页 —— 登录一次，留在后台，之后不再问；
3. 想确认插件真的加载了，跑（不用猜日志在哪，它自己找最近的会话日志）：

```powershell
node tools/inspect-session.mjs
```

实测输出：

```
工具清单共 33 个，ask_deepseek_web ✅ 在里面
提示偏置（“先调用 ask_deepseek_web 交给网页端…”）出现 19 次 ✅ 已注入

结论：插件已加载，工具对模型可见。
```

> 不想让它自动参与？把 `promptBias` 改成 `false`：工具还在，但模型不再被提示“轻问题优先用它”。

### 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `toolName` | `ask_deepseek_web` | 注册给模型的工具名 |
| `port` | `9555` | 浏览器调试端口；换一个就换一套浏览器实例 |
| `userDataDir` | `%LOCALAPPDATA%\dsh-web-deepseek\profile` | 登录态目录；可指向你已有的 Edge profile |
| `headless` | `false` | 无头模式；**首次登录必须 false** |
| `timeoutMs` | `90000` | 等答案的总超时 |
| `promptBias` | `true` | 是否注册系统提示“轻问题默认先调它”；关掉则只保留工具 |

## 6. 为什么必须在 HOST 进程里跑（实测）

DSH 的会话沙盒对 Chromium 不友好：在 `workspace-write` 沙盒里启动 Edge，进程约 **7 秒后以
`0x80000003`（STATUS_BREAKPOINT）退出**，调试端口从未打开过。同一份代码换成完全权限就正常：

```
+    7ms spawned, pid = 12160
+ 1037ms t+2s version: down (ECONNREFUSED)
...
+ 6764ms EXIT 2147483651 null
```

所以：

- **插件**跑在 DSH HOST 里（宿主进程不受会话沙盒限制）→ 正常工作，这也是主路径。
- **命令行**请在普通终端 / 完全权限下用。如果你让 agent 在沙盒里跑 CLI，就会看到浏览器秒退。
- 顺带一提：沙盒里 `spawn` 带 `stdio: 'pipe'` 会直接 `EPERM`（管道被禁），所以启动浏览器时
  统一用 `stdio: 'ignore'`，不抓它的输出。

## 7. 排错

| 现象 | 原因与处理 |
|---|---|
| `SignedOutError` | 没登录。`--headed` 跑一次并在窗口里登录 |
| `ComposerNotFoundError` | 页面没加载完 / 改版 / 未登录。先 `node tools/probe.mjs --headed` 看 DOM，再按输出改 `src/ask.mjs` 里的 `COMPOSER_SELECTORS` |
| `AnswerTimeoutError` | 网页端慢或答案超长。调大 `timeoutMs`；错误对象带 `partial` 部分文本 |
| 浏览器启动后立刻退出 | profile 被别的窗口占用；或你在沙盒里跑（见第 6 节）。换 `--port` / 关掉占用的窗口 |
| 端口 9555 被占 | `netstat -ano \| findstr 9555` 找到 PID，或直接用 `--port 9560` |
| 答案里混进上一次的内容 | 正常情况下每次都会回根路径开新会话；若复用了旧标签页，删掉 `%LOCALAPPDATA%\dsh-web-deepseek\profile` 重来 |

## 8. 边界与注意事项

- **合规**：这是自动化操作你自己的账号。DeepSeek 的服务条款可能不欢迎自动化访问；请自控频率
  （连续大量提问可能触发风控或验证码），别拿它当批量接口用。
- **稳定性**：依赖网页 DOM（`.ds-markdown`、`停止生成` 等）。网页改版就会失效——`src/ask.mjs`
  顶部的选择器列表是唯一需要动的地方，`tools/probe.mjs` 是看新结构的工具。
- **并发**：同一个页面只能串行问答，插件里用队列串行化，并把工具标成
  `isConcurrencySafe: () => false`。
- **隐私**：问题原文会发给网页端（和你在浏览器里打字一样），不要往里塞不该外发的资料。
- **能力**：它答的是“网页端 DeepSeek”，不是你当前会话的模型上下文。别指望它知道你在本机
  改了什么文件；需要工作区信息的任务应该直接用本会话的工具。

## 9. 已验证 / 未验证

已验证：

- CDP 链路、浏览器启动与复用、真实输入与回车发送、流式结束判定、超时与部分文本、页面复用。
  由离线 fixture 的 3 个用例覆盖（全绿）。
- 插件装配：工具定义、schema 形状、`render` 输出、串行声明、提示偏置、以及“配置写错只告警
  不抛异常”的兜底，由 `test/plugin.test.mjs` 的 21 项检查覆盖（全绿）。
- `chat.deepseek.com` 未登录时确实 302 到 `/sign_in`，页面按钮用 `ds-button` 设计系统类名，
  所以 `SNAPSHOT` 里的登录判断和 `.ds-markdown` 选择器是对着真实页面写的。

未验证（需要你自己的账号）：

- 登录后真实对话的完整链路（输入框形态、`深度思考`/`联网搜索` 开关的可点击性、答案提取）。
  这几处都做了保守兜底（多选择器 + 开关操作失败不致命），但**首次真实使用时请盯着看一眼**；
  若某一步不对，跑 `node tools/probe.mjs --headed` 把快照发过来，按真实类名改即可。

## License

[MIT](LICENSE)
