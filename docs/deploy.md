# Deploy

## Bucket / fleet deploy (tested single-node, systemd files included)

Local `celld dev` needs no bucket. For a real fleet node you need an S3-compatible bucket (e.g. Cloudflare R2) and the files in [deploy/](../deploy/). Verified: deploy → single bucket-backed node → `/health`, `/models`, and a `done` tool-loop prompt.

**Vars and secrets without hoop-jumping:** `celld deploy` ignores `.dev.vars`/`.env` — Worker variables ship via wrangler `[vars]`, baked into the deployment, and celld has no secrets mechanism. So `npm run deploy` (→ [scripts/deploy.mjs](../scripts/deploy.mjs)) does it for you: it reads provider vars from `.dev.vars` (allowlist: `ROUTER_*`, `OPENCODE_*`, `OPENAI_*`, `GEMINI_*` — bucket/CLI creds stay in your shell), merges them into a throwaway gitignored `wrangler.deploy.jsonc`, deploys, and deletes it. Extra args forward to `celld deploy`. Secrets land in the deployment objects inside your own bucket — never in git.

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

- [deploy/celld.env](../deploy/celld.env) — agreed non-default tuning (longer leases, slower rebalance/poll/waker ticks, 7-day LTX retention, idle eviction, RSS + residency caps). Each line documents its default and tradeoff. Not used by `celld dev`.
- [deploy/fleet.service](../deploy/fleet.service) — systemd unit. After deploying a new bundle, `POST /reload` on the internal listener (`127.0.0.1:8081` by default) to adopt it immediately instead of waiting `CELLD_DEPLOY_POLL_S`.
- Never expose the internal listener to the public internet — keep peer traffic on a trusted network / encrypted overlay (see comments in `fleet.service`).

## Second node

Point a second node at the same bucket and give it its own peer address. It
settles writes disk-to-disk instead of waiting for the bucket.

## Multi-node / Tailscale

The systemd unit ships a commented Tailscale overlay example: put the internal
listener and advertise address on the node's Tailscale IP (for example
`100.64.0.12:8081`), keep `8080` on the public listener, and never expose the
internal listener to the internet. Peer traffic has no TLS; keep it on a trusted
private network or encrypted overlay. See
[deploy/fleet.service](../deploy/fleet.service).
