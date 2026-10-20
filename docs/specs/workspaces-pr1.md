# Working files — PR1

Status: implemented on `feat/workspaces-pr1`.

## Context

`pi-durable` ships `read`, `write`, `edit`, and `bash` behind an `ExecutionEnv`.
The obvious backend is `NodeExecutionEnv`, but fleet-base runs inside `celld`,
which is a V8 isolate:

```text
node:fs.writeFileSync      -> node:fs.writeFileSync is not implemented in celld
node:fs.readdirSync('/')   -> ENOENT: open '/'
node:child_process.spawn   -> node:child_process.spawn is not implemented in celld
process.cwd()              -> "/"
process.env                -> {}
```

So the tools cannot touch the host from the Worker. PR1 puts one loopback
executor on the box and implements `ExecutionEnv` against it. The Worker keeps
the transcript; the box keeps the files.

## Architecture

```text
celld Worker (V8)                       box daemon (Node, 127.0.0.1:9877)
  Assistant DO                          .celld/workspaces/<id>/
    DaemonEnv (ExecutionEnv)  ─────────► /fs/*    resolve + prefix + lstat/realpath + O_NOFOLLOW
      read/write/edit                   /git/*   git under bwrap, https-only gate
      bash/git tools                    /exec    bwrap + cleared env + timeout
    transcript in DO SQLite             index.json: SHA-256 token hashes, no plaintext
```

One deployable Worker plus one local helper started by `npm run dev`. No
containers, no second storage system, no sync.

The workspace id is `<durable-object-id>-<conversationId>`. Conversation ids
are only unique inside one DO, so every Assistant starting at `"1"` would
otherwise share a directory. The id is deterministic and exposed in
`GET /state`; the token is not.

## Required

1. **Daemon.** `scripts/box.mjs`, loopback only (`FLEET_EXECUTOR_URL`, default
   `http://127.0.0.1:9877`), started by `npm run dev` alongside `celld dev`.
   `POST /workspace {id, tier?, quotaMb?}` issues (or rotates) a 32-byte token,
   creates the directory on demand, writes a `.fleet-workspace` marker, and
   persists only a SHA-256 token hash in `.celld/workspaces/index.json`. The
   Worker stores the plaintext token in DO SQLite. On a 401 the Worker
   re-handshakes once and retries.
2. **Routes.**
   - `POST /workspace` — enroll/rotate, no auth (loopback admin surface).
   - `POST /workspace/info`, `/workspace/tier`, `/workspace/reset` — auth.
   - `POST /fs/read {path, binary?, offset?, length?}`, `/fs/write`,
     `/fs/stat`, `/fs/list`, `/fs/mkdir`, `/fs/canonical`.
   - `POST /git/clone {url, dir?}`, `/git/fetch {repo?}`, `/git/status {repo?}`.
   - `POST /exec {cmd, timeoutMs?, net?, spill?}` — tier t1 only.
   - `GET /health` — the only unauthenticated GET.
   - No `/fs/edit`: the pi edit tool uses `readTextFile` + `writeFile`.
3. **ExecutionEnv surface.** Implement exactly what the installed coding tools
   call: `id`, `cwd`, `absolutePath`, `joinPath`, `exists`, `canonicalPath`,
   `readTextFile`, `writeFile`, `fileInfo`, `openBinaryReader`, `exec`.
   `openBinaryReader` is stateless: `{info, read(offset, len), scanLines,
   close}`, each call reopening over HTTP. Everything else returns
   `not_supported`; `cleanup` is a documented lifecycle no-op (nothing to
   close). `exec` in t0 returns a `shell_unavailable` error without a network
   call.
4. **Path jail.** Map `/workspace/...` and relative paths to
   `path.resolve(workspace, target)`, reject unless the result is the workspace
   or starts with `workspace + path.sep`. Reject host absolute paths and NUL.
   Walk each existing component with `lstat`; a symlink must `realpath` inside
   the workspace. Open the leaf with `realpath(dirname)` + `O_NOFOLLOW`.
   The Worker repeats the virtual-path check.
5. **Command jail.** t1 runs under this exact bwrap shape:
   `--ro-bind /usr /usr`, `--symlink usr/bin /bin`,
   `--symlink usr/lib /lib`, `--symlink usr/lib /lib64`,
   `--bind "$WS" /workspace`, `--tmpfs /tmp`, `--proc /proc`, `--dev /dev`,
   `--unshare-all`, `--die-with-parent`, `--new-session`, `--as-pid-1`,
   `--clearenv`, `--setenv PATH /usr/bin:/bin`, `--setenv HOME /workspace`,
   `--setenv LANG C.UTF-8`, `--chdir /workspace`, `-- /usr/bin/bash -lc CMD`.
   Net commands add `--share-net` plus read-only binds of `resolv.conf`,
   `hosts`, `nsswitch.conf`, `ssl`, and `ca-certificates`. No host `/home`,
   no host `/etc` otherwise. `sudo` fails via no-new-privileges. `bwrap` absent
   is loud and only disables `/exec` and `/git/*`; t0 fs routes keep working.
6. **Size and time limits.** Exec timeout default and hard cap 120 s
   (`FLEET_EXEC_TIMEOUT_MS`); clone timeout 300 s
   (`FLEET_CLONE_TIMEOUT_MS`); request body 16 MB; file 16 MB; retained output
   10 MB. Quota 200 MB default, checked on write and clone, overridable per
   workspace with `POST /workspace` or `POST /agent/:name/config`.
7. **Tier.** `t0` (default) = files + git; `t1` = files + git + bash. Stored in
   DO SQLite under `fleet:sandboxTier:v1:<conversationId>` and set with
   `POST /agent/:name/config {"sandbox":"t0"|"t1"}`. `pi.agent` has no
   extension point for app fields, so the tier is a separate key next to it.
8. **Git tool.** Register `git_clone` and `git_status` in the coding extension.
   `/git/clone` accepts parsed `https://` only, rejects credentials in the URL,
   rejects private/loopback/link-local/`.local` hosts (DNS lookup included),
   passes `--depth 1 -- <url> <dir>`, and sets
   `GIT_ALLOW_PROTOCOL=https`, `GIT_TERMINAL_PROMPT=0`,
   `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`.
9. **Replay.** `read`, `git_status`, and `echo` are `replay: "safe"`.
   `write`, `edit`, `bash`, and `git_clone` are `replay: "unsafe"`: after a
   crash pi reports `interrupted` rather than rerunning a write or command.
   The README states the rerun risk plainly.
10. **Reset.** `POST /reset` kills running execs for the workspace, deletes
    `.celld/workspaces/<id>/` and its index entry, then resets the transcript.
    It is idempotent. If the daemon is down the transcript still resets and
    `workspaceDeleted:false` is returned.
11. **Single-box truth.** Transcript in DO SQLite; files scratch on box disk;
    migration loses files until PR2. The `.fleet-workspace` marker stores the
    box id. On a mismatch the daemon parks the old directory as
    `<id>.lost-<timestamp>`, returns `lostFrom`, and the prompt section tells
    the agent to say the workspace was on box X and is gone. The E2E transcript
    shows it doing that.
12. **Dev supervisor.** `npm run dev` starts both processes, waits for the box
    health check, forwards SIGINT, and stops both. `--clean` also removes
    `.celld/workspaces` and `.celld/box-id`.

## Out of scope

Containers (`ctx.container`), subagent tools, web tools, background command
tools, upload endpoints, sync/snapshot, workspace migration/recovery, a second
storage system, Windows/macOS, multi-box routing, PR2 archive/pointer.

## Acceptance

- `npm run dev` starts the box and celld; `/health` is unchanged.
- A t0 agent clones/reads/edits and runs `git_status`; a t1 agent writes and
  runs `hello.ts`; a t1 agent clones and runs a tiny test suite and fixes it.
- `read` works through the real `openBinaryReader` + `scanLines` path.
- Jail probes show: no `/etc/shadow`, no `/home`, no `.dev.vars`, no `~/.ssh`,
  no secret in `printenv`, no host `/proc`, `sudo` denied, `/proc/net/route`
  header only without net, and `/proc/1/cmdline` is the shell, not bwrap.
- `POST /reset` kills a running exec, removes the directory, and is idempotent.
- `kill -9` daemon + restart keeps the token and files; a new box id reports
  `lostFrom` and an empty workspace.
- R1, R2, and R3 reports are pasted in the PR.
