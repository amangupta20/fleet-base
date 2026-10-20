# Deslop v0.1.0

Status: implemented on `deslop/v0.1.0`.

Baseline: `7eb7e7b`, the commit named in the request. `origin/main` moved to
`b6e898e` before this branch started. The branch stays on `7eb7e7b` so the
deslop diff does not carry the newer name/model validation work; that commit
keeps its own history on `main`.

## Goal

Make the first screen and the first run match the product: a small self-hosted
agent base whose runs survive a process kill. This is a docs, demo, and release
metadata pass. No features, no routes, no schema changes, no new dependencies.

## Required

1. README top 60 lines carry the hook, the reason a stateless Worker or a chat
   UI is not enough, a real 30-second proof with pasted output, and tradeoffs.
   The rest of the README stays as written except drift proven against the code.
2. A fresh clone can run `npm install`, `cp .env.example .dev.vars`,
   `npm run dev`, and `curl /health`, and get `ok`. Fix the README or
   `.env.example` if that path is broken. Add no scripts for this.
3. Three terminal GIFs under `docs/demo/`: fresh boot and `/health`, kill -9
   resume, and a second terminal prompt. Each under 5 MB, under 30 seconds, no
   audio, linked from the README top. The third is a second local terminal
   because no phone or Termux device was available; say so in the PR. No fake
   recordings. If recording is impossible, ship `scripts/record-demo.sh` plus a
   clear placeholder and say so in the PR.
4. One name and one one-liner across `package.json`, README H1 and tagline, and
   the repo description. No wider rebrand.
5. `CHANGELOG.md` for `v0.1.0` with what broke and what was cut, plus an
   annotated `v0.1.0` tag. No release announcement.

## Out of scope

Auth, SSO, containers, KV/D1/queues, a monorepo, DCO, CODEOWNERS, coverage
thresholds, Playwright, Dependabot, a wiki, UI code, UIState, or a fork of
phi/paseo. No new dependency. No source changes unless a README code sample is
proven wrong.

## Acceptance

- README top has the hook, proof and tradeoffs, and the proof output is copied
  from a local run.
- Fresh clone health check returns `ok`.
- `docs/demo/` has three real GIFs or a documented placeholder plus recorder.
- `package.json` name and description, README H1/tagline, and repo description
  agree.
- `CHANGELOG.md` and `git tag v0.1.0` exist.
- R1, R2 and R3 reports are pasted in the PR.
