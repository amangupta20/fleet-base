# Setup and configuration

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

   `GET /models` (see [API](api.md#get-models)) shows the live catalog so you can fetch-then-choose without guessing ids.

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

See [.env.example](../.env.example) — copy it to `.dev.vars` and configure one provider path. Never commit `.dev.vars` / `.env` (already in [.gitignore](../.gitignore)).

### Model selection

`resolveDefaultModel()` in [src/index.ts](../src/index.ts) picks the default fresh sessions start with, first hit wins:

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

### Wrangler ([wrangler.jsonc](../wrangler.jsonc))

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
