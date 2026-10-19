# fleet-base

Minimal, self-hosted **Durable Objects fleet** — a [Cloudflare Workers](https://workers.cloudflare.com/) app with one Durable Object agent, run locally with [`celld`](https://github.com/denoland/celld) and powered by [Pi](https://github.com/badlogic/pi-mono) models via `pi-ai` + `pi-durable`.

Use this as a **starter template** if you want to build your own self-hosted agent fleet: one Worker, one Durable Object, one model call with a tool loop, SQLite-checkpointed resume, and idempotent prompts. Everything else (containers, MCP, auth, UI, queues) is deliberately left out so you can see the smallest thing that works end-to-end.

> **Status:** local-only base. `celld dev` works. Bucket/fleet deploy files are included as documented examples but are not required to run this.

---

## Table of contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Idempotency and crash resume](#idempotency-and-crash-resume)
- [Tools — the proof-of-loop](#tools--the-proof-of-loop)
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
        ├─> POST /agent/:name/prompt → ASSISTANT Durable Object stub
        │     └─> Assistant.ask(prompt, requestId, model?)
        │           └─> PiHarness.prompt(prompt, { operationId })
        │                 ├─> pi-ai models (own router, opencode-go, OpenAI, Gemini)
        │                 ├─> pi-durable registry (tools, e.g. `echo`)
        │                 └─> SQLite checkpoint (resume after crash)
        └─> GET /agent/:name/state → { name, resident: true }
```

Key pieces:

| Piece | What it does | Where |
|---|---|---|
| **Worker** | Routes HTTP to Durable Objects | `src/index.ts` default export `fetch()` |
| **Assistant DO** | One SQLite-backed Durable Object per `:name`, via `agents` SDK `Agent` class | `src/index.ts` `export class Assistant` |
| **PiHarness** | Lifecycle wrapper that opens a `pi-durable` `Harness` per DO (models + tool registry + storage) | `Assistant.harness` |
| **Models** | `pi-ai` `createModels()` with four providers: own OpenAI-compatible router (`router`), OpenCode Go (`opencode-go`), OpenAI, Google — auth read from Worker env | `buildModels()` in [src/index.ts](src/index.ts) |
| **Registry** | Tool registry; ships with a single `echo` tool | `echoTool` + `registry.install()` |
| **Wrangler** | Minimal binding: `ASSISTANT` → `Assistant`, `v1` SQLite migration | `wrangler.jsonc` |
| **celld** | Local runtime that emulates Workers + Durable Objects; persists to `.celld/dev/` | `npm run dev` → `celld dev` |

The `:name` in `/agent/:name/prompt` is the Durable Object name (`getByName`). `POST /agent/test/prompt` and `POST /agent/alice/prompt` are different persistent agents with separate SQLite state.

---

## Prerequisites

- **Linux** (celld targets Linux)
- **Node.js 22.19+** — check with `node --version` (this repo tested on Node 26)
- **celld** binary on `PATH` — local Workers + DO runtime ([denoland/celld](https://github.com/denoland/celld))
- **esbuild** on `PATH` (or `CELLD_ESBUILD` pointing at it) — `celld dev` and `celld deploy` use it to bundle `src/index.ts`
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
   # equivalent to: celld dev
   # Worker listener: http://127.0.0.1:9876
   ```

   State persists in `.celld/dev/` across restarts. To start empty:

   ```sh
   celld dev --clean
   ```

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
    "bindings": [{ "name": "ASSISTANT", "class_name": "Assistant" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Assistant"] }]
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
# -> {"name":"alice","resident":true}
```

Best-effort and deliberately coarse: if the route is reachable, the binding is addressable and celld activates the cell on demand. There is no per-cell residency probe yet.

### `GET /agent/:name/messages`

Transcript tail for debugging — pi records generation failures here, so a terse `"reason": "model_error"` can be traced to the underlying message.

```sh
curl 'localhost:9876/agent/test/messages?limit=10'
# -> {"name":"test","messages":[{"id":"...","kind":"...","preview":"..."}, ...]}
```

`limit` defaults to 20, capped at 100. Each entry is `{id, kind, preview}` (preview truncated at 800 chars).

### `POST /agent/:name/reset`

Start a fresh context for the agent (clears the transcript — useful after a run of failed prompts, or after switching providers). The next prompt re-applies the pin/heal logic, so it also picks up a moved default model.

```sh
curl -X POST localhost:9876/agent/test/reset
# -> {"name":"test","reset":true}
```

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

The repo ships with one tool to prove the loop before anything real is added:

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

Ask the model to echo something (`"use the echo tool to echo 'hello'"`). If the transcript shows the tool call and its output in the final text, your model → tool → transcript path works. `replay: "safe"` means the tool is side-effect-free and safe to re-run during resume/replay.

---

## Project structure

```
fleet-base/
├── src/
│   └── index.ts          # Worker routes + Assistant DO + echo tool + model wiring
├── wrangler.jsonc        # Worker name, entry, DO binding, SQLite migration
├── package.json          # npm scripts (dev → celld dev), pi/ai/durable + agents deps
├── .env.example          # Copy to .dev.vars; one provider key required
├── deploy/
│   ├── fleet.service     # systemd unit for a fleet node (bucket deploys)
│   └── celld.env         # Non-default celld tuning (leases, polling, GC, caps)
├── .celld/               # Local celld state (git-ignored, created by celld dev)
└── README.md / LICENSE
```

---

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

2. Register it:

   ```ts
   this.registry.install({ name: "fleet-base", tools: [echoTool, upperTool] });
   ```

3. Restart `celld dev` and prompt: `"use the upper tool on 'hello'"`.

Tips:

- `replay: "safe"` tools re-run freely on resume. Side-effecting tools (send email, write DB) need replay discipline — check `pi-durable` docs for `replay` semantics before marking them safe.
- Keep tool `name` + `description` precise — that's what the model sees when deciding to call it.
- Validate `parameters` with `Type.*` (from `@earendil-works/pi-ai`) so bad model args fail early.

---

## Adding more agents / bindings

- **More agents:** no code change — `POST /agent/<any-name>/prompt` creates/address a DO by name. Use one name per user, per repo, per employee, etc.
- **More bindings:** add to `wrangler.jsonc` (R2, KV, D1, queues, workflows) and extend `Env` in `src/index.ts`. Keep `wrangler.jsonc` minimal until you need them — each binding is a new failure mode.
- **Multi-harness / MCP / containers:** intentionally absent. Add them after the echo loop + resume tests pass on your machine.

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
| Stale/corrupt local state | `celld dev --clean` (wipes `.celld/dev/`) |
| Second POST with same `requestId` starts a new run | You changed `prompt` or agent `:name` — idempotency is per `(agent, operationId)`; also check you're sending `requestId`/`operationId` as a string |
| `wrangler` deploy errors about bindings | Keep `wrangler.jsonc` minimal; add one binding at a time |

---

## Roadmap — not implemented yet

- containers / Docker / `containers[]` / `ctx.container`
- MCP servers
- skills
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

Issues and PRs welcome. Keep the base minimal — prove the tool loop + resume first, then layer features. Run `celld dev --clean` + the [First prompt](#quickstart) and [Idempotency](#idempotency-and-crash-resume) checks before opening a PR.

---

## License

MIT — see [LICENSE](LICENSE).
