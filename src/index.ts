import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  Type,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { createRegistry, Harness, defineTool } from "@earendil-works/pi-durable";

export interface Env {
  ASSISTANT: DurableObjectNamespace;
  // Custom OpenAI-compatible router: your own gateway (LiteLLM, Ollama,
  // vLLM, LM Studio, ...). No OpenAI/Gemini key needed when this is set.
  ROUTER_BASE_URL?: string;
  ROUTER_API_KEY?: string;
  ROUTER_MODEL?: string;
  // Extra router model ids to pre-register (comma-separated), so they are
  // usable via the per-request `model` override without a restart.
  ROUTER_EXTRA_MODELS?: string;
  // OpenCode Go hosted inference (https://opencode.ai). Needs a key;
  // OPENCODE_MODEL pins the default, else the catalog's first model wins.
  OPENCODE_API_KEY?: string;
  OPENCODE_MODEL?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

const ROUTER_PROVIDER = "router";
const DEFAULT_ROUTER_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_ROUTER_MODEL = "llama-3.1-8b";
const FALLBACK_OPENCODE_MODEL = "claude-haiku-5-5";

const MISSING_KEY_MESSAGE =
  "fleet: no model provider configured. Set at least one of ROUTER_MODEL " +
  "(+ ROUTER_BASE_URL for your gateway), OPENCODE_API_KEY (+ OPENCODE_MODEL), " +
  "OPENAI_API_KEY, GEMINI_API_KEY in .dev.vars " +
  "(celld dev reads .dev.vars, then .env, then .env.local).";

function nonEmpty(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function authEnv(env: Env) {
  const workerEnv = (env ?? {}) as unknown as Record<string, string | undefined>;
  return {
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
  };
}

function routerModelEntry(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: `${id} (router)`,
    api: "openai-completions",
    provider: ROUTER_PROVIDER,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

// Every provider this fleet knows about. The custom router and OpenCode Go
// are always registered (env-driven); OpenAI/Google stay registered so they
// keep working when their keys are present. Nothing here does I/O.
function buildModels(env: Env): MutableModels {
  const models = createModels({ authContext: authEnv(env) });
  const routerBase = nonEmpty(env?.ROUTER_BASE_URL) ?? DEFAULT_ROUTER_BASE_URL;
  const routerIds = [
    nonEmpty(env?.ROUTER_MODEL),
    ...(env?.ROUTER_EXTRA_MODELS ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  ].filter((id): id is string => Boolean(id));
  const uniqueIds = [...new Set(routerIds)];
  if (uniqueIds.length === 0) uniqueIds.push(DEFAULT_ROUTER_MODEL);
  models.setProvider(
    createProvider({
      id: ROUTER_PROVIDER,
      name: "Custom router",
      baseUrl: routerBase,
      auth: nonEmpty(env?.ROUTER_API_KEY)
        ? { apiKey: envApiKeyAuth("Router API key", ["ROUTER_API_KEY"]) }
        : {
            // Keyless local servers (e.g. Ollama) resolve as configured.
            apiKey: { name: "Router (keyless)", resolve: async () => ({ auth: {} }) },
          },
      models: uniqueIds.map((id) => routerModelEntry(id, routerBase)),
      api: openAICompletionsApi(),
    }),
  );
  models.setProvider(opencodeGoProvider());
  models.setProvider(openaiProvider());
  models.setProvider(googleProvider());
  return models;
}

function ensureConfigured(env: Env): void {
  if (
    nonEmpty(env?.ROUTER_MODEL) ||
    nonEmpty(env?.ROUTER_BASE_URL) ||
    nonEmpty(env?.OPENCODE_API_KEY) ||
    nonEmpty(env?.OPENAI_API_KEY) ||
    nonEmpty(env?.GEMINI_API_KEY)
  ) {
    return;
  }
  throw new Error(MISSING_KEY_MESSAGE);
}

// Default model, first hit wins. Per-request `model` and GET /models let you
// switch at runtime; this only decides what a fresh session starts with.
function resolveDefaultModel(env: Env, models: MutableModels): { provider: string; id: string } {
  const routerModel = nonEmpty(env?.ROUTER_MODEL);
  if (routerModel) return { provider: ROUTER_PROVIDER, id: routerModel };
  const opencodeKey = nonEmpty(env?.OPENCODE_API_KEY);
  const opencodeModel = nonEmpty(env?.OPENCODE_MODEL);
  if (opencodeKey && opencodeModel) return { provider: "opencode-go", id: opencodeModel };
  if (nonEmpty(env?.OPENAI_API_KEY)) return { provider: "openai", id: "gpt-5-mini" };
  if (nonEmpty(env?.GEMINI_API_KEY)) return { provider: "google", id: "gemini-2.5-flash" };
  if (opencodeKey) {
    const first = models.getModels("opencode-go")[0]?.id;
    return { provider: "opencode-go", id: opencodeModel ?? first ?? FALLBACK_OPENCODE_MODEL };
  }
  if (nonEmpty(env?.ROUTER_BASE_URL)) {
    return { provider: ROUTER_PROVIDER, id: routerModel ?? DEFAULT_ROUTER_MODEL };
  }
  throw new Error(MISSING_KEY_MESSAGE);
}

// Accept "provider/id" or { provider, id }. Undefined/empty means "default".
function parseModelRef(
  model: unknown,
): { provider: string; id: string } | undefined {
  if (model === undefined || model === null) return undefined;
  if (typeof model === "string") {
    const clean = model.trim();
    if (!clean) return undefined;
    const slash = clean.indexOf("/");
    if (slash <= 0 || slash === clean.length - 1) {
      throw new Error(
        `malformed model ${JSON.stringify(model)}: use "provider/id" or {"provider","id"}`,
      );
    }
    return { provider: clean.slice(0, slash), id: clean.slice(slash + 1) };
  }
  if (typeof model === "object") {
    const provider = (model as { provider?: unknown }).provider;
    const id = (model as { id?: unknown }).id;
    if (typeof provider === "string" && provider.trim() && typeof id === "string" && id.trim()) {
      return { provider: provider.trim(), id: id.trim() };
    }
  }
  throw new Error(
    `malformed model ${JSON.stringify(model)}: use "provider/id" or {"provider","id"}`,
  );
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
  private modelsRef?: MutableModels;

  harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const env = this.env as Env;
      ensureConfigured(env);
      this.registry.install({
        name: "fleet-base",
        tools: [echoTool],
      });
      const models = buildModels(env);
      this.modelsRef = models;
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: {
      // Resolved from env at construction time. The harness factory above
      // still fails loudly if nothing is configured, so this fallback never
      // masks a misconfiguration (router default is always registered).
      model: (() => {
        try {
          const env = (this as unknown as { env: Env }).env ?? ({} as Env);
          return resolveDefaultModel(env, buildModels(env));
        } catch {
          return { provider: ROUTER_PROVIDER, id: DEFAULT_ROUTER_MODEL };
        }
      })(),
    },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  async ask(
    prompt: string,
    requestIdOrOptions?: string | { requestId?: string; operationId?: string },
    model?: unknown,
  ) {
    const wanted = parseModelRef(model);
    if (wanted) {
      const known = this.modelsRef?.getModel(wanted.provider, wanted.id);
      if (this.modelsRef && !known) {
        throw new Error(
          `unknown model "${wanted.provider}/${wanted.id}"; see GET /models for the catalog`,
        );
      }
      // Session-pinned: this agent keeps using the chosen model until changed.
      await this.harness.session().setModel(wanted);
    }
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

  async listModels() {
    const env = this.env as Env;
    const models = this.modelsRef ?? buildModels(env);
    return models
      .getModels()
      .map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
  }
}

function getAssistantStub(env: Env, name: string) {
  const binding = env.ASSISTANT as unknown as {
    getByName?: (name: string) => {
      ask: (...args: unknown[]) => Promise<unknown>;
      listModels: () => Promise<unknown>;
    };
    idFromName?: (name: string) => unknown;
    get?: (id: unknown) => {
      ask: (...args: unknown[]) => Promise<unknown>;
      listModels: () => Promise<unknown>;
    };
  };
  if (typeof binding.getByName === "function") return binding.getByName(name);
  if (typeof binding.idFromName === "function" && typeof binding.get === "function") {
    return binding.get(binding.idFromName(name));
  }
  throw new Error("ASSISTANT binding has neither getByName nor idFromName/get");
}

async function fetchRouterLiveModels(env: Env): Promise<{ baseUrl: string; live: string[] | null }> {
  const baseUrl = (nonEmpty(env?.ROUTER_BASE_URL) ?? DEFAULT_ROUTER_BASE_URL).replace(/\/+$/, "");
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    const key = nonEmpty(env?.ROUTER_API_KEY);
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { baseUrl, live: null };
    const body = (await res.json()) as unknown;
    const list = Array.isArray(body)
      ? body
      : Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : [];
    const ids = list
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof (entry as { id?: unknown }).id === "string"
            ? ((entry as { id: string }).id as string)
            : null,
      )
      .filter((id): id is string => Boolean(id))
      .slice(0, 200);
    return { baseUrl, live: ids };
  } catch {
    return { baseUrl, live: null };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (request.method === "GET" && url.pathname === "/models") {
      // Static catalog (no DO activation) + live router ids + env status,
      // so you can fetch, choose, and set sight unseen.
      const models = buildModels(env);
      const catalog = models
        .getModels()
        .map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
      let def: { provider: string; id: string } | null = null;
      try {
        def = resolveDefaultModel(env, models);
      } catch {
        def = null;
      }
      const router = await fetchRouterLiveModels(env);
      return Response.json({
        default: def,
        configured: {
          router: Boolean(nonEmpty(env?.ROUTER_MODEL) || nonEmpty(env?.ROUTER_BASE_URL)),
          "opencode-go": Boolean(nonEmpty(env?.OPENCODE_API_KEY)),
          openai: Boolean(nonEmpty(env?.OPENAI_API_KEY)),
          google: Boolean(nonEmpty(env?.GEMINI_API_KEY)),
        },
        catalog,
        router,
      });
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
      const model = (body as { model?: unknown }).model;
      try {
        ensureConfigured(env);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
      const name = decodeURIComponent(promptMatch[1]);
      const stub = getAssistantStub(env, name);
      try {
        const result = await stub.ask(prompt, requestId, model);
        return Response.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/^(unknown model|malformed model)/.test(message)) {
          return Response.json({ error: message }, { status: 400 });
        }
        throw err;
      }
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
