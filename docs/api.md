# API

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
        │                 ├─> pi-durable registry (tools, e.g. `echo`)
        │                 └─> SQLite checkpoint (resume after crash)
        └─> GET /agent/:name/state → { name, resident: true }
```

Key pieces:

| Piece | What it does | Where |
|---|---|---|
| **Worker** | Routes HTTP to Durable Objects | `src/index.ts` default export `fetch()` |
| **Assistant DO** | One SQLite-backed Durable Object per `:name`, via `agents` SDK `Agent` class | `src/index.ts` `export class Assistant` |
| **Registry DO** | One plain `DurableObject` (no model) indexing agent names, last-active time, and prompt counts | `src/index.ts` `export class Registry` |
| **PiHarness** | Lifecycle wrapper that opens a `pi-durable` `Harness` per DO (models + tool registry + storage) | `Assistant.harness` |
| **Models** | `pi-ai` `createModels()` with four providers: own OpenAI-compatible router (`router`), OpenCode Go (`opencode-go`), OpenAI, Google — auth read from Worker env | `buildModels()` in [src/index.ts](../src/index.ts) |
| **Tool registry** | pi-durable tool registry; ships with a single `echo` tool | `echoTool` + `registry.install()` |
| **Wrangler** | Minimal bindings: `ASSISTANT` → `Assistant`, `REGISTRY` → `Registry`; `v1`/`v2` SQLite migrations | `wrangler.jsonc` |
| **celld** | Local runtime that emulates Workers + Durable Objects; persists to `.celld/dev/` | `npm run dev` → `celld dev` |

The `:name` in `/agent/:name/prompt` is the Durable Object name (`getByName`). `POST /agent/test/prompt` and `POST /agent/alice/prompt` are different persistent agents with separate SQLite state.

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

Start a new context for the agent. `GET /messages` returns a `pi.reset` entry, not the prior messages; the `/agents` entry (name, `lastActive`, `prompts`) is kept, and old rows may remain in storage. The next prompt re-applies the pin/heal logic, so it also picks up a moved default model.

```sh
curl -X POST localhost:9876/agent/test/reset
# -> {"name":"test","reset":true}
```

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

How it maps to code ([src/index.ts](../src/index.ts) `Assistant.ask`):

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
