# e2e-kernel

A local resident kernel plus an `e2k` CLI that lets an AI agent do e2e verification in a real browser. The kernel owns a headed Chromium (driven through Playwright behind a small driver protocol), keeps sessions alive across CLI calls, records what the agent did and what the page did, and writes a report for a person to read.
It does not call a model, does not type passwords and does not solve CAPTCHAs: a person logs in, the agent verifies.
Status: M1 (kernel, CLI, Playwright driver, `default` mode, `open` / `step` / `close`, `login`, reports). Design: [docs/design.md](docs/design.md). License: MIT.

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

1. Start the kernel. A person must do this in a terminal; without a TTY it exits 22 and there is no override. It stays in the foreground, Ctrl-C stops it.

```sh
node bin/e2k.js start
```

2. Open a page. This returns a session id and a first snapshot. `--name` groups reports (default `session`), `--viewport 1280x720` is optional, `--json` prints one JSON line.

```sh
node bin/e2k.js open http://localhost:3000/ --name smoke
```

3. Run a batch of operations (a JSON array, at most 50 operations, at most 1,000,000 bytes). For large batches, or operations that contain quotes, use `--stdin`.

```sh
node bin/e2k.js step s-1a2b3c '[{"op":"click","target":"e7"},{"op":"assert","kind":"text","target":"#status","cmp":"eq","expected":"Saved"}]'
echo '[{"op":"snapshot"}]' | node bin/e2k.js step s-1a2b3c --stdin
```

`target` is either a ref from the latest snapshot (such as `e7`) or a selector string. A failed action stops the batch (the rest is reported as not run); an assertion mismatch is recorded and the batch goes on. Selectors are Playwright selectors, plus `role=<role>[name="..."]` for a role with an exact accessible name (for example `role=textbox[name="New item"]`). In the text output `#n` is the 1-based position of the operation in the batch.

4. Close the session. This writes the report. `--verdict` is one of `pass`, `fail`, `exists`, `absent`, `undetermined`; `--because` gives the reason; `--findings` and `--not-done` take a JSON array.

```sh
node bin/e2k.js close s-1a2b3c --verdict pass --because "the item list grew by one"
```

The kernel only flags one contradiction: a `pass` verdict while the record holds a mismatch, a failed or not-run action, or a `--not-done` item. That is reported as a conflict (in the output and in the report). A report is also written when a session ends without `close`: idle timeout, kernel shutdown, or the browser or page going away.

Other commands:

- `node bin/e2k.js login https://example.com/login` opens the dedicated profile so a person can sign in; must be run by a person in a terminal. The cookie stays in the profile for later sessions.
- `node bin/e2k.js status` shows version, driver, browser and sessions. `node bin/e2k.js doctor` checks Node, platform, state directory permissions, socket path length, Chromium (fix: `npx playwright install chromium`), whether the kernel is running, and the kernel version. It exits 22 if any check fails, including "kernel not running"; most failing checks print a fix.
- `--json` (on commands that support it) prints exactly one line on stdout: the result, or `{ "error": ... }`.

## Operations

| op | fields | what it does |
|---|---|---|
| `snapshot` | `depth?` (1-50) | accessibility snapshot with refs (cut at 20000 characters) |
| `text` | `target?`, `max?` (1-20000, default 4000) | visible text of the page or an element |
| `screenshot` | `fullPage?` | JPEG of the viewport (quality 60) saved under the report's `shots/` |
| `console` | | last 50 console messages (300 characters each) |
| `network` | | summary of the last 50 requests |
| `click`, `hover` | `target` | pointer actions |
| `fill` | `target`, `value` | type into an input or textarea (refuses password-like fields, see Safety) |
| `press` | `key`, `target?` | press a key |
| `scroll` | `target?`, `dx?`, `dy?` | scroll an element into view, or the page window by dx/dy |
| `goto` | `url` | navigate (http/https only) |
| `viewport` | `width`, `height` | resize (320-3840 by 240-2160) |
| `wait` | `for`, `timeoutMs?` | wait for `{text}`, `{target,state}` (visible/hidden), `{urlContains}` or `{ms}`; default 10 s, max 60 s |
| `assert` | `kind`, `target?`, `property?`, `cmp`, `expected` | check `text`, `count`, `css`, `url` or `visible`; result is a match or a mismatch, never "pass/fail" |
| `eval` | `js` | run a JavaScript expression in the page (result cut at 4000 characters) |

Supported `css` assertion forms:

- Colours are normalised only when the property name contains `color` (`color`, `background-color`, `border-top-color`, ...): `#rgb`, `#rrggbb`, `rgb()` and `rgba()`. Any other property, such as `background`, `fill`, `stroke`, `border` or `box-shadow`, is not treated as a colour: `eq` / `ne` compare the strings exactly, so `background eq #fff` will not match a computed `rgb(...)` value.
- Lengths: a plain number or `<number>px`.
- Anything else (named colours, `#rrggbbaa`, other units) falls back to exact string equality for `eq` / `ne`; the ordering comparisons do not match.

## Exit codes

| code | meaning |
|---|---|
| 0 | no assertion mismatched and no action failed (`close` only looks at mismatches, so it reports 0 or 10) |
| 1 | internal error |
| 2 | usage error, unknown session, or the kernel is busy (including a kernel that is shutting down) |
| 10 | at least one assertion mismatched |
| 11 | an action failed (a batch with both a mismatch and a failed action reports 11); a refused password fill is also 11 |
| 20 | waiting for a login (reserved, not used in M1) |
| 21 | waiting for an approval (reserved, not used in M1) |
| 22 | needs a person: no kernel running, or a command that must be run by a person in a terminal |

## Where things live

State directory: `~/.e2e-kernel/` (override with an absolute `E2K_HOME`). It holds `kernel.sock`, `kernel.pid`, `kernel.log`, `profiles/default/` (the browser profile with login cookies) and `runs/`.
Each `close` writes `runs/<session name>/<UTC YYYYMMDD-HHMMSS>-<session id>/` with `report.html` (no scripts; screenshots are linked from `shots/NN.jpg` and render when the file is opened from disk), `result.json` (a record of the operations; `eval` sources and any `fill` value not confirmed safe are `[REDACTED]`, so those steps cannot be replayed from it) and `shots/`. The newest 20 reports per session name are kept. A session idle for 15 minutes is closed (time spent inside a `step` does not count).

## Safety

- The kernel never types a password. `fill` into a password-like field is refused (exit 11, "a person must log in"). A field counts as password-like when its `type` is `password`, or its `autocomplete` attribute contains `current-password`, `new-password` or `one-time-code`. If the kernel cannot tell, it does not fill. Log in with `login`.
- Fill values are kept in records only when the target is a confirmed non-password `<input>` of type text, email, search, tel, url or number, or a `<textarea>`. A `contenteditable` element or any other target can still be filled, but its value is recorded as `[REDACTED]`.
- `eval` sources are always recorded as `[REDACTED]`, so `eval` steps cannot be replayed from the record.
- In the `default` mode every write request is allowed and recorded. Writes that cannot be attributed to a page are listed separately under "writes not attributed to a page".
- A write sent from a page that holds a password-like field (or when that cannot be determined) is recorded without its body: only the method, the (redacted) URL and the status are kept, and `bodyOmitted` is true. Native form submissions are always recorded without a body, because the page cannot be probed while it is navigating.
- Command output, `result.json` and `report.html` are redacted (token-shaped strings, long token-shaped values in parameters, e-mail addresses, credentials in URLs, request bodies, free-text `password=…` / `"token":"…"` / `x-api-key: …`); plain passwords are not recognisable and are only kept out by the rules above. Command output is raw page text, to be treated as data: in plain text mode only control characters are made visible, in `--json` mode it is JSON-escaped, and neither HTML-escapes markup. Only `report.html` is HTML-escaped and it contains no scripts.
- Known boundary: `target`, `given` and `selector` are passed through verbatim, unredacted, so that a record can be replayed. Selectors written by an agent, and stable selectors the kernel derives (`data-testid`, `id`, accessible names), can carry page text.
- Focus: on macOS, launching the headed browser takes window focus. This is a known M1 limitation and will be addressed in M2. Only focus at launch was measured, see `docs/m0-findings.md`.

### Threat model

The kernel guards against an agent that drifts, misclicks or takes shortcuts. It does not defend against a deliberately hostile agent or process (see section 5.4 of [docs/design.md](docs/design.md)). Known limits:

- The socket is open to any process of the same local user, including `login.begin`.
- `press` typing key by key, and assigning an input's value inside `eval`, can get around the refusal to fill password fields.
- Any process of the same user can read and write the state directory.

### Known M1 gaps

- A write whose page cannot be identified (for example a form POST from a new tab's first navigation) is listed as unattributed; reads are not. Unattributed writes are listed in the report of every session that was open at the time, so concurrent sessions can show each other's.
- Redaction gaps: a password inline in a GraphQL query (not a variable) is not recognisable, and screenshots cannot be redacted. A whole-value token rule skips values that start with `/` or contain `//`, so a base64 token that happens to contain `//` is not caught by it. The e-mail rule also rewrites file names that contain an `@` followed by a dotted suffix (a high-density image name, for example), and a relative path or identifier of 32 or more characters that mixes upper case, lower case and digits can be replaced as a whole value. A parameter value wrapped in escaped (`\"`) or HTML-entity quotes, or with a space after `=`, is not recognised by the free-text parameter rule.
- Password-page detection can time out and then drops the body (fail closed): the probe is limited to 300 ms, so a page whose thread is busy (a synchronous XHR, a long script) is treated as undetermined. The probe runs when the request reaches the handler, so a single-page app that swaps the form out right after submitting may not be recognised (the key-name redaction is the fallback). A password field in a sibling iframe, when the request comes from the top document, is not seen, and neither is one inside a closed shadow root (open shadow roots are searched). If a navigation of the frame (or of the top frame) has already started, or the frame address changes while the probe runs, the result is undetermined. Two kinds of page swap can still be misjudged: one that makes no network request (for example a jump to `about:blank`), and a DOM replacement that keeps the document (`document.write`, emptying the body). The cost of failing closed: native form posts, and writes from busy pages, lose their bodies even on pages without a password field.
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
