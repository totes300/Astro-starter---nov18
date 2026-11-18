# Browser automation

Agents check the running site in a real browser through [agent-browser](https://github.com/vercel-labs/agent-browser), a CLI pinned in `devDependencies` that drives Chrome. Being a CLI rather than an MCP server, it works the same from any agent that can run a shell command, and its page snapshots (an accessibility tree with `@e1`-style refs) cost far less context than screenshots.

The **dev-server** skill covers finding or starting the server it points at, and how to tell that the page actually booted. How an agent checks a change (when to run, what to target, the pass at two widths, comparing against a baseline, the one-line report) is the **browser-testing** skill, `.agents/skills/browser-testing/SKILL.md`.

## Running it

Always run the pinned copy:

```bash
npx --no -- agent-browser <command>
```

- `--no` stops `npx` from fetching anything. If the package is missing it fails instead of running whatever was published last.
- `--` stops npm from reading the CLI's flags as its own: without it, `--version` prints npm's version and `-p` becomes npm's `--package`.

`npx --no -- agent-browser skills get core` prints the usage guide that ships with the installed version. Read it before guessing a subcommand; `--help` lists the rest.

To upgrade, read the [changelog](https://github.com/vercel-labs/agent-browser/blob/main/CHANGELOG.md), run `npm view agent-browser time`, and install a release that is at least a week old with `npm install --save-dev agent-browser@<version>` (`.npmrc` saves it exact). The package carries a prebuilt binary per platform, so nothing is downloaded at install time.

## A desktop check

```bash
export AGENT_BROWSER_SESSION="$(npx --no -- agent-browser session id --scope worktree --prefix check)"
npx --no -- agent-browser open http://localhost:4321/
npx --no -- agent-browser set viewport 1920 1080
npx --no -- agent-browser eval "[document.readyState, Boolean(customElements.get('lenis-scroll'))].join(' ')"
npx --no -- agent-browser snapshot -i
npx --no -- agent-browser screenshot
npx --no -- agent-browser close
```

- The session id is derived from the checkout, so parallel worktrees never share a browser. Every command needs it: export `AGENT_BROWSER_SESSION` in each shell, or pass `--session`.
- The browser opens at 1280x720. `set viewport 1920 1080` is the desktop baseline for screenshots and layout checks.
- The `eval` line is the boot check: `complete true` means the scripts loaded and the custom elements upgraded. A page that renders its markup but never upgrades is the signature of scripts failing to load, so check before trusting a screenshot.
- It uses the installed Chrome (`npx --no -- agent-browser install` downloads Chrome for Testing when there is none). Each launch gets a throwaway profile, deleted on close, so agent browsing never touches a personal profile. `--restore` saves a session's cookies and storage under `~/.agent-browser/` between runs.
- It runs headless unless `open` gets `--headed`. A background daemon holds the browser between commands and exits after ten minutes idle (`idleTimeout`, below); `close` ends it sooner.
- Every screenshot stays in the repo. `agent-browser.json` at the root sets `screenshotDir` to `browser-checks/`, so `screenshot` without a path lands there instead of in a folder under your home directory, and the **browser-testing** pass files its shots under `browser-checks/<task>/`. The folder is gitignored and kept until someone deletes it; the agent asks before it does. Run the CLI from the repo root, where the config is read.

Commands worth knowing:

- `console` and `errors`: the page's console output and uncaught errors. A `[Report Only]` CSP message blocks nothing (see [Security headers](./security-headers.md)).
- `eval <js>`: run a script in the page, for example `document.getAnimations()` mid-transition.
- `vitals`: lab LCP, CLS, TTFB, FCP and INP.
- `a11y`: an axe-core audit bundled in the binary. Run it after the entrances have finished, or after `set media light reduced-motion` and a `reload`: words caught mid-reveal count as low contrast.
- `diff screenshot --baseline <png>` and `diff url <a> <b> --screenshot`: before against after, or a preview against production.
- `record start <file.webm>` and `record stop`: video of a page transition or scroll animation. Needs `ffmpeg` on `PATH` (`brew install ffmpeg`).
- `trace start` and `trace stop <file>`: a DevTools performance trace. Lighthouse runs follow the **performance-audit** skill.

## Project config

`agent-browser.json` at the repo root sets the defaults every command picks up when run from the root. Flags and `AGENT_BROWSER_*` variables still override it.

| Key | Value | Why |
| --- | --- | --- |
| `screenshotDir` | `browser-checks` | A screenshot without a path lands in the repo's gitignored `browser-checks/`, never in a folder under the home directory. |
| `idleTimeout` | `10m` | A session nobody closed stops its background Chrome after ten minutes instead of an hour. The next command starts a fresh one in about a second. |
| `maxOutput` | `50000` | Caps what one command prints into the agent's context; a longer snapshot or console dump ends with a `[truncated: ...]` note. Files written by the command, such as `a11y --json > file`, are not cut. |
| `contentBoundaries` | `true` | Page output (snapshots, `eval`, `get text`) arrives between `AGENT_BROWSER_PAGE_CONTENT` marker lines, and JSON output carries a `_boundary` key, so text from the page reads as data, never as instructions to the agent. |

Left out on purpose: `screenshotFormat: "jpeg"` (smaller files, but compression noise makes two captures of an unchanged page diff as changed), `allowedDomains` (it blocks the CDNs a page loads its images, video and fonts from, and refuses `--restore`), and the action confirmations (the interactive one denies everything when there is no terminal, which blocks the agent's own checks). The `$schema` key gives the file autocomplete and validation in the editor.

## Protected deployments

A gated deployment answers 401 until it sees Basic Auth. Do not put the credentials in the URL (`http://user:pass@host/`): Chrome drops them from subresource requests, so the HTML arrives, every module script 401s, and no custom element upgrades. Send the header, scoped to that origin, with the credentials read from your shell rather than written anywhere:

```bash
npx --no -- agent-browser open https://prod.<brand>-web.workers.dev/ \
  --headers "{\"Authorization\": \"Basic $(printf '%s:%s' "$BASIC_AUTH_USERNAME" "$BASIC_AUTH_PASSWORD" | base64)\"}"
```

See [Basic Auth](./basic-auth.md) for what is gated and where.

## Mobile Safari

Not covered. agent-browser ships an iOS Simulator provider (`-p ios`), but in this version the commands after `open` fall back to a desktop Chrome instead of driving Safari (upstream [#365](https://github.com/vercel-labs/agent-browser/issues/365) and [#1221](https://github.com/vercel-labs/agent-browser/issues/1221)), and it starts Appium through an unpinned `npx appium`. Leave it alone, and check Safari-only behavior in the Simulator or on a phone by hand.

## Safety

The agent can reach whatever its browser can. Point it at local servers and your own deployments, and do not sign into anything sensitive inside a session it drives.

## Example prompts

- "Open localhost:4321 at 1920x1080 and screenshot the hero section"
- "Record the page transition from the home page to an article on localhost:4321"
- "Run an accessibility audit on localhost:4321/about with reduced motion"
- "Screenshot the header on localhost:4321 at 390x844 and again after scrolling one screen"
- "Compare localhost:4321 with the production site and list the visual differences"
