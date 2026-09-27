# AGENTS.md

Instructions for agents working in this repo. `CLAUDE.md` is a symlink to this file, so edit `AGENTS.md`.

Part 1 is specific to this fork and takes precedence. Part 2 is the general coding guidance inherited from upstream.

# Part 1: This fork

## What this is

A public GitHub fork of [bobby060/anylist-mcp](https://github.com/bobby060/anylist-mcp). It's an MCP server for AnyList (shopping lists, recipes, meal planning) built on AnyList's private, reverse-engineered protobuf API. The API client lives in the `anylist-js` git submodule, which is likewise a fork of `bobby060/anylist-js`.

This fork exists so upstream code is reviewed before it runs with the owner's AnyList credentials. Treat everything from upstream as untrusted until it has been reviewed.

## Toolchain

- mise pins Node and every security scanner (`mise.toml`). Run `mise install` once. Don't rely on system Node or globally installed tools.
- `make` may not be installed. Every Makefile target is a thin wrapper around an `npm` or `mise run` command, so run that command directly.

## Install modes

- **stdio (default, local):** `npm ci --omit=optional`. It runs `src/server.js`.
  - Locally, the owner starts it through `scripts/with-anylist-creds.sh`, which reads the AnyList credentials from the GNOME keyring (`secret-tool`).
  - Pass a command to run it with other commands, e.g. `scripts/with-anylist-creds.sh npm run test:integration`.
  - Never ask for credentials or store them another way. The owner adds them to the keyring outside agent sessions.
- **HTTP (optional):** `npm ci`. It runs `src/http/index.js` (Docker plus a Cloudflare Tunnel; see README).
- The HTTP-only packages are `optionalDependencies` in `package.json`. The stdio code path (`src/server.js`, `src/tools/`, `src/anylist-client.js`, `src/recipe-normalizer.js`) must never import from `src/http/` or from any optional dependency. CI's `stdio-only` job enforces this.

## Security rules

- **Credentials:**
  - Never read, log, print, or put any of these into tool output, error messages, tests, or commits:
    - `ANYLIST_PASSWORD`
    - access or refresh tokens
    - `.env`
    - `~/.anylist_credentials`
    - `SERVER_SECRET_KEY` and `SESSION_SECRET`
  - Refer to them by name or path only.
- **Network:**
  - At runtime the server talks only to `www.anylist.com` (via anylist-js) and to recipe URLs the user supplies (`src/recipe-normalizer.js`).
  - Don't add new outbound destinations, telemetry, analytics or update checks.
- **No dynamic code:** no `eval`, `new Function`, `vm`, or `child_process` in server code.
- **Dependencies:**
  - Ask the owner before adding any dependency. Prefer Node built-ins.
  - `anylist-js` is imported by relative path, so its runtime dependencies are declared in the root `package.json` with identical ranges. `npm run check:submodule-deps` enforces that.
  - Dependency install scripts must be listed in `allowScripts` in `package.json`: approved (pinned to an exact version) or denied (`false`).
    - `.npmrc` sets `strict-allow-scripts=true`, so an install fails if any unlisted script appears. By default npm 11 only warns and then runs the script anyway.
    - Never approve a new script, broaden an approval, or remove `.npmrc` without the owner's OK. `anylist-js` has the same `.npmrc` and denies husky/highlight.js.
- **Destructive tool actions:**
  - Lists are shared with the household. Deletes must target one specific, named item, event or collection.
  - Don't add bulk delete/clear actions or "delete all matching" behaviour without asking.
- **Accepted risks:**
  - Known vulnerabilities that can't be fixed yet go in `osv-scanner.toml`, each with a written `reason` and an `ignoreUntil` date.
  - Never add an entry or extend a date without telling the owner why.
- **GitHub Actions:**
  - Pin every action to a full commit SHA with a `# vX.Y.Z` comment.
  - Keep `permissions: contents: read` and `persist-credentials: false`.
  - `zizmor` and `actionlint` must pass.

## Before proposing a commit

1. `npm test`, which needs no credentials. Also run `node scripts/smoke-stdio.mjs` if you touched startup, tools, or dependencies.
2. `mise run security` runs the same scanners as CI: gitleaks (this repo and the submodule), osv-scanner, semgrep, zizmor and actionlint.
3. Only commit or push when the owner asks.

## Syncing from upstream (the trust boundary)

- Remotes:
  - `origin` is `linuxmaier/anylist-mcp`.
  - `upstream` is `bobby060/anylist-mcp`, with its push URL set to `DISABLED`.
  - The submodule has the same layout (`linuxmaier/anylist-js` / `bobby060/anylist-js`, default branch `master`).
- **`gh` default repo:** in a fork, `gh pr create` targets the *parent* repo unless told otherwise.
  - Each clone must have `gh repo set-default linuxmaier/<repo>`. Check it with `gh repo set-default --view`.
  - Always pass `--repo linuxmaier/<repo>` to `gh pr create` anyway.
- **Automated:** `mise run upstream-sync` does steps 1–4 below.
  - It merges into local `upstream-sync/<date>` branches, resolves the expected conflicts, runs the tests and scanners, and writes a review report to `.git/upstream-sync-<date>.md`.
  - It writes the report before merging. It stops if a conflict needs a human; resolve it, commit, then run `mise run upstream-sync -- --continue`.
  - Summarize the report for the owner. Only after they approve, run `mise run upstream-sync -- --push` to open PRs in the linuxmaier forks.
- Process:
  1. Start in `anylist-js`: `git fetch upstream`. When upstream bumps the submodule pointer, it points at a bobby060 commit, and that commit must exist in `linuxmaier/anylist-js` first.
  2. Read the full diff (`git log -p master..upstream/master`) before merging. Summarize it for the owner, flagging:
     - new or changed dependencies and install scripts
     - new network calls
     - changes to credential or token handling
     - workflow changes
     - anything obfuscated
  3. Don't merge until the owner approves. Merge on a branch, push it to `origin`, and open a PR in `linuxmaier/anylist-js`.
  4. Repeat in this repo against `upstream/main`, on an `upstream-sync/<date>` branch.
     - Point the submodule at the merged `anylist-js` commit.
     - Run `npm test` and `mise run security`, then open a PR in `linuxmaier/anylist-mcp` so CI runs before merging.
- Expected conflicts:
  - upstream edits `CLAUDE.md`: this fork moved it to `AGENTS.md`, so port the changes by hand.
  - `.github/workflows/release.yml` and `.releaserc.json` were deleted here, so keep them deleted.
  - `package.json`: the dependency layout differs, so keep this fork's layout.
  - `package-lock.json`: don't hand-merge it. Take this fork's version, then run `npm install` to regenerate it.

## Contributing fixes upstream

Only when the owner asks.
1. Branch from `upstream/main` (or `upstream/master` in `anylist-js`), not from this fork's `main`, so fork-only changes don't leak into the PR.
2. Cherry-pick or rewrite just the fix, and push the branch to `origin`.
3. Open the PR with `gh pr create --repo bobby060/<repo> --head linuxmaier:<branch>`.

General fixes accepted upstream shrink this fork's diff and future merge conflicts. Fork-only material stays here:
- `AGENTS.md`
- CI and the scanners
- the dependency layout

## Known gaps (follow-ups)

- **protobufjs 5:** anylist-js pins `protobufjs@5.0.3`. Its advisories are accepted until 2026-12-31 (see `osv-scanner.toml`). The fix is to port anylist-js to protobufjs 7.
- **Recipe import in HTTP mode:** the importer blocks non-HTTP(S) schemes and limits redirects and response size. It does not block private or internal IP addresses, which matters if HTTP mode is exposed to others.
- **Shared token cache in HTTP mode:** every user shares the default token cache path (`~/.anylist_credentials`). Each user's tokens are encrypted with their own password, so this causes re-logins, not leaks.

# Part 2: General coding guidelines (from upstream)

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.