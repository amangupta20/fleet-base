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
        ├─> POST /agent/:name/prompt → ASSISTANT Durable Object stub
        │     └─> Assistant.ask(prompt, requestId)
        │           └─> PiHarness.prompt(prompt, { operationId })
        │                 ├─> pi-ai models (OpenAI or Gemini)
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
| **Models** | `pi-ai` `createModels()` with OpenAI + Google providers, auth read from Worker env | `harness()` factory |
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
- **One model key** — either OpenAI or Gemini (not both required, exactly one must be set)

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

2. **Configure a provider key**

   ```sh
   cp .env.example .dev.vars
   # then edit .dev.vars — set exactly one of:
   #   OPENAI_API_KEY=sk-...
   #   GEMINI_API_KEY=...
   ```

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
| `OPENAI_API_KEY` | Yes, unless `GEMINI_API_KEY` is set | Pi OpenAI provider (`gpt-5-mini` default) |
| `GEMINI_API_KEY` | Yes, unless `OPENAI_API_KEY` is set | Pi Google provider (`gemini-2.5-flash` default) |
| `CELLD_BUCKET` | No (local uses on-disk store) | S3-compatible bucket, e.g. `s3://my-fleet` — bucket/fleet deploys only |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | No | Bucket credentials — deploys only |
| `AWS_REGION` | No | e.g. `auto` for R2 — deploys only |
| `S3_ENDPOINT` | No | e.g. `https://ACCOUNT_ID.r2.cloudflarestorage.com` — deploys only |

See [.env.example](.env.example) — copy it to `.dev.vars` and fill in one provider key. Never commit `.dev.vars` / `.env` (already in [.gitignore](.gitignore)).

### Model selection

`resolveDefaultModel()` in [src/index.ts](src/index.ts) picks the default at construction:

- `OPENAI_API_KEY` set → `{ provider: "openai", id: "gpt-5-mini" }`
- else `GEMINI_API_KEY` set → `{ provider: "google", id: "gemini-2.5-flash" }`
- else throws — the Worker returns HTTP 500 with `fleet: set OPENAI_API_KEY or GEMINI_API_KEY in .dev.vars ...`

The harness factory re-checks keys at runtime so misconfiguration fails loudly instead of silently falling back.

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

### `POST /agent/:name/prompt`

Run a prompt on the named agent. Body must be JSON with a non-empty `prompt` string. Optional `requestId` (alias `operationId`) for idempotency.

```sh
curl -X POST localhost:9876/agent/alice/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"echo hello back to me","requestId":"req-123"}'
```

Response:

```json
{
  "text": "...",
  "submissionId": "...",
  "operationId": "...",
  "status": "done"
}
```

| Field | Meaning |
|---|---|
| `text` | Final model text |
| `submissionId` / `operationId` | Same value — the durable run id (idempotency key) |
| `status` | e.g. `done` |

Errors:

| Status | When |
|---|---|
| `400` | Invalid JSON body, or `body.prompt` missing/empty |
| `500` | Neither provider key is set |
| `404` | Any other path/method |

### `GET /agent/:name/state`

```sh
curl localhost:9876/agent/alice/state
# -> {"name":"alice","resident":true}
```

Best-effort and deliberately coarse: if the route is reachable, the binding is addressable and celld activates the cell on demand. There is no per-cell residency probe yet.

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

## Bucket / fleet deploy (documented only)

Local `celld dev` needs no bucket. For a real fleet node you need an S3-compatible bucket (e.g. Cloudflare R2) and the files in [deploy/](deploy/):

```sh
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=auto
export S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
export CELLD_BUCKET=s3://YOUR-BUCKET
celld deploy . --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
```

- [deploy/celld.env](deploy/celld.env) — agreed non-default tuning (longer leases, slower rebalance/poll/waker ticks, 7-day LTX retention, idle eviction, RSS + residency caps). Each line documents its default and tradeoff. Not used by `celld dev`.
- [deploy/fleet.service](deploy/fleet.service) — systemd unit. After deploying a new bundle, `POST /reload` on the internal listener (`127.0.0.1:8081` by default) to adopt it immediately instead of waiting `CELLD_DEPLOY_POLL_S`.
- Never expose the internal listener to the public internet — keep peer traffic on a trusted network / encrypted overlay (see comments in `fleet.service`).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `500 fleet: set OPENAI_API_KEY or GEMINI_API_KEY...` | `cp .env.example .dev.vars`, set exactly one key, restart `celld dev` |
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
