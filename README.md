# fleet-base

**Self-hosted agents that outlive your laptop.**

Demos: [fresh boot + health](docs/demo/fresh-boot.gif) · [kill -9 resume](docs/demo/kill-9-resume.gif) · [second terminal prompt](docs/demo/second-terminal.gif)

A stateless Worker forgets the run between requests. A chat UI such as OpenWebUI
remembers the conversation, not the in-flight run. fleet-base keeps the run in a
SQLite-backed Durable Object: kill the process mid-prompt, restart, re-POST the
same `requestId`, and it resumes from the checkpoint.

## 30-second proof

From a fresh clone (Linux, Node 22.19+, `celld` and `esbuild` on `PATH`):

```sh
git clone https://github.com/amangupta20/fleet-base.git
cd fleet-base
npm install
cp .env.example .dev.vars   # add one provider, see Configuration
npm run dev                 # http://127.0.0.1:9876
```

In a second shell:

```sh
curl -s localhost:9876/health
# ok

curl -s -X POST localhost:9876/agent/test/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Reply with exactly: fleet is alive","requestId":"req-readme-v010"}'
# {"text":"fleet is alive","submissionId":"req-readme-v010","operationId":"req-readme-v010","status":"done","reason":null}
```

That is a real response from a local run. The output is pasted exactly. The
`submissionId` and `operationId` are the same value: the durable handle you
re-POST after a crash.

## Tradeoffs

- **No auth.** Every route is unauthenticated. Bind it to localhost or put it
  behind your own proxy. Do not expose it to the internet.
- **One Worker, two Durable Objects, one box helper.** No containers, KV, D1,
  queues, or second storage system. `npm run dev` also starts a loopback box
  executor (`scripts/box.mjs`) because celld's V8 isolate cannot write host
  files or spawn processes. It is a local helper, not a container platform.
- **Files are scratch, transcripts are durable.** The transcript lives in the
  agent's SQLite Durable Object. Files live in `.celld/workspaces/<id>/` on the
  box. Move the agent to another box and its files are gone until PR2 adds a
  snapshot and a pointer; the agent is told to say so, not to invent contents.
- **Tier t0 is file-only; tier t1 adds bash.** t0 supports read/write/edit,
  `git_clone`, and `git_status`. t1 runs commands under `bwrap` on Linux.
  Without `bwrap`, the fs routes still work; git and exec fail closed with
  `shell_unavailable` (git runs a process, so it is not run unsandboxed).
- **Local-only by default.** `celld dev` writes to `.celld/dev/`; workspaces
  are under `.celld/workspaces/`. The box binds `127.0.0.1` and uses one random
  token per workspace. There is still no auth on the Worker itself; keep it on
  loopback or put it behind your own proxy.

The rest of this README assumes you want the smallest working base and will add
your own surface. The demo GIFs are terminal recordings of this API
([notes](docs/demo/README.md)).

---

## Table of contents

- [30-second proof](#30-second-proof)
- [Tradeoffs](#tradeoffs)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Idempotency and crash resume](#idempotency-and-crash-resume)
- [Tools — the proof-of-loop](#tools--the-proof-of-loop)
- [Working files — the box executor](#working-files--the-box-executor)
- [Tiers, quotas, and config](#tiers-quotas-and-config)
- [Security and the jail](#security-and-the-jail)
- [Durable vs scratch](#durable-vs-scratch)
- [Project structure](#project-structure)
- [Adding your own tool](#adding-your-own-tool)
- [Adding more agents / bindings](#adding-more-agents--bindings)
- [Bucket / fleet deploy (documented only)](#bucket--fleet-deploy-documented-only)
- [Troubleshooting](#troubleshooting)
- [Roadmap — not implemented yet](#roadmap--not-implemented-yet)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

```
curl POST /agent/:name/prompt
  └─> Worker `fetch()` (src/index.ts)
        ├─> GET /health → "ok"
        ├─> GET /models → catalog + live router ids + env status (no DO needed)
        ├─> GET /agents → REGISTRY Durable Object stub (names + activity only)
        ├─> POST /agent/:name/prompt → ASSISTANT Durable Object stub
        │     └─> Assistant.ask(prompt, requestId, model?)
        │           └─> PiHarness.prompt(prompt, { operationId })
        │                 ├─> pi-ai models (own router, opencode-go, OpenAI, Gemini)
        │                 ├─> pi-durable registry (echo + read/write/edit/bash + git)
        │                 ├─> DaemonEnv (src/box-env.ts) ── HTTP ──> box daemon (127.0.0.1:9877)
        │                 │                                      └─> .celld/workspaces/<id>/
        │                 └─> SQLite checkpoint (resume after crash)
        └─> GET /agent/:name/state → { name, resident, workspace }
```

Key pieces:

| Piece | What it does | Where |
|---|---|---|
| **Worker** | Routes HTTP to Durable Objects | `src/index.ts` default export `fetch()` |
| **Assistant DO** | One SQLite-backed Durable Object per `:name`, via `agents` SDK `Agent` class | `src/index.ts` `export class Assistant` |
| **Registry DO** | One plain `DurableObject` (no model) indexing agent names, last-active time, and prompt counts | `src/index.ts` `export class Registry` |
| **PiHarness** | Lifecycle wrapper that opens a `pi-durable` `Harness` per DO (models + tool registry + storage) | `Assistant.harness` |
| **Models** | `pi-ai` `createModels()` with four providers: own OpenAI-compatible router (`router`), OpenCode Go (`opencode-go`), OpenAI, Google — auth read from Worker env | `buildModels()` in [src/index.ts](src/index.ts) |
| **Tool registry** | `echo` plus the coding bundle: `read`, `write`, `edit`, `bash`, `git_clone`, `git_status` | `echoTool`, `codingExtension` |
| **Box executor** | Loopback Node daemon that owns per-conversation workspaces, checks paths, and runs t1 commands under `bwrap` | `scripts/box.mjs` |
| **DaemonEnv** | pi-durable `ExecutionEnv` implemented as authenticated HTTP calls to the box | `src/box-env.ts` |
| **Dev supervisor** | Starts the box and `celld dev` together, forwards SIGINT, stops both | `scripts/dev.mjs` |
| **Wrangler** | Minimal bindings: `ASSISTANT` → `Assistant`, `REGISTRY` → `Registry`; `v1`/`v2` SQLite migrations | `wrangler.jsonc` |
| **celld** | Local runtime that emulates Workers + Durable Objects; persists to `.celld/dev/` | `npm run dev` → `scripts/dev.mjs` |

The `:name` in `/agent/:name/prompt` is the Durable Object name (`getByName`). `POST /agent/test/prompt` and `POST /agent/alice/prompt` are different persistent agents with separate SQLite state.

---

## Prerequisites

- **Linux** (celld targets Linux)
- **Node.js 22.19+** — check with `node --version` (this repo tested on Node 26)
- **celld** binary on `PATH` — local Workers + DO runtime ([denoland/celld](https://github.com/denoland/celld))
- **esbuild** on `PATH` (or `CELLD_ESBUILD` pointing at it) — `celld dev` and `celld deploy` use it to bundle `src/index.ts`
- **bwrap** (`bubblewrap`) at `/usr/bin/bwrap` for tier t1 commands. t0 file and git routes work without it; t1 reports `shell_unavailable`.
- **A model provider — one of:** your own OpenAI-compatible router (Ollama, LiteLLM, vLLM, LM Studio, own gateway — keyless OK), OpenCode Go (`OPENCODE_API_KEY`), OpenAI, or Gemini

Install Node dependencies:

```sh
npm install
```

> `celld` and `esbuild` are host binaries, not npm deps — install them separately and verify with `celld --version` / `esbuild --version`.

---

## Quickstart

1. **Clone and install**

   ```sh
   git clone https://github.com/amangupta20/fleet-base.git
   cd fleet-base
   npm install
   ```

2. **Configure a provider**

   ```sh
   cp .env.example .dev.vars
   # then edit .dev.vars — pick ONE path (or combine):
   #
   # Own router (e.g. local Ollama, keyless):
   #   ROUTER_BASE_URL=http://localhost:11434/v1
   #   ROUTER_MODEL=llama-3.1-8b
   #
   # Own router with a key (e.g. LiteLLM gateway):
   #   ROUTER_BASE_URL=http://192.168.1.10:4000/v1
   #   ROUTER_API_KEY=sk-...
   #   ROUTER_MODEL=my-model
   #
   # OpenCode Go hosted inference:
   #   OPENCODE_API_KEY=...
   #   OPENCODE_MODEL=qwen3.8-flash   # optional; else catalog default
   #
   # Or the big APIs:
   #   OPENAI_API_KEY=sk-...
   #   GEMINI_API_KEY=...
   ```

   `GET /models` (below) shows the live catalog so you can fetch-then-choose without guessing ids.

   `celld dev` reads `.dev.vars` next to the Wrangler config, falling back to `.env` then `.env.local` (`.env.local` overrides `.env`). `celld deploy` does **not** read these files.

3. **Run locally**

   ```sh
   npm run dev
   # starts the box executor on http://127.0.0.1:9877
   # and celld dev on       http://127.0.0.1:9876
   ```

   `scripts/dev.mjs` supervises both and forwards `SIGINT`: one Ctrl-C stops
   both. To run the pieces separately, use `npm run box` in one shell and
   `celld dev` in another. To start with empty state:

   ```sh
   npm run dev -- --clean
   # removes .celld/dev, .celld/workspaces, and .celld/box-id
   ```

   `celld dev --clean` alone only wipes the transcript store; it leaves
   workspaces and the box id. State persists in `.celld/dev/` and
   `.celld/workspaces/` across restarts.

4. **Health check**

   ```sh
   curl localhost:9876/health
   # -> ok
   ```

5. **First prompt**

   ```sh
   curl -X POST localhost:9876/agent/test/prompt \
     -H 'content-type: application/json' \
     -d '{"prompt":"say hi"}'
   # -> {"text":"...","submissionId":"...","operationId":"...","status":"done"}
   ```

   With a provider key set, the response contains `text` plus `submissionId`/`operationId`. If the model calls the `echo` tool, that proves the model → tool → transcript loop works.

6. **Let it touch files**

   t0 (the default) can read, write, edit, and clone; t1 also runs bash:

   ```sh
   curl -X POST localhost:9876/agent/test/config \
     -H 'content-type: application/json' \
     -d '{"sandbox":"t1"}'
   # -> {"name":"test","sandbox":"t1","quotaMb":200}

   curl -X POST localhost:9876/agent/test/prompt \
     -H 'content-type: application/json' \
     -d '{"prompt":"Write hello.ts that prints hello from the box, then run it with node and show the output."}'
   ```

   Files land in `.celld/workspaces/<id>/` on this box. The transcript stays in
   SQLite. See [Working files](#working-files--the-box-executor).

---

## Configuration

### Env vars (`.dev.vars` for local)

| Var | Needed for `celld dev`? | Purpose |
|---|---|---|
| `ROUTER_BASE_URL` | Yes, for own-router path (defaults to Ollama `http://localhost:11434/v1` when `ROUTER_MODEL` is set) | Your gateway's OpenAI-compatible base URL |
| `ROUTER_API_KEY` | Only if your router needs one (empty = keyless, e.g. Ollama) | Bearer key sent to the router |
| `ROUTER_MODEL` | Yes, for own-router path — wins as the default model | Default model id on the router (e.g. `llama-3.1-8b`) |
| `ROUTER_EXTRA_MODELS` | No | Comma-separated extra router ids to pre-register for per-request `model` use |
| `OPENCODE_API_KEY` | Yes, for opencode-go path | OpenCode Go hosted inference key |
| `OPENCODE_MODEL` | No (defaults to catalog's first model) | Pins the opencode-go default model |
| `OPENAI_API_KEY` | Yes, for OpenAI path (unless another provider is set) | Pi OpenAI provider (`gpt-5-mini` default) |
| `GEMINI_API_KEY` | Yes, for Gemini path (unless another provider is set) | Pi Google provider (`gemini-2.5-flash` default) |
| `FLEET_EXECUTOR_URL` | No (default `http://127.0.0.1:9877`) | Loopback URL of the box executor. Set the same value in the shell when running the daemon on another port. Loopback only. |
| `CELLD_BUCKET` | No (local uses on-disk store) | S3-compatible bucket, e.g. `s3://my-fleet` — bucket/fleet deploys only |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | No | Bucket credentials — deploys only |
| `AWS_REGION` | No | e.g. `auto` for R2 — deploys only |
| `S3_ENDPOINT` | No | e.g. `https://ACCOUNT_ID.r2.cloudflarestorage.com` — deploys only |

See [.env.example](.env.example) — copy it to `.dev.vars` and configure one provider path. Never commit `.dev.vars` / `.env` (already in [.gitignore](.gitignore)).

### Model selection

`resolveDefaultModel()` in [src/index.ts](src/index.ts) picks the default fresh sessions start with, first hit wins:

1. `ROUTER_MODEL` set → `{ provider: "router", id: ROUTER_MODEL }`
2. `OPENCODE_API_KEY` + `OPENCODE_MODEL` set → `{ provider: "opencode-go", id: OPENCODE_MODEL }`
3. `OPENAI_API_KEY` set → `{ provider: "openai", id: "gpt-5-mini" }`
4. `GEMINI_API_KEY` set → `{ provider: "google", id: "gemini-2.5-flash" }`
5. `OPENCODE_API_KEY` set → `{ provider: "opencode-go", id: OPENCODE_MODEL or catalog default }`
6. `ROUTER_BASE_URL` set → `{ provider: "router", id: ROUTER_MODEL or llama-3.1-8b }`
7. else throws — the Worker returns HTTP 500 listing the options.

So: set `ROUTER_MODEL` and your router wins; set only `OPENCODE_API_KEY` and opencode-go wins. Nothing is required from OpenAI/Gemini.

Three ways to choose a model beyond the default (env var **or** fetch-and-choose):

- **Env var:** `ROUTER_MODEL` / `ROUTER_EXTRA_MODELS` / `OPENCODE_MODEL` in `.dev.vars` (`celld dev` rebuilds on config change).
- **Fetch:** `GET /models` returns the static catalog, per-provider `configured` flags, the resolved `default`, and live ids fetched from your router's `/models` endpoint (`router.live`, `null` when unreachable).
- **Per-request override:** `POST /agent/:name/prompt` accepts `model` as `"provider/id"` or `{"provider","id"}`. The agent is session-pinned to it until changed (the pin survives eviction/restarts). Unknown ids return HTTP 400 with a pointer to `GET /models`. Router ids must be pre-registered via `ROUTER_MODEL`/`ROUTER_EXTRA_MODELS` (pi resolves the session model against the static catalog).
- **Stale-pin healing:** sessions durably remember their model, so an agent created under an old default would keep using a dead provider. On each prompt without an explicit `model`, the Worker compares against the current env default and re-pins only when it moved — intentional pins are never clobbered.

```sh
curl localhost:9876/models | python3 -m json.tool | head -n 40
curl -X POST localhost:9876/agent/test/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"say hi","model":"opencode-go/qwen3.8-flash"}'
```

The harness factory re-checks configuration at runtime so misconfiguration fails loudly instead of silently falling back.

### Wrangler ([wrangler.jsonc](wrangler.jsonc))

```jsonc
{
  "name": "fleet",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-19",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "ASSISTANT", "class_name": "Assistant" },
      { "name": "REGISTRY", "class_name": "Registry" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Assistant"] },
    { "tag": "v2", "new_sqlite_classes": ["Registry"] }
  ]
}
```

Deliberately minimal — no `containers[]`, no R2/KV/D1/queues/workflows. Add bindings here as your fleet grows.

---

## API reference

### `GET /health`

Returns `ok` (`text/plain`). Use for readiness probes.

```sh
curl localhost:9876/health
```

### `GET /models`

Fetch-then-choose: static catalog across all four providers (no DO activation), which providers are configured from env, the resolved default, and live ids from your router's OpenAI-compatible `/models` endpoint.

```sh
curl localhost:9876/models
# -> {
#   "default": { "provider": "router", "id": "llama-3.1-8b" },
#   "configured": { "router": true, "opencode-go": false, "openai": false, "google": false },
#   "catalog": [ { "provider": "router", "id": "...", "name": "...", "contextWindow": 1048576, "maxTokens": 131072 }, ... ],
#   "router": { "baseUrl": "http://localhost:11434/v1", "live": ["llama-3.1-8b", ...] }
# }
```

`router.live` is `null` when the router is unreachable — the static catalog still lists pre-registered ids.

### `GET /agents`

List known agent names, most recently active first. `limit` defaults to 100 and is clamped to 1–1000; `prefix` filters names that start with it.

```sh
curl 'localhost:9876/agents?limit=50&prefix=a'
# -> {"agents":[{"name":"alice","lastActive":"2026-10-20T06:41:12.345Z","prompts":3}],"count":1}
```

The registry stores **names, timestamps, and prompt counts only — never prompt text or transcripts**. It is one plain `Registry` Durable Object in the same fleet/bucket as the agents, so every browser sees the same list instead of a per-browser `localStorage` list. Activity moves on prompt POSTs only: `/messages`, `/state`, and `/reset` do not touch it, and reset keeps the entry. Bookkeeping is best-effort — if the registry fails, the prompt still runs. A re-POST with the same `requestId` is idempotent for the run but still bumps `prompts` by one, because touch runs once per accepted prompt POST, not per unique submission; a POST rejected for an unknown or malformed model never reaches the touch. Storage/binding errors return `500`; this route never returns `404`.

### `POST /agent/:name/prompt`

Run a prompt on the named agent. Body must be JSON with a non-empty `prompt` string. Optional `requestId` (alias `operationId`) for idempotency, and optional `model` (`"provider/id"` or `{"provider","id"}`) to pin this agent's session to another model.

```sh
curl -X POST localhost:9876/agent/alice/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"echo hello back to me","requestId":"req-123","model":"router/llama-3.1-8b"}'
```

Response:

```json
{
  "text": "...",
  "submissionId": "...",
  "operationId": "...",
  "status": "done",
  "reason": null
}
```

| Field | Meaning |
|---|---|
| `text` | Final model text (`""` when `unanswered`) |
| `submissionId` / `operationId` | Same value — the durable run id (idempotency key) |
| `status` | `done` (answered) or `unanswered` (failed, aborted, withdrawn) |
| `reason` | pi's own words for why an `unanswered` run ended; `null` on `done` — read this first when debugging |

Errors:

| Status | When |
|---|---|
| `400` | Invalid JSON body, `body.prompt` missing/empty, or unknown/malformed `body.model` |
| `500` | No provider configured (none of router / opencode-go / OpenAI / Gemini set) |
| `404` | Any other path/method |

### `GET /agent/:name/state`

```sh
curl localhost:9876/agent/alice/state
# -> {"name":"alice","resident":true,"workspace":"<durable-object-id>-1"}
```

Best-effort and deliberately coarse: if the route is reachable, the binding is
addressable and celld activates the cell on demand. It returns the deterministic
workspace id; it never returns the token. Tier and quota are returned by
`POST /config`. The workspace id is stable across a migration, but the files
behind it are not; the prompt section carries the loss warning.

### `GET /agent/:name/messages`

Transcript tail for debugging — pi records generation failures here, so a terse `"reason": "model_error"` can be traced to the underlying message.

```sh
curl 'localhost:9876/agent/test/messages?limit=10'
# -> {"name":"test","messages":[{"id":"...","kind":"...","preview":"..."}, ...]}
```

`limit` defaults to 20, capped at 100. Each entry is `{id, kind, preview}` (preview truncated at 800 chars).

### `POST /agent/:name/config`

Set the workspace tier and/or quota for the **root** conversation. This is app
config stored in DO SQLite next to pi's documents; it is not part of `pi.agent`.
`t0` is files and git only, `t1` adds bash. The default quota is 200 MB.

```sh
curl -X POST localhost:9876/agent/test/config \
  -H 'content-type: application/json' \
  -d '{"sandbox":"t1"}'
# -> {"name":"test","sandbox":"t1","quotaMb":200}

curl -X POST localhost:9876/agent/test/config \
  -H 'content-type: application/json' \
  -d '{"quotaMb":50}'
# -> {"name":"test","sandbox":"t1","quotaMb":50}
```

Either field may be omitted; omitted fields keep their stored value. Bad tiers,
non-integer quotas, or a quota outside 1–4096 return `400`. Changing the tier
does not create a workspace; the next tool call does. It also invalidates the
in-memory token binding and, when a workspace already exists, rotates the token.

### `POST /agent/:name/reset`

Start a new context for the agent and delete the local workspace. `GET /messages`
returns a `pi.reset` entry, not the prior messages; the `/agents` entry (name,
`lastActive`, `prompts`) is kept, and older transcript rows may remain in storage.
The box daemon kills any running command for that workspace, then removes
`.celld/workspaces/<id>/` and its `index.json` entry. The transcript reset is
durable; the files are not. The next prompt starts a fresh workspace with the
same tier/quota. Reset is idempotent: a second call has no workspace to delete.

```sh
curl -X POST localhost:9876/agent/test/reset
# -> {"name":"test","reset":true,"workspaceDeleted":true}
```

If the daemon is down, the transcript still resets and `workspaceDeleted` is
`false`; the workspace record stays so a later reset can delete the files.

---

## Idempotency and crash resume

`operationId` is the idempotency key; `requestId` is accepted as an alias. Two POSTs with the same id run once:

```sh
RID="req-$(date +%s)"
curl -X POST localhost:9876/agent/test/prompt \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"say hi\",\"requestId\":\"$RID\"}"
curl -X POST localhost:9876/agent/test/prompt \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"say hi\",\"requestId\":\"$RID\"}"
# Both responses share submissionId/operationId; the second
# returns without starting a second run.
```

Crash resume: start a prompt, `kill -9` the celld process mid-run, restart with `celld dev`, then re-POST with the same `requestId`. `harness.resume()` continues the same submission from its SQLite checkpoint instead of starting over.

How it maps to code ([src/index.ts](src/index.ts) `Assistant.ask`):

```ts
async ask(prompt, requestIdOrOptions) {
  const operationId = typeof requestIdOrOptions === "string"
    ? requestIdOrOptions
    : (requestIdOrOptions?.operationId ?? requestIdOrOptions?.requestId);
  const res = await this.harness.prompt(
    prompt,
    operationId ? { operationId } : undefined,
  );
  // ... return { text, submissionId, operationId, status }
}
```

---

## Tools — the proof-of-loop

The registry has two extensions: the `echo` proof-of-loop, and the coding
bundle.

```ts
const echoTool = defineTool({
  name: "echo",
  description: "Echo back the given text. Proves the tool loop works.",
  parameters: Type.Object({ text: Type.String() }),
  replay: "safe",
  async execute({ text }) {
    return { output: [{ type: "text", text }] };
  },
});
```

| Tool | Replay | What it does |
|---|---|---|
| `echo` | safe | Echo text; proves the loop |
| `read` | safe | Read a text or image file under `/workspace` |
| `write` | unsafe | Create/overwrite a file |
| `edit` | unsafe | Exact-text replacement, returns a diff |
| `bash` | unsafe | Run a shell command in tier t1 (120 s cap) |
| `git_clone` | unsafe | Clone an `https://` repo into `/workspace` (300 s cap) |
| `git_status` | safe | `git status --porcelain=v1` for a workspace repo |

`read` is the only coding tool marked safe: a crash may rerun it, and reading
twice changes nothing. `write`, `edit`, `bash`, and `git_clone` are unsafe. pi
commits their intent before running them, so after a crash it reports an
`interrupted` result instead of rerunning them. That is deliberate: a rerun
could append a second line, apply an edit twice, run a command twice, or leave
a partial clone. The model may retry them in a later turn; it will see the
interruption and the partial state.

Ask the model to echo something (`"use the echo tool to echo 'hello'"`). If the
transcript shows the tool call and its output in the final text, your model →
tool → transcript path works.

---

## Working files — the box executor

celld runs the Worker in a V8 isolate. It cannot write host files or spawn
processes:

```text
node:fs.writeFileSync      -> node:fs.writeFileSync is not implemented in celld
node:fs.readdirSync('/')   -> ENOENT: open '/'
node:child_process.spawn   -> node:child_process.spawn is not implemented in celld
process.cwd()              -> "/"
process.env                -> {}
```

So `npm run dev` starts one more local process: a loopback box executor
(`scripts/box.mjs`, `127.0.0.1:9877`). The Worker's `DaemonEnv`
(`src/box-env.ts`) implements pi-durable's `ExecutionEnv` as authenticated
HTTP calls. It is still one deployable Worker; the box is a single-box helper,
not a container platform or a second storage system.

```text
celld Worker (V8)                          box daemon (Node, loopback)
  Assistant DO                               .celld/workspaces/<id>/
    DaemonEnv  ───────────────────────────►  /fs/*   resolve + prefix + lstat/realpath + O_NOFOLLOW
      read / write / edit                    /git/*  git in the bwrap jail
      bash / git_clone / git_status          /exec   bwrap + cleared env + timeout
    transcript in DO SQLite                  token hash in index.json
```

The workspace id is `<durable-object-id>-<conversationId>`. Conversation ids
are only unique inside one DO, so including the DO id keeps two agents from
sharing a directory. The id is deterministic and visible in `GET /state`; the
token is never returned there.

### Code entry

Two paths work:

1. **Paste it into the prompt.** The model calls `write` (and `edit`) to create
   files. This works in t0 and t1.
2. **`git clone`.** Use the `git_clone` tool in t0 or t1 (or
   `POST /git/clone` on the box). Bash is offline, so it cannot reach the
   network; `git_clone` runs its fixed `https://` clone with network on. Local
   paths, `file://`, `ext::`, plain `http://`, private addresses, and loopback
   are rejected. `git_clone` is `--depth 1`, `GIT_ALLOW_PROTOCOL=https`,
   `GIT_TERMINAL_PROMPT=0`, and has `--` before the URL.

Both are documented in the [E2E proofs](docs/e2e-workspaces.md).

### Environment allowlist

A t1 command gets a cleared environment with exactly these values:

```text
PATH=/usr/bin:/bin
HOME=/workspace
LANG=C.UTF-8
```

bash adds `PWD`, `SHLVL`, and `_`; the probe output is in the
[E2E proofs](docs/e2e-workspaces.md). There is no inherited environment:
`FLEET_API_KEY`, `OVH_*`, `AWS_*`, `S3_*`, `CELLD_*`, `ROUTER_*`, and
`.dev.vars` values are not present. `printenv | grep -Ei
'FLEET|AWS|S3|CELLD|KEY|TOKEN'` prints nothing.

### What runs a command

t1 uses this exact `bwrap` shape:

```sh
bwrap --ro-bind /usr /usr \
  --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib /lib64 \
  --bind "$WORKSPACE" /workspace \
  --tmpfs /tmp --proc /proc --dev /dev \
  --unshare-all --die-with-parent --new-session --as-pid-1 \
  --clearenv \
  --setenv PATH /usr/bin:/bin --setenv HOME /workspace --setenv LANG C.UTF-8 \
  --chdir /workspace \
  -- /usr/bin/bash -lc "$COMMAND"
```

Only an `/exec` call with `net:true` adds `--share-net` and read-only binds for
`resolv.conf`, `hosts`, `nsswitch.conf`, `ssl`, and `ca-certificates`; otherwise
the network namespace is unshared. The `bash` tool never sets `net`, so agent
bash is offline; `git_clone` uses the separate `/git/clone` route with network
on for its validated public URL. The
`--as-pid-1` keeps bwrap's own argv (including the host workspace path) out of
`/proc/1/cmdline`; `/proc/1/environ` shows only the cleared env. `/etc/shadow`,
`/home`, `~/.ssh`, and host absolute paths do not exist inside. `sudo` fails
because bwrap sets no-new-privileges.

### Limits

- **Command timeout:** 120 s default/hard cap (`FLEET_EXEC_TIMEOUT_MS`).
- **Clone timeout:** 300 s default (`FLEET_CLONE_TIMEOUT_MS`).
- **Output:** 10 MB retained (byte-counted); larger output is truncated and,
  past the bash tool's spill threshold, spilling is reported.
- **File size:** 11 MiB (leaves headroom for base64 inflation inside the 16 MB
  JSON body); reads of larger files are rejected.
- **Quota:** 200 MB per workspace by default, checked on write and clone;
  `POST /agent/:name/config {"quotaMb":50}` lowers it; `/config` returns the
  stored value. A write or clone that would cross it returns `quota_exceeded`.
- **Path jail:** every `/fs/*` path is mapped to the workspace with
  `path.resolve(workspace, target)`, rejected unless it is the workspace or
  starts with `workspace + path.sep`, checked component by component with
  `lstat`/`realpath`, and opened with `O_NOFOLLOW` after `realpath(dirname)`.

---

## Tiers, quotas, and config

| Tier | read/write/edit | `git_clone` / `git_status` | `bash` |
|---|---|---|---|
| `t0` (default) | yes | yes | `shell_unavailable` |
| `t1` | yes | yes | yes, under bwrap |

Tier and quota are app config stored in DO SQLite under
`fleet:sandboxTier:v1:<conversationId>` and
`fleet:sandboxQuota:v1:<conversationId>`, next to pi's documents. `pi.agent`
has no extension point for application fields, so this is deliberately a
separate key, not a fake `pi.agent` field. Set it with `POST /config`:

```sh
curl -X POST localhost:9876/agent/test/config -d '{"sandbox":"t1"}'
curl -X POST localhost:9876/agent/test/config -d '{"quotaMb":50}'
```

A t0 agent that calls `bash` gets a `shell_unavailable` tool error and keeps
going; it does not hang. Changing the tier takes effect on the next env build
(the next tool call or request), not retroactively inside a running call.

---

## Security and the jail

The box is a local trust boundary, not a multi-tenant hard boundary.

- **Loopback only, token per workspace.** The daemon binds `127.0.0.1`; every
  route except `GET /health` and the enrollment `POST /workspace` needs
  `Authorization: Bearer <token>` and `X-Fleet-Workspace: <id>`. The daemon
  stores SHA-256 hashes in `.celld/workspaces/index.json`, not plaintext. The
  Worker stores the plaintext in DO SQLite and re-handshakes once on a 401.
- **No CORS.** The daemon never emits `Access-Control-Allow-*`; a browser page
  cannot call it with a cross-origin `fetch` and a JSON content type.
- **Path and symlink checks** as described above. A symlink inside the
  workspace is allowed only if its real target stays inside; an escaping link
  is rejected before a missing file below it is created.
- **Command separation.** t1 commands see only `/usr`, `/bin`, `/lib`,
  `/lib64`, the workspace, `/tmp`, `/proc`, and `/dev`. They run with a
  cleared env, no-new-privileges, and no host `/home`. Network commands bind
  only `/etc/resolv.conf`, `/etc/hosts`, `/etc/nsswitch.conf`, `/etc/ssl`, and
  `/etc/ca-certificates`; no other host `/etc` path exists.
- **Git gates.** Only `https://`; no credentials in the URL; private, loopback,
  link-local, and `.local` hosts are rejected; DNS is resolved and checked for
  private addresses; `GIT_ALLOW_PROTOCOL=https` blocks `file://`/`ext::`;
  `--` precedes the URL. Git re-resolves at connect time, so a deliberate
  rebinding race is outside this local trust boundary.
- **Reset kills first.** `POST /reset` asks the daemon to kill running commands
  for that workspace, then deletes the directory and token entry. The
  transcript reset is separate and durable.

Limits worth stating plainly:

- The Worker itself has no auth (see Tradeoffs). Keep it on loopback. A local
  process that can reach the box can call `POST /workspace` and rotate a token;
  this is the same local trust level as the unauthenticated Worker.
- bwrap is a sandbox, not a VM. A kernel/bwrap escape gets the daemon's user
  (usually you). The path checks are TOCTOU-hardened with `realpath(dirname)`
  plus `O_NOFOLLOW`, not a proof against a hostile local process racing the
  daemon.
- The sandbox can read `/proc` for its own namespace, including the command it
  was asked to run. It cannot read host `/proc` (PID namespace is unshared).
- Files are not encrypted and not snapshotted. Reset and migration delete (or
  park) them.

---

## Durable vs scratch

| Thing | Where | Survives a process crash? | Survives moving to another box? |
|---|---|---|---|
| Transcript, tool results, model pin | DO SQLite (`.celld/dev/`) | yes | yes — SQLite moves with the DO |
| Workspace files | `.celld/workspaces/<id>/` on the box | yes, if the directory is on disk | **no** until PR2 |

Each workspace has a `.fleet-workspace` marker with `{id, boxId, createdAt}`.
If the daemon starts with a different `boxId` (a different box, or a deliberate
E2E restart), it parks the old directory as `<id>.lost-<timestamp>` and starts
an empty one. The Worker stores the previous `boxId`, and the prompt's
`<workspace>` section tells the model: the previous workspace was on box X and
is gone; do not claim a file exists without a read/stat/list. The E2E transcript
shows the agent saying exactly that.

PR2 will snapshot the directory (and/or archive it to bucket storage) and leave
a pointer in the workspace record. PR1 deliberately does not sync, upload, or
archive anything.

---

## Project structure

```
fleet-base/
├── src/
│   ├── index.ts              # Worker routes + Assistant/Registry DOs + tools + model wiring
│   └── box-env.ts            # pi-durable ExecutionEnv over the loopback box
├── scripts/
│   ├── box.mjs               # loopback workspace executor (fs/git/exec)
│   ├── dev.mjs               # starts box + celld, forwards SIGINT
│   └── deploy.mjs            # bucket deploy with vars injection
├── wrangler.jsonc            # Worker name, entry, DO bindings, SQLite migrations
├── package.json              # npm scripts (dev → dev.mjs, box → box.mjs)
├── .env.example              # Copy to .dev.vars; one provider key + executor URL
├── docs/
│   ├── specs/workspaces-pr1.md
│   └── e2e-workspaces.md     # pasted E2E transcripts
├── deploy/
│   ├── fleet.service         # systemd unit for a fleet node (bucket deploys)
│   └── celld.env             # Non-default celld tuning (leases, polling, GC, caps)
├── .celld/
│   ├── dev/                  # local celld state (git-ignored)
│   ├── workspaces/           # box files + index.json (git-ignored)
│   └── box-id                # stable box identity for loss detection
└── README.md / LICENSE
```

## Adding your own tool

1. Define it next to `echoTool` in [src/index.ts](src/index.ts):

   ```ts
   const upperTool = defineTool({
     name: "upper",
     description: "Uppercase the given text.",
     parameters: Type.Object({ text: Type.String() }),
     replay: "safe", // use "unsafe" if it has side effects
     async execute({ text }) {
       return { output: [{ type: "text", text: text.toUpperCase() }] };
     },
   });
   ```

2. Register it in the extension that fits:

   ```ts
   this.registry.install({ name: "fleet-base", tools: [echoTool, upperTool] });
   // or add it to codingExtension's tools list
   ```

3. Restart `npm run dev` and prompt: `"use the upper tool on 'hello'"`.

Tips:

- `replay: "safe"` tools re-run freely on resume. Side-effecting tools (send email, write DB, write a file, run a command) are `replay: "unsafe"`: after a crash pi reports `interrupted` instead of rerunning them. Check `pi-durable` docs for `replay` semantics before marking anything safe.
- A tool that needs the box can use `api.env`; it is a
  [`DaemonEnv`](src/box-env.ts) in this repo and exposes
  `request(route, body)` for the authenticated daemon routes.
- Keep tool `name` + `description` precise — that's what the model sees when deciding to call it.
- Validate `parameters` with `Type.*` (from `@earendil-works/pi-ai`) so bad model args fail early.

---

## Adding more agents / bindings

- **More agents:** no code change — `POST /agent/<any-name>/prompt` creates/address a DO by name. Use one name per user, per repo, per employee, etc. Each name shows up in `GET /agents` after its first prompt.
- **More bindings:** add to `wrangler.jsonc` (R2, KV, D1, queues, workflows) and extend `Env` in `src/index.ts`. Keep `wrangler.jsonc` minimal until you need them — each binding is a new failure mode.
- **Workspaces:** every agent gets a per-conversation directory. The id is derived from the DO id, so adding agents needs no box config. `POST /config` sets tier/quota per agent.
- **Multi-harness / MCP / containers:** intentionally absent. Add them after the echo loop, file tools, and resume tests pass on your machine.

---

## Bucket / fleet deploy (tested single-node, systemd files included)

Local `celld dev` needs no bucket. For a real fleet node you need an S3-compatible bucket (e.g. Cloudflare R2) and the files in [deploy/](deploy/). Verified: deploy → single bucket-backed node → `/health`, `/models`, and a `done` tool-loop prompt.

**Vars and secrets without hoop-jumping:** `celld deploy` ignores `.dev.vars`/`.env` — Worker variables ship via wrangler `[vars]`, baked into the deployment, and celld has no secrets mechanism. So `npm run deploy` (→ [scripts/deploy.mjs](scripts/deploy.mjs)) does it for you: it reads provider vars from `.dev.vars` (allowlist: `ROUTER_*`, `OPENCODE_*`, `OPENAI_*`, `GEMINI_*` — bucket/CLI creds stay in your shell), merges them into a throwaway gitignored `wrangler.deploy.jsonc`, deploys, and deletes it. Extra args forward to `celld deploy`. Secrets land in the deployment objects inside your own bucket — never in git.

```sh
set -a; source .dev.vars; set +a   # S3 creds + bucket flags for the CLI
npm run deploy -- --dry-run        # bundle check only, writes nothing
npm run deploy                     # deploy with vars from .dev.vars
```

`node scripts/deploy.mjs --vars-file .env --dry-run` and `--print-config` (dumps the merged config **including secret values** — local debugging only) are available. Refuses to deploy when no provider vars are set.

Shell one-off node (skip the gate for single-node tests; `deploy/` tuning is for systemd):

```sh
CELLD_READY_FLEET_GATE_MS=0 celld \
  --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION" \
  --listen 127.0.0.1:8080 --internal-listen 127.0.0.1:8081 --advertise 127.0.0.1:8081
# Worker listener: http://127.0.0.1:8080 — same API as celld dev, fresh
# state (bucket nodes don't share .celld/dev/). Single node + default
# durability means every write waits for a bucket round-trip: slower than
# local, worse the farther the bucket. A second node settles writes
# disk-to-disk instead.
```

- [deploy/celld.env](deploy/celld.env) — agreed non-default tuning (longer leases, slower rebalance/poll/waker ticks, 7-day LTX retention, idle eviction, RSS + residency caps). Each line documents its default and tradeoff. Not used by `celld dev`.
- [deploy/fleet.service](deploy/fleet.service) — systemd unit. After deploying a new bundle, `POST /reload` on the internal listener (`127.0.0.1:8081` by default) to adopt it immediately instead of waiting `CELLD_DEPLOY_POLL_S`.
- Never expose the internal listener to the public internet — keep peer traffic on a trusted network / encrypted overlay (see comments in `fleet.service`).

**Working files on a bucket node (PR1):** the box daemon is a local process,
not an object in the bucket. Run `npm run box` (or `node scripts/box.mjs`) on
each node that should have workspaces, with `FLEET_EXECUTOR_URL` pointing at its
loopback address. The bucket moves the transcript with the DO; it does **not**
move `.celld/workspaces`. A DO that lands on another node reports the old box
and an empty workspace. Automated snapshot/pointer and multi-node placement are
PR2; do not describe this tag as giving you portable files.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `500 fleet: no model provider configured...` | `cp .env.example .dev.vars`, configure one path (router / opencode-go / OpenAI / Gemini), restart `celld dev` |
| Model answers but ignores the `echo` tool | Weaker routers/models may not tool-call reliably — try a stronger model id, check `GET /models` live ids match what the router actually serves |
| Router `fetch failed` / empty reply | Router not running or wrong `ROUTER_BASE_URL` — `curl $ROUTER_BASE_URL/models` directly; keyless servers need `ROUTER_API_KEY` empty |
| `"status":"unanswered","reason":"model_error"` against own router | The router rejected or was unreachable for the chat call. Reproduce it directly (below), then check `GET /agent/:name/messages` for pi's recorded error |
| `celld: command not found` | Install celld, ensure it's on `PATH` |
| `esbuild: command not found` / bundle error | Install esbuild or set `CELLD_ESBUILD=/path/to/esbuild` |
| Port `9876` in use | Stop the other `celld dev`, or check what's listening |
| Stale/corrupt local state | `npm run dev -- --clean` (wipes `.celld/dev/`, `.celld/workspaces/`, `.celld/box-id`) |
| `box executor is unreachable at http://127.0.0.1:9877` | Start both with `npm run dev`, or run `npm run box` beside `celld dev`. Check `curl localhost:9877/health`. |
| `shell_unavailable: exec requires tier t1` | The agent is t0. `POST /agent/:name/config {"sandbox":"t1"}` and retry. |
| `bwrap is not installed` / t1 fails, t0 works | Install `bubblewrap` at `/usr/bin/bwrap`; t0 file/git tools do not need it. |
| `bad_url: private, loopback...` or `https:// only` | `git_clone` accepts public `https://` only. Use a public repo; local paths and `file://` are rejected. |
| `token_conflict` or repeated 401s | Reset the agent (`POST /reset`) to clear the old workspace/token, then retry. |
| `quota_exceeded` | Raise `quotaMb` with `POST /config` or reset the workspace. Default is 200 MB. |
| Port `9877` in use | Stop the other box (`npm run box`/`npm run dev`) or set `FLEET_EXECUTOR_URL` in both `.dev.vars` and the shell. |
| Second POST with same `requestId` starts a new run | You changed `prompt` or agent `:name` — idempotency is per `(agent, operationId)`; also check you're sending `requestId`/`operationId` as a string |
| `wrangler` deploy errors about bindings | Keep `wrangler.jsonc` minimal; add one binding at a time |

---

## Roadmap — not implemented yet

- **PR2: workspace snapshot/archive + pointer**, so a migrated agent can recover
  its files instead of reporting them gone. No sync/upload in this tag.
- **t2: `ctx.container`** behind the same box protocol. Containers are still
  absent here; bwrap is not a container runtime.
- MCP servers
- skills
- subagents
- web tools / background command tools
- multi-harness
- UI (no Next.js/Vite/React)
- auth
- Hindsight
- queues
- paperclip bridge
- workflows, D1/KV/R2 bindings

If you build one of these on top of this base, a PR describing your approach is welcome.

---

## Contributing

Issues and PRs welcome. Keep the base minimal — prove the tool loop + resume first, then layer features. Run `npm run dev -- --clean` + the [First prompt](#quickstart), [Working files](#working-files--the-box-executor), and [Idempotency](#idempotency-and-crash-resume) checks before opening a PR. The PR1 transcripts are in [docs/e2e-workspaces.md](docs/e2e-workspaces.md).

---

## License

MIT — see [LICENSE](LICENSE).
