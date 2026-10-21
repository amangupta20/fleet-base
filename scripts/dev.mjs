#!/usr/bin/env node
// Start the box executor and celld together. The Worker is a V8 isolate and
// cannot spawn the box, so `npm run dev` owns both processes.
//
//   npm run dev                 # box on 127.0.0.1:9877 + celld dev
//   npm run dev -- --clean      # remove .celld/workspaces + box-id here; celld wipes .celld/dev
//   npm run dev -- --port 9886  # celld flags are forwarded
//
// The box is a local convenience for the single-box PR1 path. It binds
// loopback only and dies with this process.

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const clean = args.includes("--clean");
const boxUrl = process.env.FLEET_EXECUTOR_URL?.trim() || "http://127.0.0.1:9877";
try {
  const parsed = new URL(boxUrl);
  if (parsed.protocol !== "http:") throw new Error("must be http://");
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("must point at loopback");
  }
} catch (error) {
  console.error(
    `[dev] invalid FLEET_EXECUTOR_URL ${JSON.stringify(boxUrl)}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}

if (clean) {
  rmSync(join(ROOT, ".celld", "workspaces"), { recursive: true, force: true });
  rmSync(join(ROOT, ".celld", "box-id"), { force: true });
  console.log(
    "[dev] --clean: removed .celld/workspaces and .celld/box-id (celld will wipe .celld/dev)",
  );
}

if (!existsSync(join(ROOT, "scripts", "box.mjs"))) {
  console.error("[dev] scripts/box.mjs is missing");
  process.exit(1);
}

const box = spawn(process.execPath, [join(ROOT, "scripts", "box.mjs")], {
  cwd: ROOT,
  env: { ...process.env, FLEET_EXECUTOR_URL: boxUrl },
  stdio: "inherit",
});
let boxExited = false;
box.once("exit", (code, signal) => {
  boxExited = true;
  if (!stopping) {
    console.error(`[dev] box exited (${signal ?? code}); stopping celld`);
    stop(code ?? 1);
  }
});

let stopping = false;
let celld;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (celld && celld.exitCode === null) {
    celld.kill("SIGTERM");
    setTimeout(() => {
      if (celld.exitCode === null) celld.kill("SIGKILL");
    }, 3000).unref();
  }
  if (box.exitCode === null) {
    box.kill("SIGTERM");
    setTimeout(() => {
      if (box.exitCode === null) box.kill("SIGKILL");
    }, 3000).unref();
  }
  process.exitCode = code;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function waitForBox() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (boxExited) throw new Error("box exited before it became healthy");
    try {
      const res = await fetch(`${boxUrl}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.ok) return body;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`box did not answer ${boxUrl}/health within 10s`);
}

let health;
try {
  health = await waitForBox();
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  stop(1);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  process.exit(1);
}

console.log(`[dev] box ${health.boxId} on ${boxUrl}`);

celld = spawn("celld", ["dev", ...args], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
});
celld.once("error", (error) => {
  console.error(
    `[dev] could not start celld: ${error.message} (is celld on PATH?)`,
  );
  stop(1);
});
celld.once("exit", (code, signal) => {
  if (!stopping) {
    console.error(`[dev] celld exited (${signal ?? code}); stopping box`);
    stop(code ?? 1);
  }
});
