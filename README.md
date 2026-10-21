# fleet-base

**Self-hosted agents that outlive your laptop.**

Demos: [fresh boot + health](docs/demo/fresh-boot.gif) · [kill -9 resume](docs/demo/kill-9-resume.gif) · [second terminal prompt](docs/demo/second-terminal.gif)

A stateless Worker forgets the in-flight run; a chat UI such as OpenWebUI
remembers the conversation, not the run. fleet-base keeps the run in a SQLite-backed
Durable Object: kill mid-prompt, restart, re-POST the same `requestId`, and it resumes.

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

That is a real response from a local run. `submissionId`/`operationId` are the
durable handle you re-POST after a crash.

## Deploy: one bucket-backed node

```sh
set -a; source .dev.vars; set +a   # OVH S3 creds + CELLD_BUCKET
npm run deploy                     # bundle + deploy; vars from .dev.vars
sudo cp deploy/fleet.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now fleet
curl -s localhost:8080/health      # ok
```
Every write waits for a bucket round-trip — slower than local. Full variants: [deploy.md](docs/deploy.md).

## Tradeoffs

- **No auth.** Every route is unauthenticated. Bind localhost or proxy it; never expose it.
- **No containers, KV, D1, or queues.** One Worker and two Durable Objects; no sandbox or second storage system.
- **Local-only by default.** `celld dev` writes to `.celld/dev/`; bucket deploy is documented, not default.

## Docs

- [Configuration](docs/configuration.md) — env vars, model selection, wrangler.
- [API](docs/api.md) — routes, idempotency, crash resume.
- [Tools](docs/tools.md) — echo loop, adding tools and agents.
- [Deploy](docs/deploy.md) — full bucket/fleet variants, second node, Tailscale.
- [Troubleshooting](docs/troubleshooting.md) — symptoms and fixes.

The rest of this README assumes you want the smallest working base and will add
your own surface. The demo GIFs are terminal recordings of this API
([notes](docs/demo/README.md)).

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

Issues and PRs welcome. Keep the base minimal — prove the tool loop + resume first, then layer features. Run `celld dev --clean` + the [First prompt](docs/configuration.md#quickstart) and [Idempotency](docs/api.md#idempotency-and-crash-resume) checks before opening a PR.

---

## License

MIT — see [LICENSE](LICENSE).
