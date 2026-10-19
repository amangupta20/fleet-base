# fleet-base — celld + Pi Durable base, local-only

Base celld + Pi Durable fleet app (Pi only). Foundation for a self-hosted
Durable Objects fleet that will later host employees as cells, runners, MCP,
and repo masters. **This checkout is local-only**: no bucket, no deploy, no
containers, no Docker, no MCP, no UI, no auth, no Hindsight.

## Prereqs

- Linux
- Node 22.19+ (`node --version`)
- `esbuild` on PATH **only on the deploy machine** (needed when the project
  contains Worker code: `celld deploy` bundles with it). Local `celld dev`
  also needs it to build `src/index.ts` — point `CELLD_ESBUILD` at it or put
  it on PATH.

## Local run

```sh
npm install
cp .env.example .dev.vars   # then set OPENAI_API_KEY or GEMINI_API_KEY
celld dev
# Worker listener: http://127.0.0.1:9876
```

`celld dev` reads `.dev.vars` beside the Wrangler config, else `.env` then
`.env.local`. It keeps local state in `.celld/dev` across restarts; use
`celld dev --clean` to start empty. `GET /health` returns `ok`.

## First test

```sh
curl -X POST localhost:9876/agent/test/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"say hi"}'
# -> {"text":"...","submissionId":"...","operationId":"...","status":"done"}
```

With a provider key set, the response contains both `text` and a
`submissionId` (`operationId`). The `echo` tool fires when the model calls it;
see acceptance notes below for the evidence query.

## Resume test

Two identical `requestId`s produce one run, not two (`operationId` is the
idempotency key; `requestId` is accepted as an alias):

```sh
RID="req-$(date +%s)"
curl -X POST localhost:9876/agent/test/prompt \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"say hi\",\"requestId\":\"$RID\"}"
curl -X POST localhost:9876/agent/test/prompt \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"say hi\",\"requestId\":\"$RID\"}"
# Both responses share the same submissionId/operationId; the second is
# returned without starting a second run.
```

Crash resume: start a prompt, `kill -9` the celld process mid-run, restart
with `celld dev`, then re-POST with the same `requestId`. `harness.resume()`
continues the same submission from its SQLite checkpoint; the same
`requestId` does not produce a second run.

## Bucket run (not part of this ticket — documented only)

```sh
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=auto
export S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
export CELLD_BUCKET=s3://YOUR-BUCKET
celld deploy . --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
# systemd: deploy/fleet.service + deploy/celld.env, then POST /reload on the
# internal listener (127.0.0.1:8081) to adopt a new deployment immediately
# instead of waiting CELLD_DEPLOY_POLL_S.
```

## Not implemented yet

- containers / Docker / `containers[]` / `ctx.container`
- MCP servers
- skills
- multi-harness
- UI (no Next.js/Vite/React)
- auth
- Hindsight
- queues
- paperclip bridge
- workflows, d1/kv/r2 bindings (wrangler stays deliberately minimal)
