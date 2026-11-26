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

用户自己跑的 `node scripts/m0/focus-probe.ts` 是权威结果，它取代上面这几次不受控的运行。原样输出（`<应用 A>` 是用户自己的桌面应用，名字按上文约定替换）：

```text
front-app-before: <应用 A>
front-app-after: Google Chrome for Testing
changed: true
```

决定：有头启动会抢一次焦点，与设计「窗口不抢焦点」冲突；按用户决定，M1 接受这一点（内核不主动把窗口提到前台），规避办法和『实例运行中再开页是否也抢焦点』留到 M2。

## 8. 人关窗口后

用户自己跑的 `node scripts/m0/window-close.ts`，原样输出：

```text
请在 20 秒内手动关闭这个浏览器窗口
page-close: fired
context-close: not-fired
```

手动关窗口只触发 page 的 close，浏览器 context 仍然活着。内核走「页面消失」这条路径处理它（Task 15）。

## 9. 人工登录

由用户在自己的环境上实测，结果不进仓库。

## 10. 复测

运行 `npm run m0`。Playwright 升级后必须重跑并更新本文件。
