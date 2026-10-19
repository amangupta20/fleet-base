import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, Harness, defineTool } from "@earendil-works/pi-durable";

export interface Env {
  ASSISTANT: DurableObjectNamespace;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

const MISSING_KEY_MESSAGE =
  "fleet: set OPENAI_API_KEY or GEMINI_API_KEY in .dev.vars " +
  "(celld dev reads .dev.vars, then .env, then .env.local). No model provider configured.";

function resolveDefaultModel(env: Env): { provider: string; id: string } {
  if (env?.OPENAI_API_KEY?.trim()) {
    return { provider: "openai", id: "gpt-5-mini" };
  }
  if (env?.GEMINI_API_KEY?.trim()) {
    return { provider: "google", id: "gemini-2.5-flash" };
  }
  throw new Error(MISSING_KEY_MESSAGE);
}

// Proof-of-loop tool: proves the model -> tool -> transcript loop works
// before anything real is added.
const echoTool = defineTool({
  name: "echo",
  description: "Echo back the given text. Proves the tool loop works.",
  parameters: Type.Object({ text: Type.String() }),
  replay: "safe",
  async execute({ text }) {
    return { output: [{ type: "text", text }] };
  },
});

export class Assistant extends Agent<Env> {
  registry = createRegistry();

  harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const env = this.env as Env;
      const openaiKey = env?.OPENAI_API_KEY?.trim();
      const geminiKey = env?.GEMINI_API_KEY?.trim();
      if (!openaiKey && !geminiKey) {
        throw new Error(MISSING_KEY_MESSAGE);
      }
      this.registry.install({
        name: "fleet-base",
        tools: [echoTool],
      });
      const workerEnv = (env ?? {}) as unknown as Record<string, string | undefined>;
      const models = createModels({
        authContext: {
          env: async (name: string) => {
            const fromWorker = workerEnv[name];
            if (typeof fromWorker === "string" && fromWorker.trim()) return fromWorker;
            const fromProcess =
              typeof process !== "undefined"
                ? (process.env as Record<string, string | undefined>)?.[name]
                : undefined;
            return typeof fromProcess === "string" && fromProcess.trim()
              ? fromProcess
              : undefined;
          },
          fileExists: async () => false,
        },
      });
      models.setProvider(openaiProvider());
      models.setProvider(googleProvider());
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: {
      // Resolved from the configured provider at construction time.
      // The harness factory above still fails loudly if neither key is set,
      // so this fallback never masks a misconfiguration.
      model: (() => {
        try {
          return resolveDefaultModel((this as unknown as { env: Env }).env);
        } catch {
          return { provider: "openai", id: "gpt-5-mini" };
        }
      })(),
    },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  async ask(prompt: string, requestIdOrOptions?: string | { requestId?: string; operationId?: string }) {
    const operationId =
      typeof requestIdOrOptions === "string"
        ? requestIdOrOptions
        : (requestIdOrOptions?.operationId ?? requestIdOrOptions?.requestId);
    const res = await this.harness.prompt(
      prompt,
      operationId ? { operationId } : undefined,
    );
    const text = (res as unknown as { text?: string }).text ?? "";
    const submissionId = (res as unknown as { operationId?: string }).operationId;
    const status = (res as unknown as { status?: string }).status;
    return { text, submissionId, operationId: submissionId, status };
  }
}

function getAssistantStub(env: Env, name: string) {
  const binding = env.ASSISTANT as unknown as {
    getByName?: (name: string) => { ask: (...args: unknown[]) => Promise<unknown> };
    idFromName?: (name: string) => unknown;
    get?: (id: unknown) => { ask: (...args: unknown[]) => Promise<unknown> };
  };
  if (typeof binding.getByName === "function") return binding.getByName(name);
  if (typeof binding.idFromName === "function" && typeof binding.get === "function") {
    return binding.get(binding.idFromName(name));
  }
  throw new Error("ASSISTANT binding has neither getByName nor idFromName/get");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    const promptMatch = url.pathname.match(/^\/agent\/([^/]+)\/prompt$/);
    if (promptMatch && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const prompt = (body as { prompt?: unknown }).prompt;
      if (typeof prompt !== "string" || !prompt) {
        return Response.json(
          { error: 'body.prompt must be a non-empty string' },
          { status: 400 },
        );
      }
      const requestId =
        typeof (body as { requestId?: unknown }).requestId === "string"
          ? ((body as { requestId: string }).requestId as string)
          : typeof (body as { operationId?: unknown }).operationId === "string"
            ? ((body as { operationId: string }).operationId as string)
            : undefined;
      if (!env?.OPENAI_API_KEY?.trim() && !env?.GEMINI_API_KEY?.trim()) {
        return Response.json({ error: MISSING_KEY_MESSAGE }, { status: 500 });
      }
      const name = decodeURIComponent(promptMatch[1]);
      const stub = getAssistantStub(env, name);
      const result = await stub.ask(prompt, requestId);
      return Response.json(result);
    }

    const stateMatch = url.pathname.match(/^\/agent\/([^/]+)\/state$/);
    if (stateMatch && request.method === "GET") {
      const name = decodeURIComponent(stateMatch[1]);
      // Best effort, deliberately coarse: the binding is addressable and
      // celld activates the cell on demand, so we report resident:true once
      // the route itself is reachable. No per-cell residency probe yet.
      return Response.json({ name, resident: true });
    }

    return new Response("not found", { status: 404 });
  },
};
