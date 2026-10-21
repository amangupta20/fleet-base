# Tools and agents

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

## Project structure

```
fleet-base/
├── src/
│   └── index.ts          # Worker routes + Assistant/Registry DOs + echo tool + model wiring
├── wrangler.jsonc        # Worker name, entry, DO bindings, SQLite migrations
├── package.json          # npm scripts (dev → celld dev), pi/ai/durable + agents deps
├── .env.example          # Copy to .dev.vars; one provider key required
├── deploy/
│   ├── fleet.service     # systemd unit for a fleet node (bucket deploys)
│   └── celld.env         # Non-default celld tuning (leases, polling, GC, caps)
├── .celld/               # Local celld state (git-ignored, created by celld dev)
└── README.md / LICENSE
```

## Adding your own tool

1. Define it next to `echoTool` in [src/index.ts](../src/index.ts):

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

## Adding more agents / bindings

- **More agents:** no code change — `POST /agent/<any-name>/prompt` creates/address a DO by name. Use one name per user, per repo, per employee, etc. Each name shows up in `GET /agents` after its first prompt.
- **More bindings:** add to `wrangler.jsonc` (R2, KV, D1, queues, workflows) and extend `Env` in `src/index.ts`. Keep `wrangler.jsonc` minimal until you need them — each binding is a new failure mode.
- **Multi-harness / MCP / containers:** intentionally absent. Add them after the echo loop + resume tests pass on your machine.
