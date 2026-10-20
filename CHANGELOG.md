# Changelog

## Unreleased — working files (PR1)

The agent can now read, write, edit, clone, and (in tier t1) run commands in a
per-conversation workspace on the box.

### Added

- `read`, `write`, `edit`, `bash`, `git_clone`, and `git_status` installed next
  to `echo`. `read`, `git_status`, and `echo` are replay-safe; the side-effecting
  tools are replay-unsafe and report `interrupted` after a crash instead of
  rerunning.
- A loopback box executor (`scripts/box.mjs`) and `DaemonEnv`
  (`src/box-env.ts`), because celld's V8 isolate implements neither host
  `node:fs` writes nor `node:child_process`.
- Tier `t0` (files + git) and `t1` (adds bwrap bash), set with
  `POST /agent/:name/config`.
- Per-workspace tokens hashed in `.celld/workspaces/index.json`, stored plaintext
  only in DO SQLite, with one 401 re-handshake and retry.
- `POST /reset` deletes the local workspace after killing its running execs;
  the transcript reset remains separate and durable.
- `npm run dev` now supervises the box and celld; `npm run box` runs the box
  alone. `.celld/workspaces` and `.celld/box-id` are under the existing
  git-ignored `.celld/`.

### Scars

- The first implementation used the pi conversation id as the workspace name.
  Every Assistant DO starts at `"1"`, so `e2e-t0-1`, `e2e-t1-1`, and any future
  agent would have shared one directory and fought over one token. The id now
  includes the DO id: `<durable-object-id>-<conversationId>`.
- `POST /reset` initially returned `workspaceDeleted:false` while leaving the
  directory in place: the Worker sent the token but not the
  `X-Fleet-Workspace` header. Fixed and covered by the E2E.
- `/proc/1/environ` inside bwrap first exposed the daemon's `HOME` containing
  the host workspace path. The bwrap process environment now uses `/workspace`,
  and `--as-pid-1` hides bwrap's own argv from `/proc/1/cmdline`.
- A model given a bundle of credential-harvest commands refused to run them.
  The jail proof therefore runs the same `/exec` handler directly and pastes
  the outputs; the model's refusal is a feature, not a workaround.
- The read tool was wired only after proving `openBinaryReader` + `scanLines`
  against the real pi-durable tool, not against a hand-rolled reader.

### Cut

- PR2 workspace snapshot/archive and the pointer that survives box migration.
- Containers / `ctx.container` (t2), subagents, web tools, background command
  tools, upload endpoints, and any sync/upload code. Files stay scratch on one
  box in this tag.


## v0.1.0 - 2026-10-20

First tag. This is a base, not a launch.

### Scars

- The first kill -9 test looked like a failed resume: the demo wrote its output
  under the project tree, `celld dev` saw the write, rebuilt and restarted the
  app mid-prompt. Moving the output outside the tree made the resume test show
  the real behavior. The test is in the PR verification log.
- One killed prompt left a `pi.assistant` transcript entry with the preview
  `Connection error.` The re-POST returned the full answer under the same
  `operationId`, but the failed partial was still there. Resume is not a clean
  rollback.
- The README's reset wording was imprecise in both directions. Reset starts a
  new context: `/messages` returns a `pi.reset` entry, the `/agents` row is
  kept, and old rows may remain in storage. Fixed after testing.
- `package.json` called the package `fleet` while the repo and README called it
  `fleet-base`. Aligned in this tag.
- Copying `.env.example` to `.dev.vars` with every provider blank starts the
  server and returns `ok` from `/health`, but prompts return 500. The example
  now says that instead of leaving it to the first prompt.
- The first README screen led with architecture, not the run that survives a
  crash, and buried the provider requirement in Quickstart. Rewritten in this
  tag.

### Cut

- Auth, SSO, containers, KV, D1, queues, MCP, multi-harness, and UI. The base
  stays one Worker and two Durable Objects.
- npm publishing and release automation. The package is private; this tag is a
  git tag, not a registry release.
- Coverage thresholds, Playwright, Dependabot, and a wiki. None of them make
  the first run more honest.
