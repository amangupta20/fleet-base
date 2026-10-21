# Troubleshooting

| Symptom | Fix |
|---|---|
| `500 fleet: no model provider configured...` | `cp .env.example .dev.vars`, configure one path (router / opencode-go / OpenAI / Gemini), restart `celld dev` |
| Model answers but ignores the `echo` tool | Weaker routers/models may not tool-call reliably — try a stronger model id, check [`GET /models`](api.md#get-models) live ids match what the router actually serves |
| Router `fetch failed` / empty reply | Router not running or wrong `ROUTER_BASE_URL` — `curl $ROUTER_BASE_URL/models` directly; keyless servers need `ROUTER_API_KEY` empty |
| `"status":"unanswered","reason":"model_error"` against own router | The router rejected or was unreachable for the chat call. Reproduce it directly (below), then check [`GET /agent/:name/messages`](api.md#get-agentnamemessages) for pi's recorded error |
| `celld: command not found` | Install celld, ensure it's on `PATH` |
| `esbuild: command not found` / bundle error | Install esbuild or set `CELLD_ESBUILD=/path/to/esbuild` |
| Port `9876` in use | Stop the other `celld dev`, or check what's listening |
| Stale/corrupt local state | `celld dev --clean` (wipes `.celld/dev/`) |
| Second POST with same `requestId` starts a new run | You changed `prompt` or agent `:name` — idempotency is per `(agent, operationId)`; also check you're sending `requestId`/`operationId` as a string |
| `wrangler` deploy errors about bindings | Keep `wrangler.jsonc` minimal; add one binding at a time |
