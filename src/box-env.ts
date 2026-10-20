import {
  ExecutionError,
  FileError,
  ok,
  err,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";

/**
 * The methods pi-durable's coding tools actually call. Everything else on
 * ExecutionEnv returns not_supported; the box daemon is not a second filesystem
 * API and we do not want half-working methods.
 */
export const VIRTUAL_ROOT = "/workspace";
const SAFE_TIMEOUT_MS = 15_000;
const EXEC_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 310_000;

type Context = Parameters<ExecutionEnv["absolutePath"]>[1];

export type SandboxTier = "t0" | "t1";

export type WorkspaceBinding = {
  id: string;
  token: string;
  tier: SandboxTier;
  quotaMb: number;
  boxId: string;
  lostFrom?: string;
};

type Rehandshake = () => Promise<WorkspaceBinding>;

class DaemonRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DaemonRequestError";
    this.status = status;
    this.code = code;
  }
}

function fileCodeFor(code: string): FileError["code"] {
  switch (code) {
    case "not_found":
      return "not_found";
    case "path_escape":
    case "unauthorized":
      return "permission_denied";
    case "not_a_file":
    case "is_directory":
      return "is_directory";
    case "not_a_directory":
      return "not_directory";
    case "not_supported":
      return "not_supported";
    case "bad_path":
    case "bad_body":
    case "bad_workspace":
    case "bad_url":
    case "bad_dir":
    case "file_too_large":
    case "quota_exceeded":
    case "payload_too_large":
    case "not_unique":
      return "invalid";
    default:
      return "unknown";
  }
}

function asFileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  if (error instanceof DaemonRequestError) {
    return new FileError(fileCodeFor(error.code), error.message, path, error);
  }
  return new FileError(
    "unknown",
    error instanceof Error ? error.message : String(error),
    path,
    error instanceof Error ? error : undefined,
  );
}

function asExecError(error: unknown): ExecutionError {
  if (error instanceof ExecutionError) return error;
  if (error instanceof DaemonRequestError) {
    const code =
      error.code === "timeout"
        ? "timeout"
        : error.code === "shell_unavailable"
          ? "shell_unavailable"
          : error.code === "aborted"
            ? "aborted"
            : error.code === "callback_error"
              ? "callback_error"
              : error.code === "network_error" || error.status >= 500
                ? "spawn_error"
                : "spawn_error";
    return new ExecutionError(code, error.message, error);
  }
  return new ExecutionError(
    "unknown",
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? error : undefined,
  );
}

function virtualPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new FileError("invalid", "path must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw new FileError("invalid", "path contains a NUL byte");
  }
  if (input === VIRTUAL_ROOT) return VIRTUAL_ROOT;
  if (input === "~") return VIRTUAL_ROOT;
  const normalized = input.startsWith("~/") ? input.slice(2) : input;
  const relative = normalized.startsWith(`${VIRTUAL_ROOT}/`)
    ? normalized.slice(VIRTUAL_ROOT.length + 1)
    : normalized;
  return posixResolve(relative);
}

// A small POSIX resolver so the Worker does not need node:path for this.
function posixResolve(input: string): string {
  if (input.startsWith("/")) {
    throw new FileError(
      "permission_denied",
      `absolute path ${JSON.stringify(input)} is outside ${VIRTUAL_ROOT}`,
    );
  }
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new FileError(
          "permission_denied",
          `path ${JSON.stringify(input)} escapes ${VIRTUAL_ROOT}`,
        );
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${parts.join("/")}`;
}

function posixJoin(parts: readonly string[]): string {
  const cleaned = parts.filter((part) => part.length > 0);
  if (cleaned.length === 0) return VIRTUAL_ROOT;
  const first = cleaned[0].startsWith("/") ? "" : VIRTUAL_ROOT;
  return `${first}/${cleaned.join("/")}`.replace(/\/+/g, "/");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Byte offsets for `BinaryReader.scanLines`; BOM bytes are not counted in decoded sizes. */
export function scanLines(
  bytes: Uint8Array,
  startLine: number,
  endLine?: number,
): LineScan {
  const newlines: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) newlines.push(index);
  }
  const totalLines = newlines.length + 1;
  const lineStart = (line: number): number =>
    line <= 0 ? 0 : newlines[line - 1] + 1;
  const lineEnd = (line: number): number =>
    line < newlines.length ? newlines[line] : bytes.length;
  const start = Math.min(Math.max(Math.trunc(startLine), 0), totalLines);
  const requestedEnd = endLine === undefined ? totalLines : Math.trunc(endLine);
  const end = Math.min(Math.max(requestedEnd, start), totalLines);
  const startByte = lineStart(start);
  const endByte = end > start ? lineEnd(end - 1) : startByte;
  const firstLineEnd = start < totalLines ? lineEnd(start) : startByte;
  const lastLineStart = end > start ? lineStart(end - 1) : startByte;
  const bom =
    startByte === 0 &&
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? 3
      : 0;
  return {
    newlines: newlines.length,
    start: startByte,
    end: endByte,
    firstLineEnd,
    lastLineStart,
    selectedBytes: Math.max(0, endByte - startByte - bom),
    firstLineBytes: Math.max(0, firstLineEnd - startByte - bom),
  };
}

type RequestOptions = {
  timeoutMs?: number;
  retried?: boolean;
};

export type DaemonEnvOptions = {
  baseUrl: string;
  binding: WorkspaceBinding;
  rehandshake: Rehandshake;
};

/**
 * pi-durable ExecutionEnv backed by the loopback box daemon. The Worker has no
 * host filesystem or child_process, so every method is one authenticated HTTP
 * call. A 401 triggers exactly one re-handshake and retry.
 */
export class DaemonEnv implements ExecutionEnv {
  readonly cwd = VIRTUAL_ROOT;
  private binding: WorkspaceBinding;
  private readonly baseUrl: string;
  private readonly rehandshake: Rehandshake;

  constructor(options: DaemonEnvOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.binding = options.binding;
    this.rehandshake = options.rehandshake;
  }

  get id(): string {
    return `box:${this.binding.boxId}:${this.binding.id}`;
  }

  get tier(): SandboxTier {
    return this.binding.tier;
  }

  get boxId(): string {
    return this.binding.boxId;
  }

  describe(): string {
    const lines = [
      `Workspace: ${VIRTUAL_ROOT} (box ${this.binding.boxId})`,
      `Tier: ${this.binding.tier} (${this.binding.tier === "t1" ? "read/write/edit/git + bash exec" : "read/write/edit/git only; bash exec is disabled"})`,
      `Quota: ${this.binding.quotaMb} MB`,
      "Files are scratch on this box; the transcript is durable, files are not.",
      "Never claim a path exists unless read, stat, or git_status confirms it.",
    ];
    if (this.binding.lostFrom) {
      lines.push(
        `The previous workspace was on box ${this.binding.lostFrom}, and it is gone. Say that plainly instead of pretending its files are here.`,
      );
    }
    if (this.binding.tier === "t0") {
      lines.push(
        "bash exec returns shell_unavailable in tier t0. Use git_clone, git_status, read, write, and edit.",
      );
    }
    return lines.join("\n");
  }

  /** Public so the git tools can call /git/* through the same auth/retry path. */
  async request<T>(route: string, body: Record<string, unknown>, options?: RequestOptions): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? SAFE_TIMEOUT_MS;
    const call = async (token: string): Promise<{ response: Response; payload: unknown }> => {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-fleet-workspace": this.binding.id,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new DaemonRequestError(
          0,
          "network_error",
          `box executor is unreachable at ${this.baseUrl}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      return { response, payload };
    };

    let { response, payload } = await call(this.binding.token);
    if (response.status === 401 && !options?.retried) {
      this.binding = await this.rehandshake();
      ({ response, payload } = await call(this.binding.token));
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: unknown; message?: unknown } })?.error;
      throw new DaemonRequestError(
        response.status,
        typeof error?.code === "string" ? error.code : "http_error",
        typeof error?.message === "string"
          ? error.message
          : `box executor returned HTTP ${response.status}`,
      );
    }
    return payload as T;
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    try {
      return ok(virtualPath(path));
    } catch (error) {
      return err(asFileError(error, path));
    }
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    try {
      const joined = posixJoin(parts);
      return ok(virtualPath(joined));
    } catch (error) {
      return err(asFileError(error));
    }
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    try {
      const resolved = virtualPath(path);
      await this.request("/fs/stat", { path: resolved });
      return ok(true);
    } catch (error) {
      if (error instanceof DaemonRequestError && error.code === "not_found") {
        return ok(false);
      }
      return err(asFileError(error, path));
    }
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    try {
      const resolved = virtualPath(path);
      const result = await this.request<{ path: string }>("/fs/canonical", {
        path: resolved,
      });
      return ok(result.path);
    } catch (error) {
      return err(asFileError(error, path));
    }
  }

  async readTextFile(path: string): Promise<Result<string, FileError>> {
    try {
      const resolved = virtualPath(path);
      const result = await this.request<{ text: string }>("/fs/read", {
        path: resolved,
      });
      return ok(result.text);
    } catch (error) {
      return err(asFileError(error, path));
    }
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<Result<void, FileError>> {
    try {
      const resolved = virtualPath(path);
      const body =
        typeof content === "string"
          ? { path: resolved, text: content }
          : { path: resolved, base64: bytesToBase64(content) };
      await this.request("/fs/write", body);
      return ok(undefined);
    } catch (error) {
      return err(asFileError(error, path));
    }
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    try {
      const resolved = virtualPath(path);
      const result = await this.request<{
        name: string;
        path: string;
        kind: string;
        size: number;
        mtimeMs: number;
      }>("/fs/stat", { path: resolved });
      const kind =
        result.kind === "directory" ? "directory" : ("file" as const);
      return ok({
        name: result.name,
        path: result.path,
        kind,
        size: result.size,
        mtimeMs: result.mtimeMs,
      });
    } catch (error) {
      return err(asFileError(error, path));
    }
  }

  async openBinaryReader(
    path: string,
  ): Promise<Result<BinaryReader, FileError>> {
    try {
      const resolved = virtualPath(path);
      const info = await this.fileInfo(resolved);
      if (!info.ok) return info;
      const reader: BinaryReader = {
        info: async () => this.fileInfo(resolved),
        read: async (offset: number, length: number) => {
          try {
            const result = await this.request<{ base64: string }>("/fs/read", {
              path: resolved,
              binary: true,
              offset,
              length,
            });
            return ok(base64ToBytes(result.base64));
          } catch (error) {
            return err(asFileError(error, path));
          }
        },
        scanLines: async (options: { startLine: number; endLine?: number }) => {
          try {
            const result = await this.request<{ base64: string }>("/fs/read", {
              path: resolved,
              binary: true,
            });
            return ok(
              scanLines(
                base64ToBytes(result.base64),
                options.startLine,
                options.endLine,
              ),
            );
          } catch (error) {
            return err(asFileError(error, path));
          }
        },
        close: async () => undefined,
      };
      return ok(reader);
    } catch (error) {
      return err(asFileError(error, path));
    }
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (this.binding.tier !== "t1") {
      return err(
        new ExecutionError(
          "shell_unavailable",
          'shell_unavailable: exec requires tier t1 (POST /agent/:name/config {"sandbox":"t1"})',
        ),
      );
    }
    if (Array.isArray(command)) {
      return err(
        new ExecutionError(
          "shell_unavailable",
          "argv exec is not supported by the fleet box; pass a shell command",
        ),
      );
    }
    if (context.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", "aborted"));
    }
    if (options?.cwd !== undefined) {
      let cwd: string;
      try {
        cwd = virtualPath(options.cwd);
      } catch (error) {
        return err(
          new ExecutionError(
            "shell_unavailable",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      if (cwd !== VIRTUAL_ROOT) {
        return err(
          new ExecutionError(
            "shell_unavailable",
            "the box always runs commands in /workspace",
          ),
        );
      }
    }
    const requestedSeconds = options?.timeout;
    const timeoutMs = Math.min(
      requestedSeconds !== undefined && Number.isFinite(requestedSeconds) && requestedSeconds > 0
        ? Math.trunc(requestedSeconds * 1000)
        : EXEC_TIMEOUT_MS,
      EXEC_TIMEOUT_MS,
    );
    try {
      const result = await this.request<{
        exitCode: number;
        timedOut: boolean;
        stdout: string;
        stderr: string;
        spillPath?: string;
        quotaExceeded?: boolean;
      }>(
        "/exec",
        {
          cmd: command,
          timeoutMs,
          ...(options?.spill
            ? {
                spill: {
                  afterBytes: options.spill.afterBytes,
                  afterLines: options.spill.afterLines,
                },
              }
            : {}),
        },
        { timeoutMs: timeoutMs + 5_000 },
      );
      try {
        if (result.stdout) {
          options?.onOutput?.(result.stdout, context, { stream: "stdout" });
        }
        if (result.stderr) {
          options?.onOutput?.(result.stderr, context, { stream: "stderr" });
        }
        if (result.quotaExceeded) {
          options?.onOutput?.(
            "\n[fleet] workspace quota exceeded; writes will be rejected until it is reset or raised.\n",
            context,
            { stream: "stderr" },
          );
        }
      } catch (error) {
        return err(
          new ExecutionError(
            "callback_error",
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error : undefined,
          ),
        );
      }
      if (result.timedOut) {
        return err(
          new ExecutionError(
            "timeout",
            `Command timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          ),
        );
      }
      return ok({
        exitCode: result.exitCode,
        ...(result.spillPath ? { spillPath: result.spillPath } : {}),
      });
    } catch (error) {
      return err(asExecError(error));
    }
  }

  // ---- not supported by the box protocol, deliberately -------------------

  async readTextLines(): Promise<Result<string[], FileError>> {
    return err(new FileError("not_supported", "readTextLines is not supported by the fleet box"));
  }

  async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
    return err(new FileError("not_supported", "readBinaryFile is not supported by the fleet box"));
  }

  async openTextLineReader(): Promise<Result<TextLineReader, FileError>> {
    return err(new FileError("not_supported", "openTextLineReader is not supported by the fleet box"));
  }

  async appendFile(): Promise<Result<void, FileError>> {
    return err(new FileError("not_supported", "appendFile is not supported by the fleet box"));
  }

  async truncateFile(): Promise<Result<void, FileError>> {
    return err(new FileError("not_supported", "truncateFile is not supported by the fleet box"));
  }

  async flushFile(): Promise<Result<void, FileError>> {
    return err(new FileError("not_supported", "flushFile is not supported by the fleet box"));
  }

  async renameFile(): Promise<Result<void, FileError>> {
    return err(new FileError("not_supported", "renameFile is not supported by the fleet box"));
  }

  async listDir(): Promise<Result<FileInfo[], FileError>> {
    return err(new FileError("not_supported", "listDir is not supported by the fleet box"));
  }

  async openDirReader(): Promise<Result<DirReader, FileError>> {
    return err(new FileError("not_supported", "openDirReader is not supported by the fleet box"));
  }

  async createDir(): Promise<Result<void, FileError>> {
    return err(new FileError("not_supported", "createDir is not supported by the fleet box"));
  }

  async remove(): Promise<Result<void, FileError>> {
    return err(new FileError("not_supported", "remove is not supported by the fleet box"));
  }

  async createTempDir(): Promise<Result<string, FileError>> {
    return err(new FileError("not_supported", "createTempDir is not supported by the fleet box"));
  }

  async createTempFile(): Promise<Result<string, FileError>> {
    return err(new FileError("not_supported", "createTempFile is not supported by the fleet box"));
  }

  async watch(
    _targets: readonly WatchTarget[],
    _onChange: (change: WatchChange) => void,
  ): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError("not_supported", "watch is not supported by the fleet box"));
  }

  async cleanup(): Promise<void> {
    // Nothing to close: readers are stateless and each call is one HTTP
    // request. Deliberately not an error, because this is a lifecycle no-op.
  }
}

export { DaemonRequestError };
