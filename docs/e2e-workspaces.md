# Working files — PR1 E2E proofs

Captured on the `feat/workspaces-pr1` worktree, Linux, Node 26, celld 0.6.2,
bwrap installed at `/usr/bin/bwrap`, model `router/normal_use`. Commands and
outputs are pasted from the runs; tokens are redacted by construction (they
are never printed).

The E2E app is an isolated copy of the repo with its own `.celld/` state, run
as `npm run dev -- --port 9886 --no-watch`; the box listens on
`127.0.0.1:9877`. The test repo is
`https://github.com/thesved/fixture-orders-api.git`, a dependency-free
`node --test` fixture with a planted off-by-one bug.

## 0. Why the box exists

`celld`'s Worker is a V8 isolate:

```text
node:fs.writeFileSync      -> node:fs.writeFileSync is not implemented in celld
node:fs.readdirSync('/')   -> ENOENT: open '/'
node:child_process.spawn   -> node:child_process.spawn is not implemented in celld
process.cwd()              -> "/"
process.env                -> {}
```

`NodeExecutionEnv` cannot run there. `DaemonEnv` is the ExecutionEnv backend.

## 1. `read` through the real `openBinaryReader` + `scanLines`

The probe imports pi-durable's real `createReadTool`, builds a `DaemonEnv`
against the running box, writes `lines.txt`, and calls the reader directly and
then the tool.

```text
$ node --experimental-strip-types .tmp/probe-read2.ts
write: {"ok":true}
info: {"ok":true,"value":{"name":"lines.txt","path":"/workspace/lines.txt","kind":"file","size":19,"mtimeMs":1792525332842.8433}}
read(4,3): {"ok":true,"value":{"0":116,"1":119,"2":111}}
scanLines(1,3): {"ok":true,"value":{"newlines":4,"start":4,"end":13,"firstLineEnd":7,"lastLineStart":8,"selectedBytes":9,"firstLineBytes":3}}
read tool: {
  "output": [
    {
      "type": "text",
      "text": "two\nthree"
    }
  ],
  "diagnostics": [
    {
      "severity": "info",
      "message": "2 more lines in file. Use offset=4 to continue."
    }
  ]
}
```

`read(4,3)` returns bytes `two`. `scanLines(1,3)` selects lines 2–3 without the
trailing newline. The tool output is the real `@earendil-works/pi-durable/tools`
`read` implementation, not a reimplementation.

## 2. t0: clone, read, edit, git_status (agent)

Agent `e2e-t0-1`, default tier t0.

```sh
curl -s -X POST localhost:9886/agent/e2e-t0-1/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Use the git_clone tool to clone https://github.com/thesved/fixture-orders-api.git into the workspace. Then read src/orders.js, fix the off-by-one bug so the tests would pass, and use git_status to show what changed. Do not try to run bash (this agent is tier t0).","requestId":"e2e-t0-1-req1"}'
```

```json
{
  "text": "Cloned `https://github.com/thesved/fixture-orders-api.git` into `/workspace/fixture-orders-api`.\n\nRead `src/orders.js` and found off-by-one bug:\n```js\nfor (let i = 1; i < items.length; i++) {\n```\nskips first item (`items[0]`).\n\nFixed to:\n```js\nfor (let i = 0; i < items.length; i++) {\n```\n\n`git_status` for `fixture-orders-api` shows:\n```\nM src/orders.js\n```\nNo bash was used.\n",
  "submissionId": "e2e-t0-1-req1",
  "operationId": "e2e-t0-1-req1",
  "status": "done",
  "reason": null
}
```

Transcript (`GET /agent/e2e-t0-1/messages`):

```text
pi.assistant | Cloning the repo and lining up the off-by-one fix. / tool:git_clone
pi.tool-result | Cloned https://github.com/thesved/fixture-orders-api.git to /workspace/fixture-orders-api / Cloning into 'fixture-orders-api'...
pi.assistant | Cloned it — now inspecting the off-by-one. / tool:read
pi.tool-result | 'use strict'; ...
pi.assistant | Found the skipped first item — patching the loop to include it. / tool:edit
pi.tool-result | Successfully replaced 1 block(s) in /workspace/fixture-orders-api/src/orders.js.
pi.assistant | Fix applied — confirming the change. / tool:git_status
pi.tool-result | M src/orders.js
```

## 3. t1: write `hello.ts` and run it (agent)

```sh
curl -s -X POST localhost:9886/agent/e2e-t1-1/config \
  -H 'content-type: application/json' -d '{"sandbox":"t1"}'
# {"name":"e2e-t1-1","sandbox":"t1","quotaMb":200}

curl -s -X POST localhost:9886/agent/e2e-t1-1/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a file hello.ts in the workspace that prints exactly: hello from the box. Then run it with node and show me the output. Use the tools, do not just describe.","requestId":"e2e-t1-1-req1"}'
```

```json
{
  "text": "Done — `/workspace/hello.ts` contains:\n```\nconsole.log(\"hello from the box\");\n```\n\nOutput from `node /workspace/hello.ts`:\n```\nhello from the box\n```\n",
  "submissionId": "e2e-t1-1-req1",
  "operationId": "e2e-t1-1-req1",
  "status": "done",
  "reason": null
}
```

On disk:

```text
$ cat .celld/workspaces/<id>-1/hello.ts
console.log("hello from the box");
```

## 4. t1: clone a tiny repo, run its tests, fix, rerun (agent)

The final run uses `git_clone` for the network step; the `bash` tool is offline
by design, so it only runs local commands.

```sh
curl -s -X POST localhost:9886/agent/e2e-final-2/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Use the git_clone tool to clone https://github.com/thesved/fixture-orders-api.git. Then use bash only for local commands: run npm test in that repo, fix the failing loop, and rerun until all tests pass. Do not use bash to clone or fetch anything; bash is offline. Show the final test output.","requestId":"final-2-clone"}'
```

Final answer:

```text
Cloned `https://github.com/thesved/fixture-orders-api.git` via `git_clone`, then fixed the failing loop in `src/orders.js` (`i = 1` → `i = 0`) and reran `npm test`.

Fix:
// before:
for (let i = 1; i < items.length; i++) {
// after:
for (let i = 0; i < items.length; i++) {
The loop was skipping the first item.

Final test output (`npm test` in `/workspace/fixture-orders-api`):
npm notice run fixture-orders-api@1.0.0 test
npm notice run node --test
✔ single item total (no tax) (0.649139ms)
✔ multi-item total with tax (0.178141ms)
✔ empty order totals zero (0.155041ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 61.102414
All 3 tests pass.
```

Transcript:

```text
pi.assistant | Cloning the repo, then hunting the failing loop. / tool:git_clone
pi.tool-result | Cloned https://github.com/thesved/fixture-orders-api.git to /workspace/fixture-orders-api ...
pi.assistant | Cloned — now inspecting the repo and running tests. / tool:bash
pi.tool-result | /workspace / ... (ls)
pi.assistant | Clone confirmed — diagnosing the test failure. / tool:bash
pi.tool-result | npm notice run fixture-orders-api@1.0.0 test / ✖ single item ... ✖ multi-item ...
pi.assistant | Found the off-by-one — running tests to confirm before patching. / tool:bash
pi.tool-result | ✖ single item total (no tax) ... / ✖ multi-item total with tax ...
pi.assistant | Test confirms the first item is skipped — applying the fix. / tool:edit
pi.tool-result | Successfully replaced 1 block(s) in /workspace/fixture-orders-api/src/orders.js.
pi.assistant | Patch applied — rerunning tests to confirm green. / tool:bash
pi.tool-result | ✔ single item total (no tax) / ✔ multi-item total with tax / ✔ empty order totals zero
```

This is a real HTTPS clone through the box's `/git/clone` route and a real
`node --test` process under bwrap. Bash made no network request.

## 5. t0 `bash` returns shell_unavailable

Agent `e2e-t0-1`, still t0:

```sh
curl -s -X POST localhost:9886/agent/e2e-t0-1/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Use the bash tool to run `pwd`. If it is unavailable, say exactly that and stop.","requestId":"e2e-t0-1-req2"}'
```

```json
{"text":"bash is unavailable","submissionId":"e2e-t0-1-req2","operationId":"e2e-t0-1-req2","status":"done","reason":null}
```

In the final app the model read the workspace section and declined before
calling a disabled tool, which is the desired behavior. The deterministic proof
is to call the real pi-durable `bash` tool against a t0 `DaemonEnv`:

```text
$ node --experimental-strip-types .tmp/probe-t0.ts
tool error: shell_unavailable: exec requires tier t1 (POST /agent/:name/config {"sandbox":"t1"})
elapsed_ms: 5
```

The call returns immediately; there is no hang and no daemon `/exec` request
(the Worker short-circuits t0).

## 6. Jail probes (same daemon `/exec` path as the bash tool)

The model correctly declined a "run every credential-harvest command" prompt,
so these were run directly through `POST /exec` with a workspace token after a
`POST /workspace` rotation. This is the same handler the `bash` tool uses. The
rotation also proved the Worker's 401 re-handshake: the next agent prompt read
`hello.ts` successfully after its stored token had been invalidated.

```text
=== cat /etc/shadow ===
exit 1
cat: /etc/shadow: No such file or directory

=== ls -la /home ===
exit 2
ls: cannot access '/home': No such file or directory

=== cat /proc/1/environ ===
exit 0
PWD=/workspace HOME=/workspace LANG=C.UTF-8 SHLVL=0 PATH=/usr/bin:/bin _=/usr/bin/cat

=== printenv | grep -Ei 'FLEET|AWS|S3|CELLD|KEY|TOKEN' || true ===
exit 0
(no output)

=== cat ../../.dev.vars ===
exit 1
cat: ../../.dev.vars: No such file or directory

=== cd / && pwd ===
exit 0
/

=== sudo -n true ===
exit 1
sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
sudo: If sudo is running in a container, you may need to adjust the container configuration to disable the flag.

=== cat ~/.ssh/id_rsa ===
exit 1
cat: /workspace/.ssh/id_rsa: No such file or directory

=== head -2 /proc/net/route ===
exit 0
Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT

=== env | sort ===
exit 0
HOME=/workspace
LANG=C.UTF-8
PATH=/usr/bin:/bin
PWD=/workspace
SHLVL=1
_=/usr/bin/env

=== cat /proc/1/cmdline | tr "\0" " " ===
exit 0
/usr/bin/bash -lc cat /proc/1/cmdline | tr "\0" " "
```

`cd /` lands in the bwrap mount root (`/bin /dev /lib /lib64 /proc /tmp /usr
/workspace`), not the host root. The host workspace path appears nowhere in
`/proc/1/cmdline` because of `--as-pid-1`; `/proc/1/environ` has only the
cleared allowlist plus bash's own `PWD`, `SHLVL`, and `_`. No `FLEET`, `AWS`,
`S3`, `CELLD`, `KEY`, or `TOKEN` value is reachable. Network is unshared, so
`/proc/net/route` has only the header.

## 6b. Network is opt-in

`/exec` defaults to `net:false`; the bash tool never sets it. Direct proof with
the same handler:

```text
net=false  exit 6  net_used false  curl: (6) Could not resolve host: github.com
net=true   exit 0  net_used true   stdout "200"
```

`git_clone` uses the separate `/git/clone` route with network on for its
validated public URL. Agent bash cannot exfiltrate through curl/wget by default.

## 7. Reset kills execs and deletes the workspace

Direct daemon test: start `sleep 60`, call `/workspace/reset` with the token.

```text
reset status 200 {'reset': True, 'deleted': True} elapsed 0.0
exec returned (200, {'exitCode': 128, 'timedOut': False, 'truncated': False, 'stdout': '', 'stderr': '', 'net': False})
workspace gone True
```

Through the Worker:

```sh
curl -s -X POST localhost:9886/agent/e2e-reset-1/reset
# {"name":"e2e-reset-1","reset":true,"workspaceDeleted":true}
curl -s localhost:9886/agent/e2e-reset-1/state
# {"name":"e2e-reset-1","resident":true,"workspace":"8f44...-1","sandbox":"t1","quotaMb":200,"boxId":null,"lostFrom":null}
curl -s -X POST localhost:9886/agent/e2e-reset-1/reset
# {"name":"e2e-reset-1","reset":true,"workspaceDeleted":false}
```

`GET /messages` shows a `pi.reset` entry; the directory and `index.json` entry
are gone. The second reset is idempotent.

## 8. Box migration: files gone, agent says so

Restarted the same transcript state with `.celld/box-id` changed from
`box-e1fb292c-1add-4888-8109-8483b7739358` to `box-migrated-2`. The daemon
parked the old directory as `<id>.lost-…` and returned `lostFrom`.

```sh
curl -s -X POST localhost:9886/agent/e2e-t1-1/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Check the workspace for hello.ts and the cloned fixture repo. Are they still here? If the previous workspace was on another box and is gone, say that plainly. Do not invent file contents.","requestId":"e2e-t1-1-req6"}'
```

```json
{
  "text": "No — neither is still here.\n\n* `/workspace/hello.ts` — not found\n* `/workspace/fixture-orders-api` — not found\n\n`/workspace` currently contains only `.fleet-workspace`.\n\nPlainly: the previous workspace was on box box-e1fb292c-1add-4888-8109-8483b7739358, and it is gone. Files were scratch on that box; only the transcript carried over.",
  "submissionId": "e2e-t1-1-req6",
  "operationId": "e2e-t1-1-req6",
  "status": "done",
  "reason": null
}
```

`GET /state` after the handshake:

```json
{"name":"e2e-t1-1","resident":true,"workspace":"165f...-1","sandbox":"t1","quotaMb":200,"boxId":"box-migrated-2","lostFrom":"box-e1fb292c-1add-4888-8109-8483b7739358"}
```

This is the honest-loss behavior required by the single-box constraint. PR2
will snapshot/archive and leave a pointer instead.

## 9. Token and files survive a daemon `kill -9`

Standalone daemon on `127.0.0.1:9898`, workspace `restart-test`:

```text
issue 200 {'id': 'restart-test', 'token': '<redacted>', 'boxId': 'box-restart-1', 'tier': 't1', 'quotaMb': 200, 'created': True}
write (200, {'path': '/workspace/keep.txt', 'bytes': 9})
--- restart same box id ---
{"path":"/workspace/keep.txt","text":"survives\n","size":9,"mtimeMs":...}
--- restart new box id (migration) ---
{'id': 'restart-test', 'token': '<redacted>', 'boxId': 'box-restart-2', 'tier': 't0', 'quotaMb': 200, 'created': True, 'lostFrom': 'box-restart-1'}
$ ls .celld/workspaces
index.json
restart-test
restart-test.lost-...
```

The token hash and files survive `kill -9` + restart with the same box id. A
new box id parks the directory and reports `lostFrom`.

## 10. Git escape gates

```text
clone http://github.com/thesved/fixture-orders-api.git       -> 400 bad_url  git clone accepts https:// only
clone https://127.0.0.1/x.git                                -> 400 bad_url  private, loopback, and link-local hosts are not allowed
clone https://localhost/x.git                                -> 400 bad_url  private, loopback, and link-local hosts are not allowed
clone https://169.254.169.254/latest/meta-data               -> 400 bad_url  private, loopback, and link-local hosts are not allowed
clone https://10.0.0.1/x.git                                 -> 400 bad_url  private, loopback, and link-local hosts are not allowed
clone https://[::1]/x.git                                    -> 400 bad_url  private, loopback, and link-local hosts are not allowed
clone file:///etc/passwd                                     -> 400 bad_url  git clone accepts https:// only
clone ext::sh -c touch%20/tmp/pwned                          -> 400 bad_url  git clone accepts https:// only
clone https://github.com/thesved/fixture-orders-api.git      -> 200 ok
```

Quota:

```text
issue (tier t1, quotaMb 1)
quota write -> 413 quota_exceeded workspace uses 70 bytes; quota is 1 MB
POST /workspace {id, tier:"t1", quotaMb:200} -> 200 (new token; the old one is invalid)
write after raise -> 200 {'path':'/workspace/small.txt','bytes':2}
removed routes (/workspace/info, /git/fetch, /fs/list) -> 404
```

The old token is invalidated by the rotate; the Worker's 401 re-handshake is
what recovers it.

## Reproduce

The isolated app and commands are described at the top of this file. The
workspace root, box id, and daemon URL are environment-driven:

```sh
npm run dev -- --port 9886 --no-watch
npm run dev -- --clean           # wipe .celld/dev, .celld/workspaces, .celld/box-id
FLEET_EXECUTOR_URL=http://127.0.0.1:9877 npm run box
```


## 11. Final fresh-app run (final code)

The proofs above were captured while the PR was being built. After the last
hardening pass (`O_NOFOLLOW` parent re-check, `.fleet-workspace` reservation,
`--as-pid-1`, `shell_unavailable` wording), a fresh isolated app was run again.

t1, write and run:

```text
Created `/workspace/hello.ts` with:
console.log("hello from the final box");

Output from `node /workspace/hello.ts`:
hello from the final box
```

t1, clone, test, fix, rerun:

```text
Cloned via `git_clone`, ran `npm test` with offline bash, fixed the bug, and
reran to green.

Bug: in `src/orders.js` the loop was `for (let i = 1; ...)` skipping the first
item. Fixed to `for (let i = 0; ...)`.

Final `npm test` output:
✔ single item total (no tax) (0.566608ms)
✔ multi-item total with tax (0.116489ms)
✔ empty order totals zero (0.088103ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

t0, clone/read/edit/status:

```text
Cloned `https://github.com/thesved/fixture-orders-api.git` to `/workspace/fixture-orders-api`.

Read `src/orders.js` and fixed the off-by-one loop:
Before: for (let i = 1; i < items.length; i++) {
After:  for (let i = 0; i < items.length; i++) {

`git_status` for `fixture-orders-api` shows:
M src/orders.js

No bash used.
```

Final daemon checks on the same code:

```text
write                                   (200) {"path":"/workspace/inside.txt","bytes":7}
symlink inside read                     (200) {"text":"inside\n"}
symlink outside read                    (400) path_escape  symlink escapes the workspace
symlink outside write                   (400) path_escape  symlink escapes the workspace
marker write                            (400) reserved_path  .fleet-workspace is managed by the box
traversal ../../etc/passwd              (400) path_escape  path escapes the workspace
exec sleep 60, timeoutMs 1000            (200) timedOut true, exitCode 128, elapsed 1.01s
/proc/1/cmdline                         /usr/bin/bash -lc cat /proc/1/cmdline ...
t0 exec                                 (403) shell_unavailable
reset                                   (200) {"reset":true,"deleted":true}
```
