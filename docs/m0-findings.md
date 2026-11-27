# M0 实测记录

设计第 3 节有两项【未证实】：`route()` 是否覆盖跨进程 iframe 里的请求；`route()` 是否拦得住原生表单提交。本文件记录 M0 的实测结果，设计 5.3 的写策略按这里的结论定（见 [docs/design.md](design.md)）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| macOS | 27.2.1 |
| Node | v24.22.1 |
| Playwright | 1.65.1（`package.json` 钉的版本） |
| Chromium | 159.0.0.0（Playwright 自带，取自 `navigator.userAgent`；UA 只给主版本号，后三段是 0） |
| 日期 | 2026-11-26 |

## 2. 方法

`scripts/m0/route-coverage.ts` 用和内核一样的方式起有头 Chromium（持久化 context，`serviceWorkers: 'block'`），在 `context.route('**/*')` 里把发往 `/api/sink`、`/api/form-blank` 的请求记下来后以 403 拦掉，再看本地 fixture 服务有没有收到；另有 1 行正向对照（一个路由放行的写请求，见 §3、§4）；跨进程 iframe 用 CDP 的 `Target.getTargets` 确认（跨源 iframe 是 `type: 'iframe'` 的独立 target 才算）。`scripts/m0/focus-probe.ts` 用 `osascript` 看有头启动前后的前台应用；`scripts/m0/window-close.ts` 和 `scripts/m0/manual-login.ts` 留给人工实测。

## 3. 拦截覆盖

`npm run m0` 原样输出：

```text
playwright 1.65.1, chromium 159.0.0.0

| case | seenByRoute | reachedServer | isNavigation | frameAvailable |
| --- | --- | --- | --- | --- |
| top-fetch | true | false | false | true |
| top-xhr | true | false | false | true |
| top-beacon | true | false | false | true |
| top-form | true | false | true | true |
| same-fetch | true | false | false | true |
| same-xhr | true | false | false | true |
| same-beacon | true | false | false | true |
| same-form | true | false | true | true |
| cross-fetch | true | false | false | true |
| cross-xhr | true | false | false | true |
| cross-beacon | true | false | false | true |
| cross-form | true | false | true | true |
| blank-form | true | false | true | false |

positive control (not a scenario: the route handler continues this request, so it must reach the server)
| case | seenByRoute | reachedServer | isNavigation | frameAvailable |
| --- | --- | --- | --- | --- |
| control-continued-fetch | true | true | false | true |

crossProcessConfirmed: true
serviceWorker: register=resolved registration=none
```

正向对照行加入前，同一天连跑过两次，13 行输出一致；加入后又跑了一次，13 行不变。

## 4. 结论

`crossProcessConfirmed = true`，13 行全是 `seenByRoute = true` 且 `reachedServer = false`。

**正向对照**：只看 13 行 `false`，分辨不出「写请求真的被拦住了」和「`reachedServer` 的匹配写错了、永远给 `false`」。所以加了 1 行对照，它不算场景：同一个持久化 context、同样的 `context.route('**/*')`，但路由处理函数对这条请求 `continue`（不拦），请求是顶层页面发的一次 `POST /api/sink?case=control-continued-fetch`。这一行应当 `reachedServer = true`，实测：

```text
| control-continued-fetch | true | true | false | true |
```

对照行 `reachedServer = true`，说明服务端侧的检测能看到放行的写请求；13 行的 `false` 因此才是「被拦住了」，不是检测失灵。下面「一层」的结论只在对照行为 `true` 时成立；若重测时对照行变成 `false`，13 行的结果作废，不能据此下结论。

**一层**：设计 5.3 的写策略只用网络层。

```ts
crossProcessIframes: 'covered'
nativeFormSubmit: 'covered'
```

## 5. 归属

`frameAvailable = false` 的只有 `blank-form`（`target="_blank"` 的表单提交，请求发生在新标签页的 frame 建好之前）。这类请求在内核里归不到页面，会进「未归属的写」。其余 12 行都能拿到 frame。

## 6. Service Worker

- `register`：`resolved`
- `registration`：`none`

`registration` 是 `none`，`serviceWorkers: 'block'` 生效。注意 `register()` 本身是 resolve 的，不是 reject。

## 7. 有头启动抢不抢焦点

`node scripts/m0/focus-probe.ts` 同一天跑了 4 次。下面是原样输出，只把本机用户自己的应用名换成了 `<应用 A>`、`<应用 B>`、`<应用 C>`（`<应用 A>` 是运行脚本的那个应用；`Google Chrome for Testing` 是 Playwright 自带的 Chromium，保留原名）：

```text
front-app-before: <应用 A>
front-app-after: Google Chrome for Testing
changed: true
```

```text
front-app-before: <应用 B>
front-app-after: <应用 B>
changed: false
```

```text
front-app-before: <应用 A>
front-app-after: Google Chrome for Testing
changed: true
```

```text
front-app-before: <应用 C>
front-app-after: <应用 C>
changed: false
```

4 次里有 2 次 `changed: true`：有头启动拿走了前台。这 2 次前台都是运行脚本的那个应用；另外 2 次前台是别的应用，没有变。这几次测的时候机器上有人在用，前台应用不是由脚本控制的，只能作参考。

作者自己跑的 `node scripts/m0/focus-probe.ts` 是权威结果，它取代上面这几次不受控的运行。原样输出（`<应用 A>` 是作者自己的桌面应用，名字按上文约定替换）：

```text
front-app-before: <应用 A>
front-app-after: Google Chrome for Testing
changed: true
```

结论：有头启动会抢一次焦点，与设计「窗口不抢焦点」冲突；M1 接受这一点（内核不主动把窗口提到前台），规避办法和『实例运行中再开页是否也抢焦点』留到 M2。

### 7.1 把焦点还回去（M2，2026-11-27）

`scripts/m0/focus-restore-probe.ts`：启动前记下前台应用的 bundle id，启动后用 `osascript` 的 `tell application id … to activate` 还回去（bundle id 走 argv，不拼进脚本）；再在同一个实例里开一个新页，看是否又抢；再还一次。作者在场、没碰键盘鼠标时由 agent 起的一次，原样输出（`Claude` 是起脚本的桌面应用）：

```text
front-app-before: Claude
after-launch: Google Chrome for Testing
restore-1-ok: true
after-restore-1: Claude
after-new-page: Google Chrome for Testing
restore-2-ok: true
after-restore-2: Claude
```

同一天再跑一次 `--lsappinfo`（用 `lsappinfo front` 和 `lsappinfo info -only bundleID` 读前台，用 `open -b <bundle id>` 还回去，不经 System Events、不需要「自动化」授权）。原样输出，`<应用 A>` 是起脚本的桌面应用的 bundle id：

```text
front-app-before: <应用 A>
after-launch: com.google.chrome.for.testing
restore-1-ok: true
after-restore-1: <应用 A>
after-new-page: com.google.chrome.for.testing
restore-2-ok: true
after-restore-2: <应用 A>
```

结论：启动和在运行中的实例里开新页都会抢焦点；事后按 bundle id 激活原前台应用能还回去。抢和还之间有一小段窗口（这里约 2 秒，实际可以更短），这段时间里用户的按键会落到浏览器上，所以只能缩短、不能消除。

### 7.3 开会话不抢前台（M2b 任务 16，2026-11-27）

7.1 的结论是启动和开页都抢前台，只能事后还。这一节找不抢的启动和开页方式。环境同 §1（Playwright 1.65.1 自带的 Chrome for Testing，Chromium 159）。判法：动作期间及之后 2.5 秒，每 100 毫秒用 `lsappinfo front` 取前台应用的 bundle id 和 pid；**本探针起的那个浏览器进程的 pid 出现在前台才算「抢」**，机器上别的会话的浏览器只当旁注（同一时间还有别的会话在跑浏览器，前台常被它们占着）。每格都是全新的实例和全新的 profile 目录；抢了就 `open -b` 还回去再进下一格。探针脚本不在仓库里，数据照实记在这里。

**12b：`open -g` 启动，第一个页怎么开（整套跑 3 次，后两次最干净）**

| 启动方式 | 第一个页 | 启动抢不抢 | 开页抢不抢 | 之后 click / fill / screenshot |
| --- | --- | --- | --- | --- |
| `open -g -n … --no-startup-window --remote-debugging-port` | browser 级 `Target.createTarget({url, background:true})` | 不抢 | **不抢** | 成功，不抢 |
| 同上 | `context.newPage()` + `goto` | 不抢 | **抢** | 成功，不抢 |
| `open -g -j -n …`（启动后隐藏） | `createTarget` background | 不抢 | **不抢**，实例仍隐藏 | 成功，不抢，仍隐藏 |
| 同上 | `newPage()` + `goto` | 不抢 | **抢**，隐藏的实例变成可见 | 成功，不抢 |
| 隐藏实例里页面自己 `window.open(…, 'popup,…')` | | | **抢**，实例变成可见 | |

- 7.1 里「`-g` 也抢」是因为带了 `about:blank` 启动页（见下），不是 `-g` 无效：`--no-startup-window` 启动本身不抢。`-j`（隐藏）不需要。
- `createTarget` 在一个没有任何窗口的实例里直接成功，不需要 `newWindow: true`。`context.newPage()` 每次都抢，隐藏的实例也一样。
- 页面自己弹出的窗口（`window.open`、`target=_blank`）仍然抢，所以 7.1 的「抢了再还」继续留着。
- 这轮的 click / fill / screenshot 在新开的页上都成功，读回正确，各 10 到 130 毫秒；上一轮在有窗口的实例里开后台标签页时 fill 超时、截图 8.6 秒，是另一种情形，没有做对照。

**Step 0：不开调试端口的管道方案**（上面的 12b 用的是 TCP 调试端口：127.0.0.1 上的调试端口没有认证，本机任何进程都能连上并完全控制这个带登录态的浏览器；内核现在走管道，没有这个口子。所以先看管道能不能也不抢）。整套跑了 3 次（第 1 次 A、B、C，第 2、3 次只重跑 D），逐行判据同上：

| 格 | 做法 | 结果 |
| --- | --- | --- |
| A | `chromium.launchPersistentContext(dir, { headless: false, args: ['--no-startup-window'] })` | **启动一直不返回**（我们的 60 秒上限先到；Playwright 对持久化 context 追加 `about:blank` 启动参数，再加 `--no-startup-window` 就没有窗口可等，这是推断，没有进一步查）。没法用 |
| B | node 直接 `spawn` 浏览器可执行文件 `--remote-debugging-pipe --no-startup-window --user-data-dir=…`，自己在管道上说 CDP，`Target.createTarget({background:true})` | 启动不抢，开页不抢 |
| C | 同 B 但 `--remote-debugging-port=0`，`DevToolsActivePort` 读端口，`connectOverCDP` | 启动、连接、开页、click / fill / screenshot 都不抢（TCP 对照，没有采用） |
| D | 同 B，但用 Playwright **公开**的 `chromium.connectOverCDP(transport)` 重载（`types.d.ts` 里的 `ConnectOverCDPTransport`：`send`、`close`、`onmessage`、`onclose`）把管道交给 Playwright | 第 2、3 次各跑一次（共两次；第 1 次跑的是 B，同一做法、自写管道 CDP，没有 click 等步骤），启动、连接、开页、click / fill / route / screenshot / goto 全部不抢；`browser.close()` 之后子进程退出码 0 |

```text
D 启动（spawn，管道）          耗时 5ms     结论: 不抢
D connectOverCDP(transport)   耗时 51ms    结论: 不抢     contexts=1 初始页数=0
D 开页 createTarget(background) 耗时 667ms  结论: 不抢
D click/fill/screenshot/route  耗时 336ms   结论: 不抢     click→clicked | fill→hello-pipe | screenshot bytes=26543 | goto ok
D browser.close()              耗时 10ms    结论: 不抢     子进程 exitCode=0 signal=null
```

结论：**直接 `spawn` + `--remote-debugging-pipe` + `--no-startup-window`，经 `connectOverCDP(transport)` 接给 Playwright，再用 `Target.createTarget({ url: 'about:blank', background: true })` 开页**，启动和开页都不抢前台，也不开任何 TCP 端口。内核采用这个方案（`src/drivers/playwright/browser-process.ts`）；调试端口那条路没有用上。

没变的：页面自己弹出的窗口仍抢；没测的：`createTarget` 开出的窗口在没有 `-j` 时显示在别的窗口后面还是前面（没有直接观察窗口）。

### 7.4 弹窗抢前台比 step 返回晚（M2b 任务 12 的真机验收，2026-11-27）

任务 12 在 step 末尾同步还一次前台，真机验收没还回来：`step '[{"op":"click","target":"#open-popup"}]'` 返回之后每 100 毫秒采样前台，先是原应用，随后变成 `com.google.chrome.for.testing`，1 秒后仍是它。两个原因都会让旧做法落空，修法同时覆盖：(a) 弹窗的 `onPageOpened` 事件比 step 返回晚，step 末尾 `pagesOpened` 还没变，根本没调 restore；(b) restore 调了，但那一刻前台还不是 Chromium（抢得比还晚），`restore` 只在前台是 Chromium 时才 `open -b`，什么也没做。采样里「step 返回时前台还是原应用」说明 (b) 一定成立，(a) 没法从采样里分开，两者各有一条单元测试单独复现（见 `test/kernel/sessions.test.ts` 里 `focus: a popup whose event arrives after the step returned …` 和 `focus: a grab that comes after the step ended …`，修之前都失败）。修法见 design 的「把焦点还回去」一条：step 结束后在后台每 100 毫秒一轮，最多 2 秒，前台真的变成 Chromium 才还。

真机：修前弹窗抢前台不还；ec87bad 还一次后被二次抢走（弹窗把浏览器激活了两次，Claude → CfT → 还回 Claude → CfT 又被抢 → 最终 CfT）；20b1084：2 秒内每次被抢都还，真机连跑两次，前台 `<应用 A>`（起脚本的桌面应用）→ Google Chrome for Testing → `<应用 A>`，最终回到 `<应用 A>`。

## 8. 人关窗口后

作者自己跑的 `node scripts/m0/window-close.ts`，原样输出：

```text
请在 20 秒内手动关闭这个浏览器窗口
page-close: fired
context-close: not-fired
```

手动关窗口只触发 page 的 close，浏览器 context 仍然活着。内核走「页面消失」这条路径处理它：会话结束并出报告，标 `page-gone`。

## 9. 人工登录

由作者在自己的环境上实测，结果不进仓库。

## 9.5 重定向的后续跳不经路由 handler

Playwright 文档写明，路由 handler 只对重定向链的第一个 URL 调用（`playwright-core/types/types.d.ts` 里 `route` 的说明）。实测（`test/browser/playwright-driver.test.ts`「a redirect target is not shown to the handler」）：页面 `fetch` POST 一个返回 307 的地址，307 的目标是写端点；驱动的 `seen` 里只有第一跳，fixture 服务收到了后续跳的写请求。

结论：重定向的后续跳不经 handler，因此也不经写策略，也不进记录。这是现状，本轮只加测试记录、不改行为；README Known gaps 里有同一条。后续要堵，需在网络层处理，例如 handler 里 `route.fetch({ maxRedirects: 0 })` 拿首跳响应、遇 3xx 不跟随再 `fulfill`（M2 再定）。

M2a 的实测（Playwright 1.65.1，`test/browser/playwright-driver.test.ts` 里 `followRedirects: false` 的几条）：驱动对放行且带 `followRedirects: false` 的请求走 `route.fetch({ maxRedirects: 0 })`。
- `maxRedirects: 0` **不抛错**，返回 3xx 响应本身（307 带 `location`）。驱动据此先通知 `redirectRefused`、再 `route.abort()`；服务端只收到首跳一次，目标地址一次也没收到，页面的 `fetch` 被拒。1.65.1 下 `maxRedirects: 0` 不会抛错（内部映射成 -1），所以驱动不按错误消息里的 `redirect` 字样判断：消息的 Call log 带完整 URL 和 referer，`redirect_uri=` 之类会被误报。`fetch` 抛任何错都只是中止请求，由随后的 `requestfailed` 通知一次（status 为 null，没有 `redirectRefused`）。
- Cookie：`route.fetch` 带上浏览器的 cookie（先访问设 cookie 的页面，服务端在这个写请求里看到了它），响应的 `Set-Cookie` 经 `route.fulfill({ response })` 回到浏览器（页面 `document.cookie` 随后含新值）。
- gzip：服务端回 `content-encoding: gzip`，`fulfill({ response })` 原样转发正文和头，页面读到的正文正确解码。
- 非 3xx（例如 200）原样交给页面，状态和正文不变。

- 跨源不能走这条路：`route.fetch` 按 URL 附上 context 里所有匹配的 cookie（不看 SameSite，也不看页面 `fetch` 的 credentials 模式），`fulfill({ response })` 在请求带 `Origin`、跨源且响应没有 `access-control-allow-origin` 时还会自动补 `access-control-allow-origin: <origin>` 和 `access-control-allow-credentials: true`。实测（页面在 `127.0.0.1`，目标在 `localhost`，目标主机上有 SameSite=Strict 的 cookie）：经 `route.fetch` 发出的请求带着这个 cookie，浏览器自己发的不带。所以驱动只对同源请求用 `route.fetch`，跨源的 `route.continue()`。
- `route.fetch` 的响应要 `dispose()`，否则响应体留在 context 里直到关闭；驱动在 `fulfill` 或中止之后都会 dispose。

结论：四条在 1.65.1 下都做得到，不需要降级。代价：这样发出的请求由 Node 代发，不信任系统额外安装的根证书（README Known gaps）。

## 9.6 写请求时探测密码框

内核要知道「发出写请求的页面有没有密码框」，好决定记不记请求体。驱动在路由回调里对发出请求的 frame 和它所在页面的顶层文档各做一次 `locator(...).count()`（跑在 Playwright 的隔离环境里，页面改写不了 `querySelector`，CSS 选择器穿透 open shadow root；只数有没有 `input[type=password]` 或 `autocomplete` 含 `current-password` / `new-password` / `one-time-code` 的元素），与 300 ms 定时器竞速；超时、抛错、或探测前后 frame 或顶层的地址变了，都给 `null`，内核按失败关闭不记体。

实测（`test/browser/playwright-driver.test.ts`）：
- 页面用同步 XHR 发写请求时，页面线程被占着，探测跑不起来：约 312 ms 后超时为 `null`，请求照常交给内核、到达服务，不被探测卡住。
- 顶层 frame 的导航请求（原生表单提交）在路由回调里对它做探测会挂住：Playwright 等导航结束，导航又在等这个回调，回调之后才报「Execution context was destroyed」。iframe 里的导航请求实测不挂（4–6 ms 返回），但为简单起见，有请求体的导航请求一律不探测、给 `null`。后果：原生表单提交的请求体一律不记。
- 页面发写请求后马上 `location.href` 跳走：路由回调里先看到的是跳转的导航请求，探测的 locator 可能已经落在新文档上，而 `frame.url()` 还是旧地址，只比地址会判成确切的 `false`（实测每次都是）。所以驱动登记「已发起、未提交」的导航（`framenavigated`、请求失败或结束时撤销，10 秒过期），探测开始前或结束后它为真、或地址变了，都给 `null`。
- 子 frame 里发的写，顶层文档有密码框：判为有；`fetch` 在没有密码框的页面上判为没有。

## 9.7 动作失败的诊断

动作失败时驱动要带回两种诊断：选择器匹配了多个元素，和点击被别的元素挡住。依据是 Playwright 的错误消息，实测（`test/browser/playwright-driver.test.ts`「a selector that matches several elements」「a click covered by another element」，Playwright 1.65）：
- 调用记录在 `error.message` 里，第一行之后：`Call log:` 下面逐行 `  - …`。被遮挡时每次重试都有一行 `- <div id="veil" …></div> intercepts pointer events`，超时后消息里有好几行相同的；取最后一行、去掉 `- ` 前缀。元素预览（`previewNode`）把属性按长度升序拼起来（`style` 不输出），**整段属性文字超过 500 字符就截断并补一个 `…`**（最后一个属性只剩半截，`…` 紧挨在 `>` 或 `/>` 前），**文字内容另截到 50 个字符并补 `…`**（文字只剩半截）。500 以内属性值是完整的，所以遮挡行里的长 token 会完整出现（内核先脱敏再截断才认得出）；而落在任一截断点上的 token 只剩半截，脱敏认不出来。页面还能在属性值里伪造 `…` 和 `>`，所以不能靠找「真正的截断点」来处理。驱动的规则（`dropTruncatedRuns`）：对行里每一个 `…`，删掉紧挨在它前面、连续的「非空白且不是 `"` `'` `=` `>`」的字符；单遍线性扫描、不用正则；文字里本来就有 `…` 时会多删一点，可以接受。
- 严格模式冲突的第一行是 `locator.click: Error: strict mode violation: locator('.dup') resolved to 2 elements:`，后面是 `1) <button …> aka getByRole(…)` 这样的候选预览。这是给人看的行文，驱动不解析它：只看消息第一行里有没有 `strict mode violation` 来判断类型（调用记录里可能带页面文字，不看），再自己用 `locator.count()` 和 `evaluateAll` 取前 5 个候选（标签、角色、名字、位置大小，不取元素的值）。
- 两种诊断都是页面文字：遮挡元素的属性、候选的名字。驱动只做每条 4000 字符的保护性截断，不脱敏也不截短；内核先脱敏、再截到 300，否则一个跨在截断点上的 token 会留下认不出来的半截。

## 9.8 按页的触屏模拟（`open --touch`）

问题：持久 context 只有一个，Playwright 的 `hasTouch` 是 `newContext` 的选项，没法按页设。

出处：
- CDP `Emulation.setTouchEmulationEnabled`（chromedevtools.github.io/devtools-protocol/tot/Emulation）。
- Playwright 文档里的 `browserContext.newCDPSession(page)`（只支持 Chromium）和 `hasTouch`（context 选项）。
- `playwright-core/lib/coreBundle.js`（本机 1.65.1，`takeScreenshot`，第 39206 行起）：Playwright 只在 `!fitsViewport && hasTouch` 时，在 `Page.captureScreenshot` 之后重发 `Emulation.setTouchEmulationEnabled({ enabled: true })`，说明超出视口的截图（`captureBeyondViewport`）可能把触屏模拟重置。
- 官方文档没有说 `setTouchEmulationEnabled` 会让 `(pointer: coarse)` 成立，所以先实测再实现。

实测：脚本 `scripts/m0/touch-probe.ts`（有头 Chromium，每页都 `context.newCDPSession(page)`，输出逐行对应下面各条）；`test/browser/playwright-driver.test.ts` 里以 `touch:` 开头的几条测试固化了结论。

- 方法一：`Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 })`。成立：`(pointer: coarse)`、`(any-pointer: coarse)`、`(hover: none)` 都为真，`navigator.maxTouchPoints` 为 5。空白页上发完就生效；goto 之后 `ontouchstart` 也在了。
- 退路 A：只发 `Emulation.setEmulatedMedia({ features: [pointer、any-pointer = coarse，hover、any-hover = none] })`：不成立（`matchMedia` 全是 false，`maxTouchPoints` 为 0）。和方法一一起发时成立，但方法一单独就够，所以不用。
- 按页隔离：同一个 context 里不带 touch 的页仍是 `false`。
- 之后仍然成立：`setViewportSize` 之后、整页截图之后（测试用 5000 像素高的页面，确实超出视口）、元素截图之后、跨站 goto（`origin` 到 `altOrigin`）之后。也就是实测截图没有重置模拟；为防 Playwright 或 Chromium 版本变化，驱动在任何截图之后仍尽力重发一次，重发失败不影响这次截图的结果（图已写好）。
- 生命周期：CDP 会话一 `detach`，模拟立刻失效（`pointer: coarse` 变回 false，下一次跨站导航后 `ontouchstart` 也没了）。所以会话要开到页关为止，页关时才 detach；驱动在页的关闭处理里 detach，测试用计数包装确认正好一次，不泄漏。
- 失败关闭：驱动发完命令后在空白页上实测 `matchMedia('(pointer: coarse)').matches`，不是 true 就关掉这一页（并 detach 会话）、报 `touch emulation is not available`，`open` 以 11 退出，不建会话；`newCDPSession` 抛错同样。两条失败路径都有桩住 `context.newCDPSession` 的测试。
- 不覆盖（已实测：不继承）：touch 页用 `window.open` 开出的弹窗，`pointer: coarse` 为 false、`maxTouchPoints` 为 0；touch 页里的跨站 iframe 同样为 false、0；同站 iframe 为 true、5（跟着主页走）。另外 `click` 仍发鼠标事件、UA 不变、`isMobile` 不模拟。

## 9.9 Web Worker 与 SharedWorker 发出的写

问题：持久 context 上的 `context.route('**/*')` 能不能看到、拦住 Dedicated Worker 和 SharedWorker 里 `fetch` 发出的写。

方法：`scripts/m0/worker-probe.ts`（`npm run m0` 会接着 route-coverage 跑它）。有头持久化 context，`serviceWorkers: 'block'`；路由里遇到 `/api/sink` 就记下来再 `abort`，本地服务记哪些请求真的到了。页面自己 `fetch` POST 当对照，再各起一个 Dedicated Worker 和 SharedWorker，在里面 `fetch` POST。Playwright 1.65.1，同样的结果跑了 3 次。

| 场景 | route 看到 | 服务端收到 |
| --- | --- | --- |
| 页面自己 `fetch` POST（对照） | 看到（`frame()` 可用，`resourceType=fetch`） | 没收到（被拦） |
| Dedicated Worker 里 `fetch` POST | 看到（`frame()` 可用） | 没收到（被拦） |
| **SharedWorker 里 `fetch` POST** | **看不到** | **收到了** |
| SharedWorker 的脚本 `/sw.js` 本身 | 看到，`resourceType=script`，和普通脚本分不出来 | — |

- 路由阶段 `allHeaders()` 里拿不到 `sec-fetch-dest`，所以没法据此单独拦下 SharedWorker 的脚本。
- 能堵的办法（已实测）：`addInitScript(() => { delete globalThis.SharedWorker })`。页面里 `new SharedWorker()` 抛错，服务端一条也没收到，路由也看不到 `/sw.js`。
- 探针按上面的结论断言，结果不一致时退出码为 1：Playwright 或 Chromium 升级后行为变了，就要重做本节。

结论：默认模式下 SharedWorker 的写不经路由，也不进记录，这是 M1 已有的缺口（README Known gaps 里有同一条）。Dedicated Worker 已覆盖，归属也能拿到。**M2a 起驱动在所有页面删掉 `SharedWorker`**（`attach` 里在 `context.route` 之前装的 init script `delete globalThis.SharedWorker`），让只读上下文里没有这条旁路。驱动测试（`test/browser/playwright-driver.test.ts`）在带驱动路由的真实 Chromium 里实测了五处，`typeof SharedWorker` 都是 `'undefined'`：顶层页面（`new SharedWorker()` 抛错，等 1 秒服务端也没收到 SharedWorker 的 POST）、带 `src` 的同源 iframe、脚本同步建出的 `about:blank` iframe、`window.open('')` 同步返回的窗口、Dedicated Worker（本来就没有，钉住）。所以 `Capabilities` 记 `sharedWorkers: 'covered'`；驱动若做不到这一点，应记 `'not-covered'`，报告的覆盖说明会据此提示。

## 9.10 原生对话框

问题：内核将来要用原生对话框做批准，从 Node 子进程能不能弹出来，`giving up after` 的超时能不能回传。

方法：`scripts/m0/dialog-probe.ts`，只手动跑，不接进 `npm run m0`。它用 `child_process.execFile('osascript', …)` 执行 `display dialog … buttons {"拒绝","允许"} default button "拒绝" giving up after 8`，打印返回串和耗时。本机 macOS，Node v24.22.1，2026-11-27。

| 起法 | 结果 |
| --- | --- |
| agent 的 Bash 工具直接起 Node | 弹出；8 s 后超时关闭，`out = "button returned:, gave up:true"`，约 8.4 s，没有错误 |
| agent 在终端面板（PTY，用户的登录 shell）里起 Node | 一样：`gave up:true`，约 8.4 s，没有错误 |
| 人在自己的终端里起 | 没单独测。它和 PTY 是同一个用户的 GUI 会话，预期一样 |
| 不能访问 WindowServer 的沙箱 | 没测。预期会失败，所以 `doctor` 要检查这一项，失败时拒绝开需要批准的模式 |

结论：从 Node 子进程调 `osascript` 弹原生对话框可行，超时也能正确回传。

人点按钮（2026-11-27，同一种 `execFile('osascript', …)` 起法，超时放宽到 60 s，作者在场点）：

| 人的操作 | `stdout` | 退出码 |
| --- | --- | --- |
| 点「允许」 | `button returned:允许, gave up:false` | 0 |
| 点「拒绝」 | `button returned:拒绝, gave up:false` | 0 |
| 不点，等超时 | `button returned:, gave up:true` | 0 |

三种情况退出码都是 0，只能靠解析 `stdout` 区分；8 秒对人太短（第一次就没来得及点）。按钮名不叫 Cancel，所以没有 `-128` 那条错误路径。

内核的真实实现（2026-11-27，M2b）：`dialog-probe.ts` 改成调 `src/kernel/approval.ts` 的 `osascriptDialog()`，脚本固定为 `on run argv`，正文、标题、按钮名、秒数全走 argv，超时 60 s。人在场点「允许」：返回 `{"kind":"button","button":"允许"}`，约 8.0 s，进程退出码 0。说明 argv 传参（含 `--` 分隔）和对返回串的精确解析在真机上是通的。

还没测：`choose from list` 多选清单；弹框是否抢焦点（对批准框本来就是想要的）。

## 10. 复测

运行 `npm run m0`（route-coverage 之后接 worker-probe）。Playwright 升级后必须重跑并更新本文件。`node scripts/m0/dialog-probe.ts` 和 `node scripts/m0/focus-restore-probe.ts` 要人在场，不在 `npm run m0` 里，需要时手动跑。
