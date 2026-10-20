#!/usr/bin/env node
// Loopback workspace executor for fleet-base.
//
// celld's Worker is a V8 isolate: node:fs is read-only/empty and
// node:child_process is not implemented. This daemon owns the box side of
// pi-durable's ExecutionEnv. It keeps one directory per conversation under
// .celld/workspaces/, checks every path against that root, and runs tier-1
// commands under bwrap.
//
// Protocol: JSON over loopback. `POST /workspace {id}` issues (or rotates) a
// workspace token; the Worker stores it in DO SQLite. Every other route needs
// `Authorization: Bearer <token>` and `X-Fleet-Workspace: <id>`. The daemon
// persists only SHA-256 token hashes in .celld/workspaces/index.json.
//
// See docs/specs/workspaces-pr1.md.

import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOOPBACK = "127.0.0.1";
const EXECUTOR_URL =
  process.env.FLEET_EXECUTOR_URL?.trim() || "http://127.0.0.1:9877";
let executorPort = 9877;
try {
  const parsed = new URL(EXECUTOR_URL);
  if (parsed.protocol !== "http:") throw new Error("must be http://");
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("FLEET_EXECUTOR_URL must point at loopback");
  }
  executorPort = Number(parsed.port || 9877);
  if (!Number.isInteger(executorPort) || executorPort < 1 || executorPort > 65535) {
    throw new Error("invalid port");
  }
} catch (error) {
  console.error(
    `[box] invalid FLEET_EXECUTOR_URL ${JSON.stringify(EXECUTOR_URL)}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}
const PORT = executorPort;
const HOST = LOOPBACK;
const WORKSPACES_ROOT = resolve(
  process.env.FLEET_BOX_ROOT ?? join(ROOT, ".celld", "workspaces"),
);
const INDEX_FILE = join(WORKSPACES_ROOT, "index.json");
const BOX_ID_FILE = resolve(
  process.env.FLEET_BOX_ID_FILE ?? join(ROOT, ".celld", "box-id"),
);
const BWRAP = existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : "bwrap";
const BWRAP_AVAILABLE = existsSync("/usr/bin/bwrap");
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const EXEC_TIMEOUT_MS = positiveInt(process.env.FLEET_EXEC_TIMEOUT_MS, 120_000);
const CLONE_TIMEOUT_MS = positiveInt(process.env.FLEET_CLONE_TIMEOUT_MS, 300_000);
const DEFAULT_QUOTA_MB = 200;
const VIRTUAL_ROOT = "/workspace";
const MARKER = ".fleet-workspace";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_IDS = new Set(["index", "index.json"]);
const TIERS = new Set(["t0", "t1"]);
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const activeExecs = new Map();

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

class BoxError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new BoxError(status, code, message);
}

function loadBoxId() {
  const override = process.env.FLEET_BOX_ID?.trim();
  if (override) return override;
  try {
    const stored = readFileSync(BOX_ID_FILE, "utf8").trim();
    if (stored) return stored;
  } catch {
    // Missing: create below.
  }
  const id = `box-${randomUUID()}`;
  mkdirSync(dirname(BOX_ID_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(BOX_ID_FILE, `${id}\n`, { mode: 0o600 });
  return id;
}

const BOX_ID = loadBoxId();

function workspaceDir(id) {
  if (
    typeof id !== "string" ||
    !ID_PATTERN.test(id) ||
    RESERVED_IDS.has(id)
  ) {
    fail(
      400,
      "bad_workspace",
      "workspace id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127} and not be reserved",
    );
  }
  const dir = resolve(WORKSPACES_ROOT, id);
  assertInside(WORKSPACES_ROOT, dir, "workspace");
  return dir;
}

function assertInside(root, target, label) {
  if (target !== root && !target.startsWith(root + sep)) {
    fail(400, "path_escape", `${label} escapes the workspace`);
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokensEqual(expectedHash, suppliedToken) {
  if (typeof expectedHash !== "string" || typeof suppliedToken !== "string") {
    return false;
  }
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashToken(suppliedToken), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readIndex() {
  try {
    const parsed = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.workspaces &&
      typeof parsed.workspaces === "object"
    ) {
      return parsed;
    }
  } catch {
    // Missing or corrupt: start empty. Existing tokens then re-handshake.
  }
  return { version: 1, workspaces: {} };
}

function writeIndex(index) {
  mkdirSync(WORKSPACES_ROOT, { recursive: true, mode: 0o700 });
  const tmp = `${INDEX_FILE}.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, INDEX_FILE);
}

function quotaMbFor(entry) {
  const value = Number(entry?.quotaMb);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_QUOTA_MB;
}

function bytesFor(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = join(current, entry.name);
      try {
        const info = lstatSync(target);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(target);
        else total += info.size;
      } catch {
        // A concurrent delete is not a quota failure.
      }
    }
  };
  walk(dir);
  return total;
}

function checkQuota(dir, entry, extra = 0) {
  const bytes = bytesFor(dir);
  const quota = quotaMbFor(entry) * 1024 * 1024;
  if (bytes + extra > quota) {
    fail(
      413,
      "quota_exceeded",
      `workspace uses ${bytes} bytes; quota is ${quotaMbFor(entry)} MB`,
    );
  }
  return bytes;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      fail(413, "payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(400, "invalid_json", "body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(400, "invalid_json", "body must be a JSON object");
  }
  return parsed;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendError(res, error) {
  const status = error instanceof BoxError ? error.status : 500;
  const code = error instanceof BoxError ? error.code : "internal";
  const message =
    error instanceof BoxError
      ? error.message
      : "internal daemon error (details omitted)";
  sendJson(res, status, { error: { code, message } });
}

function bearer(req) {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
}

function authenticate(req, id) {
  const entry = readIndex().workspaces[id];
  if (!entry) fail(401, "unauthorized", "workspace is not enrolled");
  if (!tokensEqual(entry.tokenHash, bearer(req))) {
    fail(401, "unauthorized", "missing or invalid workspace token");
  }
  workspaceDir(id);
  return { entry };
}

function markerPath(dir) {
  return join(dir, MARKER);
}

function readMarker(dir) {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(dir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeMarker(dir, value) {
  writeFileSync(markerPath(dir), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function issueWorkspace(body) {
  const id = body.id;
  const dir = workspaceDir(id);
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(400, "bad_workspace", "workspace path is not a plain directory");
    }
    assertInside(WORKSPACES_ROOT, realpathSync(dir), "workspace");
  }
  const tier = body.tier === undefined ? "t0" : body.tier;
  if (!TIERS.has(tier)) fail(400, "bad_tier", 'tier must be "t0" or "t1"');
  const quotaMb =
    body.quotaMb === undefined ? DEFAULT_QUOTA_MB : Number(body.quotaMb);
  if (!Number.isInteger(quotaMb) || quotaMb < 1 || quotaMb > 4096) {
    fail(400, "bad_quota", "quotaMb must be an integer from 1 to 4096");
  }
  const index = readIndex();
  const previous = index.workspaces[id];
  if (previous?.tier === "t1" && tier === "t0") {
    for (const [pid, value] of activeExecs) {
      if (value.id === id) killTree(pid);
    }
  }
  let lostFrom;
  let created = !existsSync(dir);

  if (!created) {
    const marker = readMarker(dir);
    if (!marker) {
      writeMarker(dir, {
        id,
        boxId: BOX_ID,
        createdAt: new Date().toISOString(),
      });
    } else if (marker.boxId !== BOX_ID) {
      lostFrom = String(marker.boxId ?? "unknown");
      renameSync(dir, `${dir}.lost-${Date.now()}`);
      created = true;
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeMarker(dir, {
    id,
    boxId: BOX_ID,
    createdAt: readMarker(dir)?.createdAt ?? new Date().toISOString(),
  });

  const token = randomBytes(32).toString("hex");
  index.workspaces[id] = {
    tokenHash: hashToken(token),
    tier,
    quotaMb,
    boxId: BOX_ID,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  writeIndex(index);
  return {
    id,
    token,
    boxId: BOX_ID,
    tier,
    quotaMb,
    created,
    ...(lostFrom ? { lostFrom } : {}),
  };
}

function virtualFor(root, target) {
  const rel = relative(root, target);
  return rel ? posix.join(VIRTUAL_ROOT, rel.split(sep).join("/")) : VIRTUAL_ROOT;
}

function resolveInWorkspace(root, input) {
  if (typeof input !== "string" || input.length === 0) {
    fail(400, "bad_path", "path must be a non-empty string");
  }
  if (input.includes("\0")) fail(400, "bad_path", "path contains a NUL byte");
  let requested = input;
  if (requested === VIRTUAL_ROOT) {
    requested = ".";
  } else if (requested.startsWith(`${VIRTUAL_ROOT}/`)) {
    requested = requested.slice(VIRTUAL_ROOT.length + 1);
  } else if (isAbsolute(requested)) {
    fail(
      400,
      "path_escape",
      `absolute path ${JSON.stringify(input)} is outside ${VIRTUAL_ROOT}`,
    );
  }
  const lexical = resolve(root, requested);
  assertInside(root, lexical, "path");

  // lstat every existing component: a link that leaves the workspace is
  // rejected even before a missing file below it is created.
  const parts = relative(root, lexical).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      let real;
      try {
        real = realpathSync(current);
      } catch {
        fail(400, "path_escape", `broken symlink ${JSON.stringify(input)}`);
      }
      assertInside(root, real, "symlink");
    }
  }

  let probe = lexical;
  const suffix = [];
  while (!existsSync(probe)) {
    if (probe === root) break;
    suffix.unshift(basename(probe));
    probe = dirname(probe);
  }
  let realProbe;
  try {
    realProbe = realpathSync(probe);
  } catch {
    fail(404, "not_found", `path ${JSON.stringify(input)} does not exist`);
  }
  assertInside(root, realProbe, "path");
  const final = suffix.length > 0 ? resolve(realProbe, ...suffix) : realProbe;
  assertInside(root, final, "path");
  return final;
}

function openNoFollow(root, target, flags, mode) {
  const parent = realpathSync(dirname(target));
  // A parent swapped for an outside symlink between resolveInWorkspace() and
  // this open must not win: verify the real parent again, then O_NOFOLLOW the
  // leaf.
  assertInside(root, parent, "parent");
  const final = join(parent, basename(target));
  return { fd: openSync(final, flags | O_NOFOLLOW, mode), final };
}

function readBytes(root, target) {
  let opened;
  try {
    opened = openNoFollow(root, target, fsConstants.O_RDONLY);
  } catch (error) {
    if (error?.code === "ELOOP") {
      fail(400, "path_escape", "refusing to follow a symlink");
    }
    throw error;
  }
  try {
    return readFileSync(opened.fd);
  } finally {
    closeSync(opened.fd);
  }
}

function writeBytes(root, target, bytes) {
  if (basename(target) === MARKER) {
    fail(400, "reserved_path", `${MARKER} is managed by the box`);
  }
  mkdirSync(dirname(target), { recursive: true });
  let opened;
  try {
    opened = openNoFollow(
      root,
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
      0o600,
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      fail(400, "path_escape", "refusing to follow a symlink");
    }
    if (error?.code === "EISDIR") {
      fail(400, "not_a_file", `${basename(target)} is a directory`);
    }
    throw error;
  }
  try {
    writeFileSync(opened.fd, bytes);
  } finally {
    closeSync(opened.fd);
  }
  return opened.final;
}

function fsRead(id) {
  const dir = workspaceDir(id);
  return (body) => {
    const target = resolveInWorkspace(dir, body.path);
    let info;
    try {
      info = statSync(target);
    } catch {
      fail(404, "not_found", `file ${JSON.stringify(body.path)} does not exist`);
    }
    if (!info.isFile()) {
      fail(400, "not_a_file", `${body.path} is not a regular file`);
    }
    if (info.size > MAX_FILE_BYTES) {
      fail(413, "file_too_large", `${body.path} exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const bytes = readBytes(dir, target);
    const offset = Number(body.offset);
    const length = Number(body.length);
    const slice =
      Number.isInteger(offset) && offset >= 0
        ? bytes.subarray(
            offset,
            Number.isInteger(length) && length >= 0
              ? offset + length
              : undefined,
          )
        : bytes;
    if (body.binary === true) {
      return {
        path: virtualFor(dir, target),
        base64: slice.toString("base64"),
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    }
    return {
      path: virtualFor(dir, target),
      text: slice.toString("utf8"),
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  };
}

function fsWrite(id, entry) {
  const dir = workspaceDir(id);
  return (body) => {
    const target = resolveInWorkspace(dir, body.path);
    let bytes;
    if (typeof body.text === "string") {
      bytes = Buffer.from(body.text, "utf8");
    } else if (typeof body.base64 === "string") {
      bytes = Buffer.from(body.base64, "base64");
    } else {
      fail(400, "bad_body", "write needs text or base64");
    }
    if (bytes.length > MAX_FILE_BYTES) {
      fail(413, "file_too_large", `write exceeds ${MAX_FILE_BYTES} bytes`);
    }
    checkQuota(dir, entry, bytes.length);
    const written = writeBytes(dir, target, bytes);
    return { path: virtualFor(dir, written), bytes: bytes.length };
  };
}

function fsStat(id) {
  const dir = workspaceDir(id);
  return (body) => {
    const target = resolveInWorkspace(dir, body.path);
    let info;
    try {
      info = statSync(target);
    } catch {
      fail(404, "not_found", `path ${JSON.stringify(body.path)} does not exist`);
    }
    return {
      name: basename(target),
      path: virtualFor(dir, target),
      kind: info.isDirectory() ? "directory" : "file",
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  };
}

function fsCanonical(id) {
  const dir = workspaceDir(id);
  return (body) => {
    const target = resolveInWorkspace(dir, body.path);
    return { path: virtualFor(dir, target) };
  };
}

function bwrapArgs(workspace, net, extraEnv) {
  const args = [
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib", "/lib64",
    "--bind", workspace.root, "/workspace",
    "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    // No reaper PID 1: /proc/1/* then shows the shell and its cleared env,
    // never bwrap's own argv with the host workspace path.
    "--as-pid-1",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/workspace",
    "--setenv", "LANG", "C.UTF-8",
    "--chdir", "/workspace",
  ];
  if (net) {
    args.push("--share-net");
    for (const file of [
      "/etc/resolv.conf",
      "/etc/hosts",
      "/etc/nsswitch.conf",
      "/etc/ssl",
      "/etc/ca-certificates",
    ]) {
      if (existsSync(file)) args.push("--ro-bind", file, file);
    }
  }
  for (const [name, value] of Object.entries(extraEnv ?? {})) {
    args.push("--setenv", name, value);
  }
  return args;
}

function killTree(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function runInBox(argv, options) {
  const {
    workspace,
    net = false,
    timeoutMs = EXEC_TIMEOUT_MS,
    spill,
    extraEnv,
  } = options;
  if (!BWRAP_AVAILABLE) {
    return Promise.reject(
      new BoxError(
        503,
        "shell_unavailable",
        "bwrap is not installed at /usr/bin/bwrap; fs routes still work",
      ),
    );
  }
  if (argv.length === 0) {
    return Promise.reject(new BoxError(400, "bad_command", "empty argv"));
  }
  const args = [...bwrapArgs(workspace, net, extraEnv), "--", ...argv];
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(BWRAP, args, {
        cwd: workspace.root,
        // No host path or host secret in the bwrap process environment.
        // bwrap clears it for the command anyway, but /proc/1/environ inside
        // the namespace is readable, so keep it clean here too.
        env: { PATH: "/usr/bin:/bin", HOME: "/workspace", LANG: "C.UTF-8" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(
        new BoxError(500, "spawn_error", `could not start bwrap: ${error.message}`),
      );
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let exited;
    const exitedPromise = new Promise((resolveExit) => {
      exited = resolveExit;
    });
    if (child.pid) {
      activeExecs.set(child.pid, {
        id: workspace.id,
        child,
        exited: exitedPromise,
      });
    }
    const append = (current, chunk) => {
      const text = chunk.toString("utf8");
      if (bytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      const remaining = MAX_OUTPUT_BYTES - bytes;
      const accepted = text.slice(0, remaining);
      bytes += accepted.length;
      if (accepted.length < text.length) truncated = true;
      return current + accepted;
    };
    const effectiveTimeout = Math.max(
      1,
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : EXEC_TIMEOUT_MS,
    );
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, effectiveTimeout);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeExecs.delete(child.pid);
      exited?.();
      let spillPath;
      if (
        spill &&
        (bytes > spill.afterBytes ||
          (stdout + stderr).split("\n").length > spill.afterLines)
      ) {
        const dir = join(workspace.root, ".fleet-tmp");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const name = `spill-${randomUUID()}.log`;
        writeFileSync(join(dir, name), `${stdout}${stderr}`, { mode: 0o600 });
        spillPath = posix.join(VIRTUAL_ROOT, ".fleet-tmp", name);
      }
      resolvePromise({ ...result, spillPath, truncated });
    };
    child.on("error", (error) => {
      settle({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${error.message}\n`,
        timedOut: false,
      });
    });
    child.on("close", (code, signal) => {
      settle({
        exitCode: typeof code === "number" ? code : signal ? 128 : 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function networkCommand(cmd) {
  return /\b(git\s+(?:clone|fetch|pull|push)|npm\s+(?:install|ci|i|update)|pnpm\s+(?:install|i|add)|yarn\s+(?:install|add)|bun\s+(?:install|add)|pip3?\s+install|curl|wget)\b/.test(
    cmd,
  );
}

async function execCommand(id, entry, body) {
  const dir = workspaceDir(id);
  if (entry.tier !== "t1") {
    fail(
      403,
      "shell_unavailable",
      'shell_unavailable: exec requires tier t1 (POST /agent/:name/config {"sandbox":"t1"})',
    );
  }
  if (typeof body.cmd !== "string" || body.cmd.trim() === "") {
    fail(400, "bad_command", "cmd must be a non-empty string");
  }
  if (body.cmd.length > 100_000) {
    fail(413, "payload_too_large", "cmd exceeds 100000 characters");
  }
  checkQuota(dir, entry);
  const requested = Number(body.timeoutMs);
  const timeoutMs =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, EXEC_TIMEOUT_MS)
      : EXEC_TIMEOUT_MS;
  const net =
    body.net === true || (body.net !== false && networkCommand(body.cmd));
  const spill =
    body.spill &&
    typeof body.spill.afterBytes === "number" &&
    typeof body.spill.afterLines === "number"
      ? body.spill
      : undefined;
  const result = await runInBox(["/usr/bin/bash", "-lc", body.cmd], {
    workspace: { id, root: dir },
    net,
    timeoutMs,
    spill,
  });
  const quotaExceeded = bytesFor(dir) > quotaMbFor(entry) * 1024 * 1024;
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.spillPath ? { spillPath: result.spillPath } : {}),
    net,
    ...(quotaExceeded ? { quotaExceeded: true } : {}),
  };
}

function isPrivateAddress(address) {
  const value = address.replace(/^\[|\]$/g, "").toLowerCase();
  // IPv4-mapped IPv6 can encode loopback/private in a form isIPv4() does not
  // see; reject the whole mapped range rather than parse it.
  if (value.startsWith("::ffff:")) return true;
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) {
    return true;
  }
  if (!isIPv4(value)) return false;
  const [a, b] = value.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateHost(hostname) {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value === "0.0.0.0"
  ) {
    return true;
  }
  if (isIPv4(value) || isIPv6(value)) return isPrivateAddress(value);
  return false;
}

async function assertPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(400, "bad_url", "url is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    fail(400, "bad_url", "git clone accepts https:// only");
  }
  if (parsed.username || parsed.password) {
    fail(400, "bad_url", "credentials in the URL are not allowed");
  }
  if (isPrivateHost(parsed.hostname)) {
    fail(400, "bad_url", "private, loopback, and link-local hosts are not allowed");
  }
  let addresses;
  try {
    addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    fail(400, "bad_url", `could not resolve ${parsed.hostname}`);
  }
  if (addresses.length === 0) {
    fail(400, "bad_url", `could not resolve ${parsed.hostname}`);
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    fail(400, "bad_url", `${parsed.hostname} resolves to a private address`);
  }
  return parsed;
}

function repoRelative(workspace, repo) {
  const target = resolveInWorkspace(workspace.root, repo ?? ".");
  let info;
  try {
    info = statSync(target);
  } catch {
    fail(404, "not_found", `repository ${JSON.stringify(repo ?? ".")} does not exist`);
  }
  if (!info.isDirectory()) {
    fail(400, "not_a_directory", `${repo ?? "."} is not a directory`);
  }
  return relative(workspace.root, target) || ".";
}

const GIT_ENV = {
  GIT_ALLOW_PROTOCOL: "https",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function gitClone(id, entry, body) {
  const workspace = { id, root: workspaceDir(id) };
  const parsed = await assertPublicUrl(body.url);
  let name = basename(parsed.pathname, ".git")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "");
  if (!name) name = "repo";
  if (body.dir !== undefined) {
    if (typeof body.dir !== "string" || !ID_PATTERN.test(body.dir)) {
      fail(400, "bad_dir", "dir must be a simple workspace name");
    }
    name = body.dir;
  }
  const target = resolveInWorkspace(workspace.root, name);
  if (existsSync(target)) fail(409, "exists", `${name} already exists`);
  if (target === workspace.root) {
    fail(400, "bad_dir", "dir cannot be the workspace root");
  }
  const result = await runInBox(
    ["/usr/bin/git", "clone", "--depth", "1", "--", body.url, name],
    {
      workspace,
      net: true,
      timeoutMs: CLONE_TIMEOUT_MS,
      extraEnv: GIT_ENV,
    },
  );
  if (result.exitCode !== 0) {
    fail(
      400,
      "git_clone_failed",
      `${result.stderr || result.stdout}`.trim() || "git clone failed",
    );
  }
  if (bytesFor(workspace.root) > quotaMbFor(entry) * 1024 * 1024) {
    rmSync(target, { recursive: true, force: true });
    fail(413, "quota_exceeded", `clone exceeds the ${quotaMbFor(entry)} MB quota`);
  }
  return {
    path: virtualFor(workspace.root, target),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function gitStatus(id, body) {
  const workspace = { id, root: workspaceDir(id) };
  const repo = repoRelative(workspace, body.repo);
  const result = await runInBox(
    ["/usr/bin/git", "-C", repo, "status", "--porcelain=v1"],
    {
      workspace,
      net: false,
      timeoutMs: CLONE_TIMEOUT_MS,
      extraEnv: GIT_ENV,
    },
  );
  if (result.exitCode !== 0) {
    fail(
      400,
      "git_status_failed",
      `${result.stderr || result.stdout}`.trim() || "git status failed",
    );
  }
  return {
    path: posix.join(VIRTUAL_ROOT, repo),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function killWorkspaceExecs(id) {
  const victims = [...activeExecs.entries()].filter(
    ([, value]) => value.id === id,
  );
  for (const [pid] of victims) killTree(pid);
  await Promise.all(victims.map(([, value]) => value.exited));
}

async function resetWorkspace(id) {
  await killWorkspaceExecs(id);
  const dir = workspaceDir(id);
  rmSync(dir, { recursive: true, force: true });
  const index = readIndex();
  delete index.workspaces[id];
  writeIndex(index);
  return { reset: true, deleted: true };
}

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      boxId: BOX_ID,
      bwrap: BWRAP_AVAILABLE,
      version: 1,
    });
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, {
      error: { code: "method_not_allowed", message: "POST only" },
    });
  }
  if (url.pathname === "/workspace") {
    const body = await readJson(req);
    return sendJson(res, 200, issueWorkspace(body));
  }

  const id = req.headers["x-fleet-workspace"];
  if (typeof id !== "string") {
    fail(400, "bad_workspace", "missing X-Fleet-Workspace");
  }
  const { entry } = authenticate(req, id);
  const body = await readJson(req);

  switch (url.pathname) {
    case "/workspace/reset":
      return sendJson(res, 200, await resetWorkspace(id));
    case "/fs/read":
      return sendJson(res, 200, fsRead(id)(body));
    case "/fs/write":
      return sendJson(res, 200, fsWrite(id, entry)(body));
    case "/fs/stat":
      return sendJson(res, 200, fsStat(id)(body));
    case "/fs/canonical":
      return sendJson(res, 200, fsCanonical(id)(body));
    case "/git/clone":
      return sendJson(res, 200, await gitClone(id, entry, body));
    case "/git/status":
      return sendJson(res, 200, await gitStatus(id, body));
    case "/exec":
      return sendJson(res, 200, await execCommand(id, entry, body));
    default:
      return sendJson(res, 404, {
        error: { code: "not_found", message: "unknown route" },
      });
  }
}

mkdirSync(WORKSPACES_ROOT, { recursive: true, mode: 0o700 });
if (!BWRAP_AVAILABLE) {
  console.error(
    "[box] WARNING: /usr/bin/bwrap is missing; /exec and /git/* will return shell_unavailable. fs routes still work.",
  );
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    if (!(error instanceof BoxError)) {
      console.error(
        "[box] internal error:",
        error instanceof Error ? error.message : String(error),
      );
    }
    sendError(res, error);
  });
});
server.requestTimeout = Math.max(CLONE_TIMEOUT_MS + 15_000, 60_000);
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => {
  console.log(
    `[box] listening on http://${HOST}:${PORT} (box ${BOX_ID}, workspaces ${WORKSPACES_ROOT})`,
  );
});

function shutdown(signal) {
  console.log(`[box] ${signal}; stopping`);
  for (const pid of activeExecs.keys()) killTree(pid);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
