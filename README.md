# e2e-kernel

A local resident kernel plus an `e2k` CLI that lets an AI agent do e2e verification in a real browser. The kernel owns a headed Chromium (driven through Playwright behind a small driver protocol), keeps sessions alive across CLI calls, records what the agent did and what the page did, and writes a report for a person to read.
It does not call a model, does not type passwords and does not solve CAPTCHAs: a person logs in, the agent verifies.
Status: M1 (kernel, CLI, Playwright driver, `default` mode, `open` / `step` / `close`, `login`, reports), plus fixes from a first real-world retest. Design: [docs/design.md](docs/design.md). License: MIT.

## Requirements and setup

- macOS (the only platform verified), a login session with a graphical display (the browser is always headed).
- Node >= 24.12.
- Install and build:

```sh
npm install
npx playwright install chromium
npm run build
```

Commands below are written as `node bin/e2k.js <command>` and run from the repository root. After `npm link` you can type `e2k <command>` instead; whether to link is your call. `bin/e2k.js` imports `dist/`, so run `npm run build` after changing the source.

## Usage

1. Start the kernel (a person or an agent; it runs in the foreground, run it in the background if needed; Ctrl-C, SIGTERM or SIGHUP stops it and cleans up). The CLI never starts it for you. If you put it in the background with `&` from an interactive terminal, closing the terminal sends SIGHUP and output to the closed terminal is dropped; the kernel still cleans up on SIGHUP, but `nohup` with the output redirected to a file keeps it running after the terminal closes.

```sh
node bin/e2k.js start
```

2. Open a page. This returns a session id and a first snapshot. `--name` groups reports (default `session`), `--viewport 1280x720` is optional, `--touch` emulates a touch screen on this session's page (see Known M1 gaps for what it does not cover), `--json` prints one JSON line.

```sh
node bin/e2k.js open http://localhost:3000/ --name smoke
```

3. Run a batch of operations (a JSON array, at most 50 operations, at most 1,000,000 bytes). For large batches, or operations that contain quotes, use `--stdin`.

```sh
node bin/e2k.js step s-1a2b3c '[{"op":"click","target":"e7"},{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Saved"}]'
echo '[{"op":"snapshot"}]' | node bin/e2k.js step s-1a2b3c --stdin
```

`target` is either a ref from the latest snapshot (such as `e7`) or a selector string. A failed action stops the batch unless `--keep-going` is given (the rest is reported as not run; with the flag every operation runs, and the exit code still follows the tallies); an assertion mismatch is recorded and the batch goes on. Selectors are Playwright selectors, plus `role=<role>[name="..."]` for a role with an exact accessible name (for example `role=textbox[name="New item"]`). In the text output `#n` is the 1-based position of the operation in the batch and `序号` is the session-wide number (it continues across batches, not-run operations take one too) used in the report and by `close --superseded`. On a failed action the output may list candidates (for an ambiguous selector, each as `1) 可写 <target> >> nth=0 · <role> @(x,y wxh) "<name>"`, so the way to pick it survives a long name) or the element that intercepted the pointer, as `hints` in the JSON and indented lines under the failed operation in the text output; the message itself stays one line.

After `open` and after every `step`, the kernel checks whether the top document of the session's main page (not iframes) shows a visible password-like field (`type` is `password`, or `autocomplete` contains `current-password` or `one-time-code`; `new-password` is not counted, so a sign-up page is not taken for a login page). If it does, the command exits 20 and prints a line starting with `等登录`, asking a person to run `login <start url>`. This is a built-in heuristic and a hint only: the session keeps running (it is not paused or closed), the records are unchanged, and a page that is meant to hold a password field (such as a change-password page) can be ignored. If the check itself fails, no wall is reported. The same answer is in the JSON as `blocked: "login"` and `next`.

4. Close the session. This writes the report. `--verdict` is one of `pass`, `fail`, `exists`, `absent`, `undetermined`; `--because` gives the reason; `--findings`, `--not-done` and `--superseded` take a JSON array. Each finding is `{"claim", "basis"}` and may carry its own `"verdict"` (same values as `--verdict`). `--superseded` declares recovered failures, as `[{"failed": 3, "by": 5}]`: the failed or not-run operation with session number 3 was recovered by the later, successful operation 5 (the numbers are the `序号` shown by `step`).

```sh
node bin/e2k.js close s-1a2b3c --verdict pass --because "the item list grew by one"
node bin/e2k.js close s-1a2b3c --verdict pass --superseded '[{"failed":3,"by":5}]' --findings '[{"claim":"the item was added","basis":"operation 5","verdict":"pass"}]'
```

The kernel checks `--superseded` against its own record before it writes anything: `failed` must be a failed or not-run operation (a mismatch can never be superseded), `by` must be a later operation that completed or matched, and the same `failed` cannot appear twice. A pair that does not fit is a usage error (exit 2) and the session stays open, so `close` can be run again. The report takes the operation names and targets of both sides from the record, never from the declaration, and lists the failures in two groups: recovered (`序号 n → 由 序号 m 取代`) and unresolved. A recovered row is marked when the replacement is a read-only operation (`snapshot`, `text`, `screenshot`, `console`, `network`) or a `wait` while the failed operation was an action (`byReadOnly` in `result.json`; a wait counts as read-only here), and when one replacement stands in for several failures. The tallies stay the raw counts.

The kernel only flags one contradiction: a `pass` verdict while the record holds a mismatch, a failed or not-run action that is not superseded, a `--not-done` item, or a finding whose own verdict is `fail`. That is reported as a conflict (in the output and in the report), and `result.json` lists the reasons in `conflicts` (the text output prints them on a line after the conflict notice, the JSON output carries the same `conflicts` array; `mismatch`, `unresolved-failed`, `unresolved-not-run`, `not-done`, `finding-fail`). A report is also written when a session ends without `close`: idle timeout, kernel shutdown, or the browser or page going away.

Other commands:

- `node bin/e2k.js login https://example.com/login` opens the dedicated profile so a person can sign in; must be run in a terminal, where a person presses Enter after signing in. The cookie stays in the profile for later sessions.
- `node bin/e2k.js status` shows version, driver, browser, sessions and the profile (`profile default <state>, last login <time host | none>`). `node bin/e2k.js doctor` checks Node, platform, state directory permissions, socket path length, the profile (read-only: it creates nothing; a profile that was never used with `login` is not a failure, and it fails only when `profiles/` or `profiles/default/` exists but is open to group or others), Chromium (fix: `npx playwright install chromium`), whether the kernel is running, and the kernel version. It exits 22 if any check fails, including "kernel not running"; most failing checks print a fix.
- In the text output the profile line and the doctor check are written in Chinese; the enum values (`missing`, `never-launched`, `launched`) appear only in `--json`. The profile state only says whether the browser has used the directory. To tell whether a profile holds a login, look at `lastLogin` (JSON) or the "last login" part of the line: it is written only when a person finishes `login` by pressing Enter. A login done by hand in a session window is not recorded, so "none" does not prove the profile is signed out. `lastLogin` keeps only the time and the host name of the start URL (no path, query or cookie), and the host is redacted like other output.
- `--json` (on commands that support it) prints exactly one line on stdout: the result, or `{ "error": ... }`.

## Operations

| op | fields | what it does |
|---|---|---|
| `snapshot` | `depth?` (1-50) | accessibility snapshot with refs (cut at 20000 characters) |
| `text` | `target?`, `max?` (1-20000, default 4000) | visible text of the page or an element |
| `screenshot` | `fullPage?`, `label?`, `target?`, `format?` (`jpeg` or `png`, default `jpeg`), `mask?` (1-10 targets) | image of the viewport (JPEG quality 60 by default), the full page, or one element (`target`, strict: several matches is an error with the same diagnostics as an action; `fullPage` and `target` cannot be combined), saved under the report's `shots/`. `label` is lowercase letters, digits and hyphens (1-40, not starting with a hyphen) and ends up in the file name. Elements in `mask` are painted over with a solid colour (`#FF00FF`); every `mask` entry must match at least one element, otherwise the screenshot fails with `not-found` (`mask[i] matched no element`) and no image is written, and a failed screenshot with a `mask` leaves no failure shot either (that one would be unmasked) |
| `console` | | last 50 console messages (300 characters each) |
| `network` | | summary of the last 50 requests |
| `click`, `hover` | `target` | pointer actions |
| `fill` | `target`, `value` | type into an input or textarea (refuses password-like fields, see Safety) |
| `press` | `key`, `target?` | press a key |
| `scroll` | `target?`, `dx?`, `dy?` | scroll an element into view, or the page window by dx/dy |
| `goto` | `url` | navigate (http/https only) |
| `viewport` | `width`, `height` | resize (320-3840 by 240-2160). Touch emulation is chosen at `open` time (`--touch`) and survives a resize |
| `wait` | `for`, `timeoutMs?` | wait for `{text}`, `{target,state}` (visible/hidden), `{urlContains}`, `{ms}` or `{idle}`; default 10 s, max 60 s. `{idle: <ms>}` (100 to 10000) waits for that many ms of quiet: no request waiting for its response, no request started or answered, and no DOM change in the main document. Long-lived requests (a request that keeps waiting for its response) keep it from settling and end in a timeout, whose hints name up to 3 of them; event streams are not counted. A request whose response headers have arrived but whose body is still streaming no longer counts, so an app that updates the page from a long chunked response can be judged idle before the body ends. `timeoutMs` must be at least 500 ms longer than the idle window (a usage error otherwise); when omitted it defaults to the larger of 10 s and the idle window plus 5 s. Page animations that keep changing the DOM also keep it from settling |
| `assert` | `kind`, `target?`, `property?`, `cmp`, `expected` | check `text`, `count`, `css`, `url` or `visible`; result is a match or a mismatch, never "pass/fail" |
| `eval` | `js` | run a JavaScript expression in the page (the response is cut at 4000 characters; the record keeps at most 1000, redacted, and only on a page without a password-like field) |

Supported `css` assertion forms:

- Colours are normalised only when the property name contains `color` (`color`, `background-color`, `border-top-color`, ...): `#rgb`, `#rrggbb`, `rgb()` and `rgba()`. Any other property, such as `background`, `fill`, `stroke`, `border` or `box-shadow`, is not treated as a colour: `eq` / `ne` compare the strings exactly, so `background eq #fff` will not match a computed `rgb(...)` value.
- Lengths: a plain number or `<number>px`.
- Anything else (named colours, `#rrggbbaa`, other units) falls back to exact string equality for `eq` / `ne`; the ordering comparisons do not match.

## Exit codes

| code | meaning |
|---|---|
| 0 | no assertion mismatched, no action failed, and no login wall (`close` only looks at mismatches, so it reports 0 or 10) |
| 1 | internal error |
| 2 | usage error, unknown session, or the kernel is busy (including a kernel that is shutting down) |
| 10 | at least one assertion mismatched |
| 11 | an action failed (a batch with both a mismatch and a failed action reports 11); a refused password fill is also 11 (but 20 when the page is a login wall). `open` also exits 11 when the page cannot be opened, or when `--touch` cannot be emulated; no session is created then |
| 20 | after `open` or `step`, the top page shows a visible password-like field; a person should run `login`. Takes precedence over 10 and 11 |
| 21 | waiting for an approval (reserved, not used in M1) |
| 22 | no kernel running, `login` without a terminal, a state-directory problem a person must fix (see `next`), or `doctor` found a failing check |

## Where things live

State directory: `~/.e2e-kernel/` (override with an absolute `E2K_HOME`). It holds `kernel.sock`, `kernel.pid`, `kernel.log`, `profiles/default/` (the browser profile with login cookies), `profiles/default.login.json` (time and host of the last `login`; mode 0600, kept next to the profile and not inside it) and `runs/`.
Each `close` writes `runs/<session name>/<UTC YYYYMMDD-HHMMSS>-<session id>/` with `report.html` (no scripts; screenshots are linked from `shots/NN[-label].jpg|png` and render when the file is opened from disk), `result.json` (a record of the operations; `eval` sources and any `fill` value not confirmed safe are `[REDACTED]`, and so is any part of a selector that matches the redaction rules, so those steps cannot be replayed from it; an `eval` step carries `jsHash` and, usually, the redacted `output`) and `shots/`. The newest 20 reports per session name are kept. A session idle for 15 minutes is closed (time spent inside a `step` does not count).

## Safety

- The kernel never types a password. `fill` into a password-like field is refused (exit 11, or 20 when the page is a login wall; "a person must log in"). A field counts as password-like when its `type` is `password`, or its `autocomplete` attribute contains `current-password`, `new-password` or `one-time-code`. If the kernel cannot tell, it does not fill. Log in with `login`.
- Fill values are kept in records only when the target is a confirmed non-password `<input>` of type text, email, search, tel, url or number, or a `<textarea>`. A `contenteditable` element or any other target can still be filled, but its value is recorded as `[REDACTED]`.
- `eval` sources are recorded only as a short SHA-256 prefix (`jsHash`, 16 hex characters); the source itself is `[REDACTED]`, so `eval` steps cannot be replayed from the record. The redacted result (at most 1000 characters, redacted before it is cut) is recorded as `output`. When the page holds a password-like field in any frame, before or after the script ran, or that cannot be determined (or the page swapped documents while the script ran), `output` is left out and `outputOmitted` is true; the response to the agent is unchanged. If the script throws, the agent sees the (redacted) error, but the record only says that `eval` threw and keeps the hash, because an error message can carry a page value or a piece of the source.
- `hints` on a failed action (candidate names, the markup of an intercepting element) are page text: each one is redacted, then cut to 300 characters, at most 6 of them; for `fill`, the typed value is replaced first. `result.json` and `report.html` keep them only when the page has no password-like field; otherwise they carry one fixed note instead (the response to the agent is unchanged).
- In the `default` mode every write request is allowed and recorded. Writes that cannot be attributed to a page are listed separately under "writes not attributed to a page". The report groups the attributed writes by host and method (the host name only, redacted; no path and no body), with the allowed and blocked counts; GraphQL writes are split into query, mutation, subscription or unknown (`graphql` in `result.json`, `null` for a request that is not GraphQL). The split is for reading only and is judged from the request body, also when the body itself is not recorded; anything that cannot be told for certain (persisted queries, a body that reaches the 64 KB cap and so may be cut off (unless a mutation was already seen in it), an unbalanced document) is `unknown`, never a query. A batch is a mutation if any item is one. A `query` parameter in the URL is read as well (some servers let it win over the body): a mutation in either place is a mutation, any other combination is `unknown`. A JSON key that is `query` in another case, or more than one such key, is `unknown` unless a mutation is seen; when the same key is repeated, `JSON.parse` keeps the last one and the earlier values are not read. The summary does not count unattributed writes, which have their own list.
- A write sent from a page that holds a password-like field (or when that cannot be determined) is recorded without its body: only the method, the (redacted) URL and the status are kept, and `bodyOmitted` is true. Native form submissions are always recorded without a body, because the page cannot be probed while it is navigating.
- Command output, `result.json` and `report.html` are redacted (token-shaped strings, long token-shaped values in parameters, e-mail addresses, credentials in URLs, request bodies, free-text `password=…` / `"token":"…"` / `x-api-key: …`); plain passwords are not recognisable and are only kept out by the rules above. Command output is raw page text, to be treated as data: in plain text mode only control characters are made visible, in `--json` mode it is JSON-escaped, and neither HTML-escapes markup. Only `report.html` is HTML-escaped and it contains no scripts.
- Selectors written by an agent, and stable selectors the kernel derives (`data-testid`, `id`, accessible names), can carry page text. The response to the agent keeps them verbatim; in `result.json` and `report.html` they go through the same redaction rules, and a matching part is replaced by `[REDACTED]`. An attribute value whose name looks sensitive (`[data-token=x]`, also with spaces around `=` or an operator such as `^=`, with spaces or comments between the operator and `=`, or with the operator repeated) is replaced, quotes included, up to its closing `]` (paired brackets, quoted text and backslash-escaped characters count as part of the value; with no closing `]` or an unclosed quote, up to the end), so the rest of the selector stays as it was. When that `]` is followed by anything other than whitespace, `[`, `]`, `:`, `.`, `#`, `>`, `+`, `~`, `,`, `)`, `/` or `|` (as in `[token=/a]b/]`), the `]` is taken as part of the value, and the value is replaced up to the end. This errs towards replacing too: a few valid selectors lose everything after such a value, such as a quote right after it (`:has-text("[pw=x]")`), an XPath comparison or arithmetic after a predicate (`//a[b[@pw=1]="y"]`) or CSS nesting (`[pw=x]&.b`). An operator followed by an unclosed comment (`[pw $/*…`) is replaced up to the end as well. This is a deliberate trade-off: an unescaped, unpaired `]` outside quotes inside such a value that happens to be followed by one of those characters (an invalid selector anyway; quote or escape it) ends the value, and what follows it is not replaced. A sensitive name that does not directly follow `[` (outside `[…]`, as in `#x token=abc >> div`, `text=token=abc`, `text=password = abc` or `#x pw /**/ =abc` (a comment between the name and `=` counts only when it holds no `*` or `=`), or inside another value, as in `[href="/cb?token=abc"]`) has its value replaced up to the end of the selector. A name in a selector is judged after undoing CSS escapes (`[t\oken=…]`) and URL encoding (a stray `%` does not stop the rest from being decoded, so `%|p%77` is `pw`), and it counts as sensitive when it, or any part of it split at characters other than letters and digits (`data-pw`, `ns|pw`, `@ns:pw`, `/cb/pw`), is a sensitive name. This errs towards replacing: a sensitive part anywhere in a path or a name (`a[href="/login/pass=1"]`, `[data-pwé=1]`) replaces the value, and outside `[…]` everything after it. Attributes are scanned twice, once treating CSS comments as spaces around the name and `=` and a comment inside or right after a name as part of that name (an unclosed comment after a sensitive name: up to the end), and once without recognising comments (their characters are read as ordinary name characters), and a value replaced by either scan stays replaced. A comment inside a value is part of the value, like quoted text (unclosed: up to the end); a name is also judged with its comments removed (`t/*x*/oken`). A name right after `]` (`[a=1]token=x`, not a valid selector) counts as outside `[…]`; a name after `[` and only whitespace or whole comments (`[/* c */ pw = x]`) counts as directly following `[`. Outside brackets, a comment between a name and `=` is recognised only when the name itself holds no comment marks (`t/*x*/oken /**/ =x` and `a*/pw /**/ =x` are not). A `[` inside a comment never starts an attribute in the comment-aware scan, so a malformed selector that only works through one (an unclosed `[a` followed by a comment holding `[`, as in `[a /* [ */ /* [ */pw /* c */ =x]`) is not recognised. XPath `!=` counts as an operator. In free text (hints, output) none of this applies: a sensitive name's value is still replaced up to the next space or quote.
- Focus: on macOS, launching the headed browser takes window focus. This is a known M1 limitation and will be addressed in M2. Only focus at launch was measured, see `docs/m0-findings.md`.

### Threat model

The kernel guards against an agent that drifts, misclicks or takes shortcuts. It does not defend against a deliberately hostile agent or process (see section 5.4 of [docs/design.md](docs/design.md)). Known limits:

- The socket is open to any process of the same local user, including `login.begin`.
- `start` has no terminal check, so an agent can start the kernel; the kernel, the browser and the profile then belong to that process until it is stopped (Ctrl-C, SIGTERM or SIGHUP).
- `press` typing key by key, and assigning an input's value inside `eval`, can get around the refusal to fill password fields.
- Any process of the same user can read and write the state directory.
- The terminal check on `login` only waits for Enter; it does not prove a person is there.
- On a page without a password-like field, an `eval` result is recorded and only redacted by the rules. A secret that does not look like a token (a value in `localStorage`, a recovery code or PIN shown in plain text, personal data), or a password shown as plain text rather than in a password field, is not recognised.
- `jsHash` is an unsalted 64-bit prefix of SHA-256. A low-entropy secret embedded in an `eval` source (a short code, a short passphrase) can be brute-forced offline from the hash, so do not write secrets into `eval` sources.

### Known M1 gaps

- A write whose page cannot be identified (for example a form POST from a new tab's first navigation) is listed as unattributed; reads are not. Unattributed writes are listed in the report of every session that was open at the time, so concurrent sessions can show each other's.
- Redaction gaps: a password inline in a GraphQL query (not a variable) is not recognisable. A whole-value token rule skips values that start with `/` or contain `//`, so a base64 token that happens to contain `//` is not caught by it. The e-mail rule also rewrites file names that contain an `@` followed by a dotted suffix (a high-density image name, for example), and a relative path or identifier of 32 or more characters that mixes upper case, lower case and digits can be replaced as a whole value. A parameter value wrapped in escaped (`\"`) or HTML-entity quotes, or with a space after `=`, is not recognised by the free-text parameter rule.
- Screenshots are not redacted automatically; use `mask` to cover known sensitive elements. `mask` covers each element's bounding box only (content overflowing it stays visible), and matches are re-resolved when the image is taken, so an element that is replaced or moved between the check and the capture is not masked, without an error.
- Password-page detection can time out and then drops the body (fail closed): the probe is limited to 300 ms, so a page whose thread is busy (a synchronous XHR, a long script) is treated as undetermined. The probe runs when the request reaches the handler, so a single-page app that swaps the form out right after submitting may not be recognised (the key-name redaction is the fallback). A password field in a sibling iframe, when the request comes from the top document, is not seen, and neither is one inside a closed shadow root (open shadow roots are searched). If a navigation of the frame (or of the top frame) has already started, or the frame address changes while the probe runs, the result is undetermined. Two kinds of page swap can still be misjudged: one that makes no network request (for example a jump to `about:blank`), and a DOM replacement that keeps the document (`document.write`, emptying the body). The cost of failing closed: native form posts, and writes from busy pages, lose their bodies even on pages without a password field.
- `open --touch` emulates a touch screen on the session's main page only (per-page CDP `Emulation.setTouchEmulationEnabled`): `(pointer: coarse)` and `(hover: none)` match, `maxTouchPoints` is 5 and touch events exist. It is verified at `open` time and `open` fails (11, no session) if the emulation does not take. It stays on across `viewport`, every screenshot and cross-site navigation (see docs/m0-findings.md section 9.8). Not covered (measured, they do not inherit it): popups and new tabs opened by the page, and cross-site iframes (a same-site iframe does follow the page), `click` still sends mouse events (there is no `tap`), the user agent is unchanged and `isMobile` is not emulated. `start.touch` in `result.json` and the report's environment section say whether it was on.
- The single-instance lock has a millisecond-scale race.
- A redirect's follow-up hops do not pass through the request handler (Playwright calls a route handler only for the first URL of a redirect chain), so a write that is redirected, for example by a 307, is judged and recorded only at its first hop. Recorded by a test, not fixed; see docs/m0-findings.md.

## Not in this version

No domain rules or read-only mode, no per-site profiles, no approval flow (there is deliberately no `approve` command), no "deny" mode, no `save-case` / `run`, no MCP wrapper, no headless mode, no CI use, and no platform other than macOS. See the milestones in [docs/design.md](docs/design.md).

## Development

```sh
npm run check         # typecheck, unit and kernel tests, public-repo scan
npm run test:browser  # driver tests in a real headed Chromium
npm run test:e2e      # build, then end-to-end acceptance on local fixtures
npm run m0            # route-coverage probe; results are described in docs/m0-findings.md
```
