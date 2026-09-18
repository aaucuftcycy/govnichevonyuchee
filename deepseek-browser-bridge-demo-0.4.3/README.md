# DeepSeek Browser Bridge — README for Repository Analysis Agents

## 1. What this repository is

This repository is a small local bridge that lets a command-line program talk to the DeepSeek **web UI** through a persistent Chromium browser session.

Core flow:

```text
User / local project
        |
        v
   src/cli.mjs
        |
        | HTTP on 127.0.0.1:32123
        v
  src/daemon.mjs
        |
        v
  src/browser.mjs
        |
        | Playwright
        v
   Chromium profile
        |
        v
 chat.deepseek.com
```

The project does **not** use the official DeepSeek API and does not require a DeepSeek API key. Authentication is kept in a local persistent browser profile.

The repository is a proof-of-concept / utility, not a production service.

---

## 2. Current version and runtime

Current package version: **0.4.3**

Runtime requirement:

- Node.js >= 20
- Playwright ^1.55.0
- Chromium installed through Playwright

`package.json` is the source of truth for version, scripts, engine requirements, and dependencies.

The repository uses native ES modules (`"type": "module"`).

---

## 3. File-by-file architecture

### `src/cli.mjs`

The command-line client.

Responsibilities:

- parses CLI commands and arguments;
- reads optional local files for `--file`;
- starts or reuses the background daemon;
- checks daemon version via `/health`;
- replaces an older daemon if it is occupying the fixed local port;
- sends HTTP requests to the daemon;
- prints the final assistant answer to stdout;
- exposes the user-facing commands.

Important constants:

- host: `127.0.0.1`
- port: `32123` by default, configurable with `DS_BRIDGE_PORT`
- CLI/daemon version: `0.4.3`

The CLI itself does **not** control Playwright directly. It is a thin local HTTP client around the daemon.

### `src/daemon.mjs`

The long-lived local background process.

Responsibilities:

- creates one `DeepSeekBridge` instance;
- starts the browser once and keeps it alive;
- listens only on `127.0.0.1:32123` by default;
- serializes browser work through a promise queue so concurrent CLI calls do not operate on the browser at the same time;
- exposes HTTP endpoints for ask/status/history/new/setup/stop;
- writes daemon errors to `.debug/daemon.err.log`;
- shuts down the browser on stop or process termination.

Current endpoints:

```text
GET  /health
GET  /status
GET  /history
POST /ask
POST /new
POST /setup
POST /stop
```

The queue is intentional: this bridge is designed for one active browser interaction at a time.

### `src/browser.mjs`

The core browser automation layer.

Responsibilities:

- launches Chromium with `chromium.launchPersistentContext()`;
- stores the persistent browser profile in `.browser-profile`;
- keeps a live `Page` reference and can recover it if a tab is closed;
- opens a specific conversation URL;
- reads visible conversation links from the sidebar;
- opens the root DeepSeek page for the `--new` workflow;
- fills and submits prompts;
- waits for the browser's DeepSeek completion response;
- extracts the final assistant text from the rendered page;
- saves diagnostic screenshots / JSON in `.debug`.

Important implementation detail:

The current code does **not** parse DeepSeek's SSE chunks itself. It listens for the browser response to:

```text
POST /api/v0/chat/completion
```

and then waits for `response.body()` to finish. After the network stream finishes, it reads the final assistant message from the DOM.

This is faster and less fragile than the older "poll until DOM text becomes stable" strategy, but it is still not true token-by-token streaming to the terminal.

### `src/selectors.mjs`

The UI-specific selector and text-extraction layer.

Responsibilities:

- locate the chat input;
- locate login UI;
- locate send / stop controls;
- locate assistant replies;
- locate conversation links;
- extract plain text from assistant markdown;
- remove citation/source UI noise and standalone numeric citation markers.

All DeepSeek DOM assumptions should be concentrated here whenever possible.

If DeepSeek changes its HTML structure, this is the first file to inspect.

### `demo-project/`

A tiny example project used to verify that local files can be sent to DeepSeek.

`demo-project/src/calculator.js` intentionally contains a bug in `average()`:

```js
return numbers.reduce((sum, value) => sum + value, 0) / (numbers.length - 1);
```

The denominator is intentionally wrong. This is a test fixture, not a feature of the bridge.

### `.browser-profile/`

Created at runtime.

Contains the persistent Chromium/DeepSeek session data. Treat this directory as **sensitive local state**. It is ignored by Git.

Never commit it, copy it into tickets, or expose it in logs.

### `.debug/`

Created at runtime.

Used for diagnostics such as:

- daemon logs;
- daemon error logs;
- screenshots after UI failures;
- raw debug JSON when a request needs inspection.

It is ignored by Git.

### `.gitignore`

Ignores `node_modules`, `.browser-profile`, `.debug`, and standard macOS noise.

### `.npmrc`

Disables npm funding and audit output for this small local project.

### `package.json`

Defines the project metadata, Node requirement, Playwright dependency, and CLI scripts.

---

## 4. User-facing commands

From the repository root:

```cmd
npm install
npx playwright install chromium
```

Then:

```cmd
npm run setup
```

Opens/initializes the persistent browser session. The user logs into DeepSeek manually if needed.

### Health / diagnostics

```cmd
npm run doctor
```

Checks that the bridge is alive, DeepSeek is reachable in the browser, and the chat input is visible.

### Ask

```cmd
npm run ask -- "Hello"
```

Sends a prompt to the currently active DeepSeek conversation.

### New chat + ask

```cmd
npm run ask -- --new "Start a new conversation"
```

The implementation opens DeepSeek's root chat state and lets the web app create the real conversation when the first message is submitted. There is deliberately no dependency on the private `chat_session/create` response shape for this path.

### Open the root new-chat page

```cmd
npm run new
```

This opens the root DeepSeek chat page. It does **not** require a conversation ID and does not promise that a permanent chat ID exists yet.

### Specific conversation

Preferred explicit form:

```cmd
npm run ask -- --chat <UUID> "Continue this conversation"
```

Supported shorthand:

```cmd
npm run ask -- --<UUID> "Continue this conversation"
```

A bare UUID can also be recognized by the parser when used as a positional argument before the prompt.

The bridge normalizes a UUID to:

```text
https://chat.deepseek.com/a/chat/s/<UUID>
```

### History

```cmd
npm run history
```

Scrapes the **visible sidebar links** from the current DeepSeek page and prints discovered conversation IDs and titles.

This is not a server-side conversation database. If a conversation is not represented by a visible `/a/chat/s/<id>` link in the current DOM, it may not appear here.

### Stop

```cmd
npm run stop
```

Stops the local daemon and closes its persistent Chromium context.

### Short command alias

```cmd
npm run ds -- "Hello"
```

`ds` is just an alias to `node src/cli.mjs`.

---

## 5. CLI argument model

The `ask` command supports:

```text
--new
--chat <id-or-url>
--<uuid>
--file <path>
--timeout <seconds>
```

Prompt text is assembled from positional arguments plus zero or more `--file` sections.

For `--file`, paths are resolved relative to the project root.

Example:

```cmd
npm run ask -- --file demo-project/src/calculator.js "Find the bug and explain the fix."
```

The file is inserted into the prompt as:

```text
--- FILE: <path> ---
<content>
--- END FILE ---
```

There is no project-wide file discovery or automatic context indexing in the current version.

---

## 6. Browser lifecycle

The bridge intentionally uses a persistent Chromium context.

At startup:

1. Create `.browser-profile` if needed.
2. Launch Chromium with the profile.
3. Reuse an existing DeepSeek tab if one exists.
4. Otherwise reuse another live tab or create a new one.
5. Navigate to DeepSeek root if needed.
6. Keep the browser alive in the daemon.

For later calls, the CLI reuses the same daemon process and therefore the same browser session.

This avoids the older architecture where every CLI call launched and closed Chromium.

If a tracked page becomes invalid or closes, the bridge attempts to recover a live page from the browser context.

---

## 7. Chat selection behavior

### Current chat

When no `--new` or `--chat` option is supplied, `ask` uses whichever DeepSeek conversation is already active in the current browser page.

This is important: **the CLI does not infer the desired chat from the natural-language prompt**.

### Specific chat

With `--chat` or `--<UUID>`, the bridge navigates to the corresponding DeepSeek conversation URL before sending the message.

The expected path pattern is:

```text
/a/chat/s/<conversation-id>
```

### New chat

With `--new`, the bridge navigates to:

```text
https://chat.deepseek.com/
```

and submits the first message there.

---

## 8. Response acquisition

The current response pipeline is:

```text
user prompt
  -> fill chat input
  -> press Enter
  -> listen for POST /api/v0/chat/completion
  -> wait until the response body completes
  -> read the final assistant DOM node
  -> clean citation/source artifacts
  -> return plain text to CLI
```

The network listener is installed **before** pressing Enter so the request is not missed.

A short fallback click on the visible Send button exists if Enter did not trigger a completion stream.

After completion, the bridge performs a small number of immediate DOM reads (`0`, `25`, `50` ms) rather than waiting for a long "stable text" period.

### Important distinction

The browser receives a streaming completion, but the CLI currently prints the answer only after the completion stream has finished and the final DOM text is available.

If a future agent is asked to make terminal output token-stream in real time, this is the main architectural area to change.

---

## 9. Citation cleanup

DeepSeek may render web-search citation markers or source widgets in the assistant message.

The bridge attempts to remove:

- `<sup>` citation nodes;
- citation/source/reference buttons and links;
- standalone numeric citation markers;
- flattened text patterns such as a number sitting between dashes/newlines.

The cleanup lives in `src/selectors.mjs`.

Do not make the cleanup overly aggressive: normal answer numbers should remain intact.

---

## 10. Error and recovery model

### Common error classes

Errors are returned as simple messages prefixed by names such as:

```text
LOGIN_REQUIRED
UI_NOT_READY
CHAT_INVALID
CHAT_NAVIGATION_FAILED
INPUT_NOT_FOUND
PROMPT_EMPTY
DEEPSEEK_COMPLETION_FAILED
TIMEOUT
RESPONSE_EXTRACT_FAILED
DAEMON_VERSION_CONFLICT
DAEMON_START_FAILED
BROWSER_CONTEXT_CLOSED
PAGE_RECOVERY_FAILED
```

### Version mismatch handling

The CLI uses `/health` before talking to the daemon.

If an older daemon is using the fixed port, the CLI tries to stop it. On Windows it can use the exact daemon PID returned by `/health` and call `taskkill` for that PID tree.

This exists because an old daemon can otherwise remain alive across upgrades and cause the new CLI to unknowingly talk to stale code.

### Debug artifacts

When UI extraction or navigation fails, inspect `.debug/` first.

Useful files include:

```text
daemon.log
daemon.err.log
*.png
*.json
```

Do not expose `.browser-profile` when sharing diagnostics.

---

## 11. What the repository does NOT currently do

Do not assume these features exist unless you add them:

- official DeepSeek API integration;
- API key management;
- token-by-token terminal streaming;
- automatic repository-wide file discovery;
- automatic codebase indexing;
- automatic patch application;
- shell command execution requested by DeepSeek;
- test execution orchestration;
- multi-agent workflows;
- server-side conversation search;
- reliable conversation naming/editing through a formal backend API;
- concurrent browser sessions;
- authentication automation.

---

## 12. Current limitations and fragile areas

The bridge depends on a live DeepSeek web UI and on private web behavior.

Most fragile areas are:

1. DeepSeek DOM selectors in `src/selectors.mjs`.
2. DeepSeek conversation URL structure.
3. The private `/api/v0/chat/completion` web endpoint and its response lifecycle.
4. Browser-session behavior when the user closes tabs manually.
5. Sidebar-based history scraping.

When changing any of these, preserve the separation of concerns:

```text
CLI concerns       -> src/cli.mjs
browser lifecycle  -> src/browser.mjs
DeepSeek UI detail -> src/selectors.mjs
local HTTP daemon  -> src/daemon.mjs
```

---

## 13. Development rules for an AI coding agent

When analyzing or modifying this repository:

### First understand the flow

Read in this order:

```text
package.json
src/cli.mjs
src/daemon.mjs
src/browser.mjs
src/selectors.mjs
README.md
```

Then inspect `demo-project/` if the task concerns file passing or end-to-end examples.

### Preserve the architecture

Do not merge the CLI and Playwright layer back together unless the task explicitly requires it.

The background daemon exists to keep Chromium alive between commands.

### Prefer small isolated changes

If DeepSeek changes its UI, update `src/selectors.mjs` before spreading selector logic across other files.

If daemon startup/recovery is broken, debug `src/cli.mjs` and `src/daemon.mjs` separately from browser automation.

### Do not silently change authentication behavior

The user logs into DeepSeek in Chromium manually. Do not add password collection, cookie export, or credential scraping.

### Do not expose browser profile data

Never print, upload, commit, or include `.browser-profile` contents in diagnostics.

### Keep the local server local

The daemon intentionally binds to:

```text
127.0.0.1
```

Do not change it to `0.0.0.0` without an explicit security design.

### Verify syntax after edits

At minimum, run:

```cmd
node --check src/cli.mjs
node --check src/daemon.mjs
node --check src/browser.mjs
node --check src/selectors.mjs
```

For project-level changes, also run the demo command if a usable DeepSeek session is available.

### Treat current DeepSeek behavior as dynamic

The private web protocol can change without notice. Avoid presenting a guessed selector, endpoint field, or JSON shape as a permanent contract.

If a behavior fails in the live site, use the existing debug facilities and inspect the actual browser/network state before adding another arbitrary timeout.

---

## 14. Recommended debugging procedure

When a command fails:

### Step 1 — check the daemon

```cmd
npm run doctor
```

### Step 2 — check daemon logs

Inspect:

```text
.debug/daemon.err.log
.debug/daemon.log
```

### Step 3 — inspect browser state

Look at the Chromium window and verify:

- DeepSeek is open;
- the user is logged in;
- the intended conversation is open;
- the chat input is visible;
- the browser did not open a different tab.

### Step 4 — inspect screenshots

For navigation/UI errors, check the newest `.png` in `.debug`.

### Step 5 — identify which layer failed

Use this mapping:

```text
wrong CLI parsing / command behavior
    -> src/cli.mjs

wrong daemon startup / stale daemon / queue
    -> src/daemon.mjs + src/cli.mjs

wrong tab / wrong chat / prompt submission / response timing
    -> src/browser.mjs

DeepSeek selector / citation extraction problem
    -> src/selectors.mjs
```

Avoid changing multiple layers at once unless necessary.

---

## 15. Suggested future improvements

If the project is extended toward a real local coding assistant, a sensible order is:

1. add true incremental terminal streaming from completion chunks;
2. add a small persistent chat alias file so users can write names instead of UUIDs;
3. add safe project context collection with explicit include/exclude rules;
4. add stdin support for commands such as `cat file | ds "review this"`;
5. add structured JSON output mode for integration with other programs;
6. add explicit session locking and clearer concurrent-request behavior;
7. add automated regression tests around CLI argument parsing and text cleanup.

---

## 16. Minimal mental model

If an agent needs the shortest correct model of the codebase, use this:

```text
cli.mjs
  = terminal interface + local HTTP client

daemon.mjs
  = persistent local server + serialized task queue

browser.mjs
  = Playwright + persistent Chromium + DeepSeek workflow

selectors.mjs
  = all DeepSeek DOM selectors + answer cleanup

.browser-profile/
  = browser login/session state

.debug/
  = logs and failure diagnostics
```

The most important invariant is:

> **One long-lived local daemon owns one persistent Chromium context; CLI commands talk to that daemon over localhost.**

