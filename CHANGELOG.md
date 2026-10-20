# Changelog

## v0.1.0 - 2026-10-20

First tag. This is a base, not a launch.

### Scars

- The first kill -9 test looked like a failed resume: the demo wrote its output
  under the project tree, `celld dev` saw the write, rebuilt and restarted the
  app mid-prompt. Moving the output outside the tree made the resume test show
  the real behavior. The test is in the PR verification log.
- One killed prompt left a `pi.assistant` transcript entry with the preview
  `Connection error.` The re-POST returned the full answer under the same
  `operationId`, but the failed partial was still there. Resume is not a clean
  rollback.
- The README's reset wording was imprecise in both directions. Reset starts a
  new context: `/messages` returns a `pi.reset` entry, the `/agents` row is
  kept, and old rows may remain in storage. Fixed after testing.
- `package.json` called the package `fleet` while the repo and README called it
  `fleet-base`. Aligned in this tag.
- Copying `.env.example` to `.dev.vars` with every provider blank starts the
  server and returns `ok` from `/health`, but prompts return 500. The example
  now says that instead of leaving it to the first prompt.
- The first README screen led with architecture, not the run that survives a
  crash, and buried the provider requirement in Quickstart. Rewritten in this
  tag.

### Cut

- Auth, SSO, containers, KV, D1, queues, MCP, multi-harness, and UI. The base
  stays one Worker and two Durable Objects.
- npm publishing and release automation. The package is private; this tag is a
  git tag, not a registry release.
- Coverage thresholds, Playwright, Dependabot, and a wiki. None of them make
  the first run more honest.
