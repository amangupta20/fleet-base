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
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  section,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import {
  DaemonEnv,
  type SandboxTier,
  type WorkspaceBinding,
} from "./box-env.ts";

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
  // Loopback box executor (scripts/box.mjs). Default:
  // http://127.0.0.1:9877. Loopback only; the daemon refuses anything else.
  FLEET_EXECUTOR_URL?: string;
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

function badRequest(err: unknown): Response {
  return Response.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status: 400 },
  );
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

// HTTP-layer model check, run before the registry touch so a rejected model
// never counts as activity.
function assertKnownModel(env: Env, model: unknown): void {
  const wanted = parseModelRef(model);
  if (!wanted) return;
  if (!buildModels(env).getModel(wanted.provider, wanted.id)) {
    throw new Error(
      `unknown model "${wanted.provider}/${wanted.id}"; see GET /models for the catalog`,
    );
  }
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

// ---- working files -------------------------------------------------------

const ROOT_CONVERSATION_ID = "1";
const WORKSPACE_KEY_PREFIX = "fleet:workspace:v1:";
const SANDBOX_TIER_KEY_PREFIX = "fleet:sandboxTier:v1:";
const SANDBOX_QUOTA_KEY_PREFIX = "fleet:sandboxQuota:v1:";
const DEFAULT_EXECUTOR_URL = "http://127.0.0.1:9877";
const DEFAULT_QUOTA_MB = 200;
const MAX_QUOTA_MB = 4096;

type WorkspaceRecord = WorkspaceBinding;

function workspaceKey(conversationId: string): string {
  return `${WORKSPACE_KEY_PREFIX}${conversationId}`;
}

function tierKey(conversationId: string): string {
  return `${SANDBOX_TIER_KEY_PREFIX}${conversationId}`;
}

function quotaKey(conversationId: string): string {
  return `${SANDBOX_QUOTA_KEY_PREFIX}${conversationId}`;
}

function parseSandboxTier(value: unknown): SandboxTier {
  if (value === "t0" || value === "t1") return value;
  throw new Error('sandbox must be "t0" or "t1"');
}

function parseQuota(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_QUOTA_MB) {
    throw new Error(`quotaMb must be an integer from 1 to ${MAX_QUOTA_MB}`);
  }
  return number;
}

function executorUrl(env: Env): string {
  const raw = nonEmpty(env?.FLEET_EXECUTOR_URL) ?? DEFAULT_EXECUTOR_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`FLEET_EXECUTOR_URL is not a URL: ${raw}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error("FLEET_EXECUTOR_URL must be http:// (the box binds loopback)");
  }
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("FLEET_EXECUTOR_URL must point at loopback");
  }
  return raw.replace(/\/+$/, "");
}

async function daemonJson(
  url: string,
  options: {
    body?: unknown;
    token?: string;
    workspace?: string;
    timeoutMs?: number;
  },
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.workspace
          ? { "x-fleet-workspace": options.workspace }
          : {}),
      },
      body: JSON.stringify(options.body ?? {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new Error(
      `box executor is unreachable at ${new URL(url).origin}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const codingTools = createCodingTools();

function requireCodingTool(name: string) {
  const tool = codingTools.tools?.find((entry) => entry.name === name);
  if (!tool) throw new Error(`pi-durable coding tool ${name} is missing`);
  return tool;
}

const readTool = {
  ...requireCodingTool("read"),
  replay: "safe" as const,
};

const writeTool = {
  ...requireCodingTool("write"),
  replay: "unsafe" as const,
};

const editTool = {
  ...requireCodingTool("edit"),
  replay: "unsafe" as const,
};

const bashBase = requireCodingTool("bash");
const bashTool = {
  ...bashBase,
  replay: "unsafe" as const,
  execute: (
    args: { command: string; timeout?: number },
    api: Parameters<typeof bashBase.execute>[1],
    context: Parameters<typeof bashBase.execute>[2],
  ) => {
    const requested =
      typeof args.timeout === "number" && Number.isFinite(args.timeout)
        ? args.timeout
        : 120;
    return bashBase.execute(
      { ...args, timeout: Math.min(Math.max(requested, 1), 120) },
      api,
      context,
    );
  },
};

function boxEnv(api: { env?: unknown }): DaemonEnv {
  if (!(api.env instanceof DaemonEnv)) {
    throw new Error("this tool needs the fleet box environment");
  }
  return api.env;
}

const gitCloneTool = defineTool({
  name: "git_clone",
  description:
    "Clone an https git repository into /workspace. Local, private, and non-https URLs are rejected by the box. Replay-unsafe: a crash may leave a partial clone.",
  parameters: Type.Object({
    url: Type.String({ description: "https:// repository URL" }),
    dir: Type.Optional(
      Type.String({ description: "Optional simple directory name; defaults to the repo name" }),
    ),
  }),
  replay: "unsafe",
  async execute({ url, dir }, api) {
    const env = boxEnv(api);
    const result = await env.request<{ path: string; stderr?: string }>(
      "/git/clone",
      { url, ...(dir ? { dir } : {}) },
      { timeoutMs: 310_000 },
    );
    const note = result.stderr?.trim();
    return {
      output: [
        {
          type: "text",
          text: `Cloned ${url} to ${result.path}${note ? `\n${note}` : ""}`,
        },
      ],
      details: { path: result.path },
    };
  },
});

const gitStatusTool = defineTool({
  name: "git_status",
  description:
    "Show `git status --porcelain=v1` for a directory in /workspace. Read-only and replay-safe.",
  parameters: Type.Object({
    repo: Type.Optional(
      Type.String({ description: "Workspace-relative repository path; default ." }),
    ),
  }),
  replay: "safe",
  async execute({ repo }, api) {
    const env = boxEnv(api);
    const result = await env.request<{ path: string; stdout: string }>(
      "/git/status",
      { repo: repo ?? "." },
      { timeoutMs: 60_000 },
    );
    return {
      output: [
        {
          type: "text",
          text: result.stdout.trim() || `clean (${result.path})`,
        },
      ],
      details: { path: result.path },
    };
  },
});

const workspaceSection = section("workspace", (input) => {
  if (input.env instanceof DaemonEnv) return input.env.describe();
  return [
    "No box workspace is available.",
    "Do not claim a path exists or quote file contents unless a tool confirms it.",
  ].join("\n");
});

const codingExtension = defineExtension({
  name: "fleet-coding",
  tools: [readTool, writeTool, editTool, bashTool, gitCloneTool, gitStatusTool],
  sections: [workspaceSection],
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
      this.registry.install(codingExtension);
      // Best-effort: adopt the router's real context/output limits so pi
      // manages long transcripts against true capacity. Unreachable router
      // (or no key yet) keeps the conservative static defaults.
      const router = await fetchRouterLiveModels(env);
      const models = buildModels(env, liveLimitsMap(router.info));
      this.modelsRef = models;
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          // The Worker cannot touch host files or spawn processes; every
          // coding tool call goes through the loopback box daemon.
          env: (target) => this.openBoxEnv(target),
        },
        context,
      );
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

  // ConversationId is only unique inside one Durable Object; every Assistant
  // starts at "1". The workspace id therefore includes the DO id, so two
  // agents never share a directory.
  private workspaceId(conversationId: string): string {
    return `${String(this.ctx.id)}-${conversationId}`;
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

  // Fresh context for this agent (clears the transcript and the local
  // workspace). The next prompt re-applies the pin/heal logic in ask(), so a
  // reset also picks up a moved default model.
  async resetSession() {
    const conversationId = ROOT_CONVERSATION_ID;
    const workspaceId = this.workspaceId(conversationId);
    let workspaceDeleted = false;
    const record = await this.workspaceRecord(conversationId);
    if (record) {
      try {
        const base = executorUrl(this.env as Env);
        let result = await daemonJson(`${base}/workspace/reset`, {
          token: record.token,
          workspace: workspaceId,
          timeoutMs: 15_000,
        });
        if (result.status === 401 || result.status === 409) {
          const next = await this.handshakeWorkspace(
            conversationId,
            workspaceId,
            record.tier,
            record.quotaMb,
            record,
          );
          result = await daemonJson(`${base}/workspace/reset`, {
            token: next.token,
            workspace: next.id,
            timeoutMs: 15_000,
          });
        }
        if (result.status === 200) {
          workspaceDeleted = true;
          await this.ctx.storage.delete(workspaceKey(conversationId));
          this.workspaceBindings.delete(conversationId);
        }
      } catch {
        // The daemon is down. The transcript reset below is still durable; the
        // workspace record stays so a later reset can delete the files.
      }
    }
    await this.harness.session().reset();
    return { reset: true, workspaceDeleted };
  }

  // Tier and quota are app config, not pi.agent fields: pi.agent has no
  // extension point for application data. They live in the same DO SQLite
  // database under their own keys and are read again on every env build.
  async setSandboxConfig(sandbox?: unknown, quotaMb?: unknown) {
    const conversationId = ROOT_CONVERSATION_ID;
    const workspaceId = this.workspaceId(conversationId);
    const tier =
      sandbox === undefined
        ? await this.sandboxTier(conversationId)
        : parseSandboxTier(sandbox);
    const quota =
      quotaMb === undefined
        ? await this.sandboxQuota(conversationId)
        : parseQuota(quotaMb);
    await this.ctx.storage.put(tierKey(conversationId), tier);
    await this.ctx.storage.put(quotaKey(conversationId), quota);
    this.workspaceBindings.delete(conversationId);
    const record = await this.workspaceRecord(conversationId);
    if (record) {
      try {
        const next = await this.handshakeWorkspace(
          conversationId,
          workspaceId,
          tier,
          quota,
          record,
        );
        this.workspaceBindings.set(conversationId, next);
      } catch {
        // Keep the old record; the next env build sees the tier/quota
        // mismatch and re-handshakes before the first tool call.
      }
    }
    return { sandbox: tier, quotaMb: quota };
  }

  private readonly workspaceBindings = new Map<string, WorkspaceBinding>();

  private async openBoxEnv(target: {
    conversationId: unknown;
  }): Promise<DaemonEnv> {
    const conversationId = String(target.conversationId);
    const workspaceId = this.workspaceId(conversationId);
    const tier = await this.sandboxTier(conversationId);
    const quotaMb = await this.sandboxQuota(conversationId);
    const record = await this.workspaceRecord(conversationId);
    const cached = this.workspaceBindings.get(conversationId) ?? record;
    let binding: WorkspaceBinding;
    if (cached && cached.tier === tier && cached.quotaMb === quotaMb) {
      // A cached token or DO record can outlive a box migration. /health is
      // cheap and unauthenticated; if the box id moved, handshake before the
      // system prompt is rendered so <workspace> already carries lostFrom.
      const live = await this.liveBoxId();
      binding =
        live === cached.boxId
          ? cached
          : await this.handshakeWorkspace(
              conversationId,
              workspaceId,
              tier,
              quotaMb,
              cached,
            );
    } else {
      binding = await this.handshakeWorkspace(
        conversationId,
        workspaceId,
        tier,
        quotaMb,
        record,
      );
    }
    this.workspaceBindings.set(conversationId, binding);
    return new DaemonEnv({
      baseUrl: executorUrl(this.env as Env),
      binding,
      rehandshake: async () => {
        const next = await this.handshakeWorkspace(
          conversationId,
          workspaceId,
          tier,
          quotaMb,
        );
        this.workspaceBindings.set(conversationId, next);
        return next;
      },
    });
  }

  private async liveBoxId(): Promise<string> {
    const base = executorUrl(this.env as Env);
    let response: Response;
    try {
      response = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      throw new Error(
        `box executor is unreachable at ${base}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      throw new Error(`box executor /health returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { boxId?: unknown };
    if (typeof body.boxId !== "string" || !body.boxId) {
      throw new Error("box executor /health returned no box id");
    }
    return body.boxId;
  }

  private async sandboxTier(conversationId: string): Promise<SandboxTier> {
    const stored = await this.ctx.storage.get<string>(tierKey(conversationId));
    return stored === "t1" ? "t1" : "t0";
  }

  private async sandboxQuota(conversationId: string): Promise<number> {
    const stored = await this.ctx.storage.get<number>(quotaKey(conversationId));
    return typeof stored === "number" && stored > 0 ? stored : DEFAULT_QUOTA_MB;
  }

  private async workspaceRecord(
    conversationId: string,
  ): Promise<WorkspaceRecord | null> {
    const stored = await this.ctx.storage.get<WorkspaceRecord>(
      workspaceKey(conversationId),
    );
    return stored && typeof stored.token === "string" ? stored : null;
  }

  private async handshakeWorkspace(
    conversationId: string,
    workspaceId: string,
    tier: SandboxTier,
    quotaMb: number,
    previous?: WorkspaceRecord | null,
  ): Promise<WorkspaceRecord> {
    const base = executorUrl(this.env as Env);
    const prior = previous ?? (await this.workspaceRecord(conversationId));
    const { status, json } = await daemonJson(`${base}/workspace`, {
      body: { id: workspaceId, tier, quotaMb },
      timeoutMs: 10_000,
    });
    if (status !== 200 || !json) {
      const message =
        typeof json?.error === "object" &&
        json.error &&
        typeof (json.error as { message?: unknown }).message === "string"
          ? ((json.error as { message: string }).message)
          : `box /workspace failed with HTTP ${status}`;
      throw new Error(message);
    }
    const token = typeof json.token === "string" ? json.token : "";
    const boxId = typeof json.boxId === "string" ? json.boxId : "";
    if (!token || !boxId) {
      throw new Error("box /workspace returned no token or box id");
    }
    const lostFrom =
      typeof json.lostFrom === "string"
        ? json.lostFrom
        : prior && prior.boxId !== boxId
          ? prior.boxId
          : prior?.lostFrom;
    const record: WorkspaceRecord = {
      id: workspaceId,
      token,
      tier,
      quotaMb,
      boxId,
      ...(lostFrom ? { lostFrom } : {}),
    };
    await this.ctx.storage.put(workspaceKey(conversationId), record);
    return record;
  }

  // Debug/support view of the box side: no token, just the deterministic
  // directory id. Used by /state and E2E scripts.
  async workspaceState() {
    return { workspace: this.workspaceId(ROOT_CONVERSATION_ID) };
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

// Every route resolves a name through this, so encoded and plain spellings
// (e.g. "%20alice%20" vs "alice") always address the same assistant.
function agentNameFromPath(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error("agent name is not valid percent-encoding");
  }
  return normalizeAgentName(decoded);
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
      setSandboxConfig: (
        sandbox?: unknown,
        quotaMb?: unknown,
      ) => Promise<unknown>;
      workspaceState: () => Promise<unknown>;
    };
    idFromName?: (name: string) => unknown;
    get?: (id: unknown) => {
      ask: (...args: unknown[]) => Promise<unknown>;
      listModels: () => Promise<unknown>;
      recentMessages: (...args: unknown[]) => Promise<unknown>;
      resetSession: () => Promise<unknown>;
      setSandboxConfig: (
        sandbox?: unknown,
        quotaMb?: unknown,
      ) => Promise<unknown>;
      workspaceState: () => Promise<unknown>;
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
      let name: string;
      try {
        name = agentNameFromPath(promptMatch[1]);
      } catch (err) {
        return badRequest(err);
      }
      try {
        ensureConfigured(env);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
      // Model validation runs before the registry touch, so a rejected model
      // never counts as activity.
      try {
        assertKnownModel(env, model);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/^(unknown model|malformed model)/.test(message)) {
          return Response.json({ error: message }, { status: 400 });
        }
        throw err;
      }
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
      let name: string;
      try {
        name = agentNameFromPath(stateMatch[1]);
      } catch (err) {
        return badRequest(err);
      }
      // Best effort, deliberately coarse: the binding is addressable and
      // celld activates the cell on demand, so we report resident:true once
      // the route itself is reachable. The workspace id is derived from the DO
      // id; the token is never returned.
      const stub = getAssistantStub(env, name);
      const workspace = (await stub.workspaceState()) as Record<string, unknown>;
      return Response.json({ name, resident: true, ...workspace });
    }

    const messagesMatch = url.pathname.match(/^\/agent\/([^/]+)\/messages$/);
    if (messagesMatch && request.method === "GET") {
      let name: string;
      try {
        name = agentNameFromPath(messagesMatch[1]);
      } catch (err) {
        return badRequest(err);
      }
      const rawLimit = url.searchParams.get("limit");
      const parsed = rawLimit === null ? undefined : Number(rawLimit);
      const stub = getAssistantStub(env, name);
      const messages = await stub.recentMessages(parsed);
      return Response.json({ name, messages });
    }

    const configMatch = url.pathname.match(/^\/agent\/([^/]+)\/config$/);
    if (configMatch && request.method === "POST") {
      let name: string;
      try {
        name = agentNameFromPath(configMatch[1]);
      } catch (err) {
        return badRequest(err);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const sandbox = (body as { sandbox?: unknown }).sandbox;
      const quotaMb = (body as { quotaMb?: unknown }).quotaMb;
      if (sandbox === undefined && quotaMb === undefined) {
        return Response.json(
          { error: "body needs sandbox (\"t0\"|\"t1\") or quotaMb" },
          { status: 400 },
        );
      }
      const stub = getAssistantStub(env, name);
      try {
        const result = (await stub.setSandboxConfig(sandbox, quotaMb)) as {
          sandbox?: unknown;
          quotaMb?: unknown;
        };
        return Response.json({ name, ...result });
      } catch (err) {
        return badRequest(err);
      }
    }

    const resetMatch = url.pathname.match(/^\/agent\/([^/]+)\/reset$/);
    if (resetMatch && request.method === "POST") {
      let name: string;
      try {
        name = agentNameFromPath(resetMatch[1]);
      } catch (err) {
        return badRequest(err);
      }
      const stub = getAssistantStub(env, name);
      const result = (await stub.resetSession()) as {
        workspaceDeleted?: unknown;
      };
      return Response.json({
        name,
        reset: true,
        workspaceDeleted: result?.workspaceDeleted === true,
      });
    }

    return new Response("not found", { status: 404 });
  },
};
