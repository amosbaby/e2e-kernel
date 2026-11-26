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

`scripts/m0/route-coverage.ts` 用和内核一样的方式起有头 Chromium（持久化 context，`serviceWorkers: 'block'`），在 `context.route('**/*')` 里把发往 `/api/sink`、`/api/form-blank` 的请求记下来后以 403 拦掉，再看本地 fixture 服务有没有收到；跨进程 iframe 用 CDP 的 `Target.getTargets` 确认（跨源 iframe 是 `type: 'iframe'` 的独立 target 才算）。`scripts/m0/focus-probe.ts` 用 `osascript` 看有头启动前后的前台应用；`scripts/m0/window-close.ts` 和 `scripts/m0/manual-login.ts` 留给人工实测。

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

crossProcessConfirmed: true
serviceWorker: register=resolved registration=none
```

同一天连跑两次，输出一致。

## 4. 结论

`crossProcessConfirmed = true`，13 行全是 `seenByRoute = true` 且 `reachedServer = false`。

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

4 次里有 2 次 `changed: true`：有头启动拿走了前台。这 2 次前台都是运行脚本的那个应用；另外 2 次前台是别的应用，没有变。测的时候机器上有人在用，前台应用不是由脚本控制的。「窗口弹出时键盘焦点有没有被拿走」：待用户回答。

## 8. 人关窗口后

待用户实测。

## 9. 人工登录

由用户在自己的环境上实测，结果不进仓库。

## 10. 复测

运行 `npm run m0`。Playwright 升级后必须重跑并更新本文件。
