import { Agent } from "agents";
import { DurableObject } from "cloudflare:workers";
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
  REGISTRY: DurableObjectNamespace;
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
// DO-storage key for the model this fleet last pinned a session to.
const MODEL_FINGERPRINT_KEY = "fleet:modelFingerprint:v1";

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

function routerModelEntry(
  id: string,
  baseUrl: string,
  live?: { contextWindow?: number; maxTokens?: number },
): Model<"openai-completions"> {
  return {
    id,
    name: `${id} (router)`,
    api: "openai-completions",
    provider: ROUTER_PROVIDER,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Live router limits win when known (e.g. 1M-context gateways);
    // otherwise conservative generic defaults.
    contextWindow: live?.contextWindow ?? 128000,
    maxTokens: live?.maxTokens ?? 16384,
  };
}

// Live limits keyed by model id, from the router's OpenAI-compatible
// /models endpoint. Empty when unreachable — callers keep static defaults.
function liveLimitsMap(
  info: readonly { id: string; contextWindow?: number; maxTokens?: number }[],
): Map<string, { contextWindow?: number; maxTokens?: number }> {
  return new Map(info.map((entry) => [entry.id, entry]));
}

// Every provider this fleet knows about. The custom router and OpenCode Go
// are always registered (env-driven); OpenAI/Google stay registered so they
// keep working when their keys are present. Nothing here does I/O, except an
// optional live-limits overlay passed in by async callers.
function buildModels(
  env: Env,
  live?: Map<string, { contextWindow?: number; maxTokens?: number }>,
): MutableModels {
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
      models: uniqueIds.map((id) => routerModelEntry(id, routerBase, live?.get(id))),
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
      // Best-effort: adopt the router's real context/output limits so pi
      // manages long transcripts against true capacity. Unreachable router
      // (or no key yet) keeps the conservative static defaults.
      const router = await fetchRouterLiveModels(env);
      const models = buildModels(env, liveLimitsMap(router.info));
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
    const env = this.env as Env;
    const models = this.modelsRef ?? buildModels(env);
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
      await this.markPinnedModel(wanted);
    } else {
      // Heal stale pins: sessions durably remember their model, so an agent
      // created under an old default (or old env) would otherwise keep using
      // a provider that is no longer configured. Migrate to the current
      // default only when it moved; explicit pins are left alone.
      const def = resolveDefaultModel(env, models);
      if (!(await this.pinnedModelMatches(def))) {
        await this.harness.session().setModel(def);
        await this.markPinnedModel(def);
      }
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
    // `reason` is pi's own words for why an `unanswered` run ended (failed,
    // aborted, withdrawn). Always surface it — without it, failures are silent.
    const reason = (res as unknown as { reason?: string }).reason ?? null;
    return { text, submissionId, operationId: submissionId, status, reason };
  }

  async listModels() {
    const env = this.env as Env;
    const models = this.modelsRef ?? buildModels(env);
    return models
      .getModels()
      .map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
  }

  // Transcript tail for debugging: pi records generation failures here, so a
  // terse `reason: "model_error"` can be traced to the underlying message.
  async recentMessages(limit?: unknown) {
    const count =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.min(Math.max(Math.floor(limit), 1), 100)
        : 20;
    const entries = await this.harness.session().messages();
    return entries.slice(-count).map((entry) => summarizeEntry(entry));
  }

  // Fresh context for this agent (clears the transcript). The next prompt
  // re-applies the pin/heal logic in ask(), so a reset also picks up a moved
  // default model.
  async resetSession() {
    await this.harness.session().reset();
    return true;
  }

  // Which model WE last pinned this session to, in DO storage (survives
  // eviction; pi's own tables are untouched). Absent for pre-upgrade
  // sessions, which then count as moved and get migrated.
  private modelFingerprint(model: { provider: string; id: string }): string {
    return `${model.provider}/${model.id}`;
  }

  private async pinnedModelMatches(model: { provider: string; id: string }): Promise<boolean> {
    try {
      const stored = await this.ctx.storage.get<string>(MODEL_FINGERPRINT_KEY);
      return stored === this.modelFingerprint(model);
    } catch {
      return false;
    }
  }

  private async markPinnedModel(model: { provider: string; id: string }): Promise<void> {
    try {
      await this.ctx.storage.put(MODEL_FINGERPRINT_KEY, this.modelFingerprint(model));
    } catch {
      // Best effort: a missed mark just re-pins next prompt.
    }
  }
}

// Name -> activity index for the fleet, in one plain Durable Object (not an
// Agent: this needs storage, not a model). Lives in the same fleet/bucket as
// the assistants. Stores names + counters only, never prompt text.
const REGISTRY_PREFIX = "agent:";
const REGISTRY_INSTANCE = "global";
const MAX_AGENT_NAME_LENGTH = 128;

interface RegistryEntry {
  name: string;
  lastActive: string;
  prompts: number;
}

interface RegistryRecord {
  lastActive: string;
  prompts: number;
}

function normalizeAgentName(raw: string): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new Error("agent name must be non-empty");
  if (name.includes("/")) throw new Error("agent name must not contain '/'");
  if ([...name].length > MAX_AGENT_NAME_LENGTH) {
    throw new Error(`agent name must be at most ${MAX_AGENT_NAME_LENGTH} characters`);
  }
  return name;
}

export class Registry extends DurableObject {
  // Called once per prompt POST, including idempotent replays (the prompt run
  // dedupes, the touch does not).
  async touch(name: string): Promise<void> {
    const key = `${REGISTRY_PREFIX}${normalizeAgentName(name)}`;
    const prev = (await this.ctx.storage.get<RegistryRecord>(key)) ?? { prompts: 0 };
    await this.ctx.storage.put(key, {
      lastActive: new Date().toISOString(),
      prompts: (prev.prompts ?? 0) + 1,
    });
  }

  // Most recently active first; `prefix` filters decoded names.
  async list(limit = 100, prefix?: string): Promise<RegistryEntry[]> {
    const stored = await this.ctx.storage.list<RegistryRecord>({
      prefix: REGISTRY_PREFIX,
    });
    const entries = [...stored.entries()]
      .map(([key, value]) => ({
        name: key.slice(REGISTRY_PREFIX.length),
        lastActive: value?.lastActive ?? "",
        prompts: value?.prompts ?? 0,
      }))
      .filter((entry) => !prefix || entry.name.startsWith(prefix));
    entries.sort((a, b) =>
      a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0,
    );
    return entries.slice(0, limit);
  }
}

// One JSON-safe line per transcript entry: kind + a short text preview.
// Shapes vary (model messages, tool calls, error payloads), so this is
// deliberately defensive — unknown shapes fall back to a JSON snippet.
function summarizeEntry(entry: {
  id?: unknown;
  kind?: unknown;
  model?: unknown;
  data?: unknown;
}): { id: unknown; kind: unknown; preview: string } {
  const texts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) texts.push(value.trim());
  };
  const walk = (node: unknown, depth: number): void => {
    if (texts.join("\n").length > 800 || depth > 4) return;
    if (typeof node === "string") {
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      // Prefer human-meaningful keys first.
      for (const key of ["text", "thinking", "errorMessage", "error", "reason", "message"]) {
        if (typeof record[key] === "string") push(record[key] as string);
      }
      if (typeof record["name"] === "string" && typeof record["arguments"] !== "undefined") {
        push(`tool:${record["name"] as string}`);
      }
      for (const value of Object.values(record)) {
        if (value && typeof value === "object") walk(value, depth + 1);
      }
    }
  };
  walk((entry as { model?: unknown }).model, 0);
  walk((entry as { data?: unknown }).data, 0);
  const joined = texts.join("\n");
  const preview = joined.length > 800 ? `${joined.slice(0, 800)}…` : joined;
  return {
    id: (entry as { id?: unknown }).id ?? null,
    kind: (entry as { kind?: unknown }).kind ?? null,
    preview: preview || "(no text content)",
  };
}

function getAssistantStub(env: Env, name: string) {
  const binding = env.ASSISTANT as unknown as {
    getByName?: (name: string) => {
      ask: (...args: unknown[]) => Promise<unknown>;
      listModels: () => Promise<unknown>;
      recentMessages: (...args: unknown[]) => Promise<unknown>;
      resetSession: () => Promise<unknown>;
    };
    idFromName?: (name: string) => unknown;
    get?: (id: unknown) => {
      ask: (...args: unknown[]) => Promise<unknown>;
      listModels: () => Promise<unknown>;
      recentMessages: (...args: unknown[]) => Promise<unknown>;
      resetSession: () => Promise<unknown>;
    };
  };
  if (typeof binding.getByName === "function") return binding.getByName(name);
  if (typeof binding.idFromName === "function" && typeof binding.get === "function") {
    return binding.get(binding.idFromName(name));
  }
  throw new Error("ASSISTANT binding has neither getByName nor idFromName/get");
}

type RegistryStub = {
  touch: (name: string) => Promise<unknown>;
  list: (limit: number, prefix?: string) => Promise<RegistryEntry[]>;
};

function getRegistryStub(env: Env): RegistryStub {
  const binding = env.REGISTRY as unknown as {
    getByName?: (name: string) => RegistryStub;
    idFromName?: (name: string) => unknown;
    get?: (id: unknown) => RegistryStub;
  };
  if (typeof binding.getByName === "function") {
    return binding.getByName(REGISTRY_INSTANCE);
  }
  if (typeof binding.idFromName === "function" && typeof binding.get === "function") {
    return binding.get(binding.idFromName(REGISTRY_INSTANCE));
  }
  throw new Error("REGISTRY binding has neither getByName nor idFromName/get");
}

async function fetchRouterLiveModels(env: Env): Promise<{
  baseUrl: string;
  live: string[] | null;
  info: { id: string; contextWindow?: number; maxTokens?: number }[];
}> {
  const baseUrl = (nonEmpty(env?.ROUTER_BASE_URL) ?? DEFAULT_ROUTER_BASE_URL).replace(/\/+$/, "");
  const empty = { baseUrl, live: null as string[] | null, info: [] as { id: string; contextWindow?: number; maxTokens?: number }[] };
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    const key = nonEmpty(env?.ROUTER_API_KEY);
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return empty;
    const body = (await res.json()) as unknown;
    const list = Array.isArray(body)
      ? body
      : Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : [];
    const info = list.flatMap((entry) => {
      const id =
        typeof entry === "string"
          ? entry
          : typeof (entry as { id?: unknown }).id === "string"
            ? ((entry as { id: string }).id as string)
            : null;
      if (!id) return [];
      if (typeof entry === "string") return [{ id }];
      const record = entry as Record<string, unknown>;
      const caps = (record["capabilities"] ?? {}) as Record<string, unknown>;
      return [
        {
          id,
          contextWindow:
            num(record["context_length"]) ?? num(record["contextWindow"]) ?? num(caps["contextWindow"]),
          maxTokens:
            num(record["max_completion_tokens"]) ??
            num(record["maxOutput"]) ??
            num(record["maxTokens"]) ??
            num(caps["maxOutput"]),
        },
      ];
    });
    return { baseUrl, live: info.map((entry) => entry.id).slice(0, 200), info };
  } catch {
    return empty;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (request.method === "GET" && url.pathname === "/models") {
      // Static catalog (no DO activation) + live router ids/limits + env
      // status, so you can fetch, choose, and set sight unseen. Router
      // entries carry live context/output limits when the router answers.
      const router = await fetchRouterLiveModels(env);
      const models = buildModels(env, liveLimitsMap(router.info));
      const catalog = models
        .getModels()
        .map((m) => ({
          provider: m.provider,
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        }));
      let def: { provider: string; id: string } | null = null;
      try {
        def = resolveDefaultModel(env, models);
      } catch {
        def = null;
      }
      return Response.json({
        default: def,
        configured: {
          router: Boolean(nonEmpty(env?.ROUTER_MODEL) || nonEmpty(env?.ROUTER_BASE_URL)),
          "opencode-go": Boolean(nonEmpty(env?.OPENCODE_API_KEY)),
          openai: Boolean(nonEmpty(env?.OPENAI_API_KEY)),
          google: Boolean(nonEmpty(env?.GEMINI_API_KEY)),
        },
        catalog,
        router: { baseUrl: router.baseUrl, live: router.live },
      });
    }

    if (request.method === "GET" && url.pathname === "/agents") {
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit =
        rawLimit === null || rawLimit.trim() === "" ? NaN : Number(rawLimit);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(Math.floor(parsedLimit), 1), 1000)
        : 100;
      const prefix = url.searchParams.get("prefix") || undefined;
      try {
        const agents = await getRegistryStub(env).list(limit, prefix);
        return Response.json({ agents, count: agents.length });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
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
      // Best effort: registry bookkeeping must never fail a prompt.
      try {
        await getRegistryStub(env).touch(name);
      } catch {
        // Ignored by design.
      }
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

    const messagesMatch = url.pathname.match(/^\/agent\/([^/]+)\/messages$/);
    if (messagesMatch && request.method === "GET") {
      const name = decodeURIComponent(messagesMatch[1]);
      const rawLimit = url.searchParams.get("limit");
      const parsed = rawLimit === null ? undefined : Number(rawLimit);
      const stub = getAssistantStub(env, name);
      const messages = await stub.recentMessages(parsed);
      return Response.json({ name, messages });
    }

    const resetMatch = url.pathname.match(/^\/agent\/([^/]+)\/reset$/);
    if (resetMatch && request.method === "POST") {
      const name = decodeURIComponent(resetMatch[1]);
      const stub = getAssistantStub(env, name);
      await stub.resetSession();
      return Response.json({ name, reset: true });
    }

    return new Response("not found", { status: 404 });
  },
};
