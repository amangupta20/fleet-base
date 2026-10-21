#!/usr/bin/env node
// Fleet deploy helper: `celld deploy` ignores `.dev.vars`, so this script
// bridges the gap without hoop-jumping or secrets in git.
//
//   npm run deploy -- --dry-run        # bundle check only, writes nothing
//   npm run deploy                     # deploy with vars from .dev.vars
//   node scripts/deploy.mjs --vars-file .env --dry-run
//   node scripts/deploy.mjs --print-config   # show merged config, no celld
//
// What it does:
//   1. Loads provider vars from `.dev.vars` (else `.env` + `.env.local` overlay,
//      mirroring `celld dev` precedence) and picks an allowlist of Worker vars.
//   2. Merges them as `[vars]` into a throwaway copy of `wrangler.jsonc`
//      (`wrangler.deploy.jsonc`, gitignored).
//   3. Runs `celld deploy --config <throwaway> …` (extra args forwarded).
//   4. Deletes the throwaway config, success or failure.
//
// Notes:
//   - Bucket/CLI credentials (AWS_*, CELLD_*, S3_*) are NOT injected: they
//     belong to the shell that runs celld, not the deployment. celld reads
//     them from env/flags itself (`--bucket` may also come from CELLD_BUCKET).
//   - There is no secrets mechanism in celld: allowlisted secrets land in the
//     deployment objects inside YOUR bucket. Never commit the throwaway config
//     (it is gitignored and deleted after every run).
//   - Var NAMES are logged; values never are.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_CONFIG = "wrangler.jsonc";
const GENERATED_CONFIG = "wrangler.deploy.jsonc";

// Provider Worker vars only. Everything else (AWS_*, CELLD_*, S3_*, PORT, …)
// stays in the shell.
const WORKER_VAR_NAMES = [
  "FLEET_EXECUTOR_URL",
  "ROUTER_BASE_URL",
  "ROUTER_API_KEY",
  "ROUTER_MODEL",
  "ROUTER_EXTRA_MODELS",
  "OPENCODE_API_KEY",
  "OPENCODE_MODEL",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
];

function fail(message) {
  console.error(`deploy: error: ${message}`);
  process.exit(1);
}

// Minimal dotenv parser: full-line `#` comments, optional `export`,
// single/double quotes, double-quoted values may span lines. Inline
// comments are NOT supported (same as `celld dev`).
export function parseDotenv(text) {
  const vars = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    i += 1;
    let line = lines[i - 1].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      console.error(`deploy: warning: skipping unparsable line ${i}`);
      continue;
    }
    const [, name, rest] = match;
    let value = rest;
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // Accumulate until the closing quote (multiline values).
      value = rest.slice(1);
      while (!value.endsWith(quote) || value.endsWith(`\\${quote}`)) {
        if (i >= lines.length) {
          fail(`unterminated quoted value for ${name} (line ${i})`);
        }
        value += `\n${lines[i]}`;
        i += 1;
      }
      value = value.slice(0, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      value = value.trim();
    }
    vars[name] = value;
  }
  return vars;
}

// Strip // and /* */ comments outside strings, then JSON.parse.
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  let string = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (string) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === string) string = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      string = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // celld accepts trailing commas (JSONC); drop them outside strings.
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out);
}

function loadVarsFile(explicit) {
  const candidates = explicit
    ? [resolve(ROOT, explicit)]
    : [".dev.vars", ".env"].map((f) => resolve(ROOT, f));
  const found = candidates.filter((p) => existsSync(p));
  if (explicit && found.length === 0) fail(`vars file not found: ${explicit}`);
  if (found.length === 0) {
    fail("no .dev.vars or .env found; copy .env.example to .dev.vars first");
  }
  // Mirror `celld dev`: .dev.vars wins outright, else .env + .env.local overlay.
  let files = found;
  if (!explicit && found[0].endsWith(".env")) {
    const local = resolve(ROOT, ".env.local");
    if (existsSync(local)) files = [...found, local];
  }
  if (!explicit && found[0].endsWith(".dev.vars")) files = [found[0]];
  const merged = {};
  for (const file of files) {
    Object.assign(merged, parseDotenv(readFileSync(file, "utf8")));
  }
  return { files, vars: merged };
}

function main() {
  const rawArgs = process.argv.slice(2);
  let varsFile = null;
  let printConfig = false;
  const forward = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--vars-file" && rawArgs[i + 1]) {
      varsFile = rawArgs[i + 1];
      i += 1;
    } else if (arg === "--print-config") {
      printConfig = true;
    } else {
      forward.push(arg);
    }
  }

  const basePath = resolve(ROOT, BASE_CONFIG);
  if (!existsSync(basePath)) fail(`base config not found: ${BASE_CONFIG}`);
  const base = parseJsonc(readFileSync(basePath, "utf8"));

  const { files, vars } = loadVarsFile(varsFile);
  const picked = {};
  for (const name of WORKER_VAR_NAMES) {
    const value = vars[name];
    if (typeof value === "string" && value.trim()) picked[name] = value;
  }
  if (Object.keys(picked).length === 0) {
    fail(
      `no provider vars set in ${files.join(", ")}; refusing to deploy an unconfigured fleet`,
    );
  }

  const merged = {
    ...base,
    vars: { ...(base.vars ?? {}), ...picked },
  };
  const generatedPath = resolve(ROOT, GENERATED_CONFIG);
  writeFileSync(generatedPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.error(
    `deploy: injected Worker vars [${Object.keys(picked).join(", ")}] from ${files.join(", ")} (values hidden)`,
  );

  if (printConfig) {
    console.log(JSON.stringify(merged, null, 2));
    rmSync(generatedPath, { force: true });
    return;
  }

  if (!forward.some((a) => a === "--bucket" || a.startsWith("--bucket=")) && !process.env.CELLD_BUCKET) {
    rmSync(generatedPath, { force: true });
    fail("no --bucket flag and CELLD_BUCKET is unset; export it (e.g. via .dev.vars) or pass --bucket");
  }

  const result = spawnSync(
    "celld",
    ["deploy", "--config", generatedPath, ...forward],
    { stdio: "inherit", cwd: ROOT },
  );
  rmSync(generatedPath, { force: true });
  if (result.error) {
    fail(`could not run celld: ${result.error.message} (is celld on PATH?)`);
  }
  process.exit(result.status ?? 1);
}

main();
