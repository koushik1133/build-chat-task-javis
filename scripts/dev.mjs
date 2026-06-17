#!/usr/bin/env node
/**
 * Safe dev server startup:
 * 1. Kill any stale process on the port
 * 2. Auto-clear corrupted .next (missing manifests)
 * 3. Start Next.js from the project root only
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || process.env.JAVIS_DEV_PORT || "3001";
const forceClean = process.argv.includes("--clean");

process.chdir(ROOT);

function killPort(p) {
  try {
    const out = execSync(`lsof -ti:${p} 2>/dev/null`, { encoding: "utf8" }).trim();
    if (!out) return;
    for (const pid of out.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    console.log(`[dev] Freed port ${p}`);
  } catch {
    /* nothing listening */
  }
}

function isNextCacheCorrupt() {
  const nextDir = path.join(ROOT, ".next");
  if (!fs.existsSync(nextDir)) return false;
  const required = [
    path.join(nextDir, "routes-manifest.json"),
    path.join(nextDir, "build-manifest.json"),
  ];
  return required.some(f => !fs.existsSync(f));
}

function killStaleDevServers() {
  killPort(PORT);
  killPort("5173");
  // Stop orphaned Next dev processes for this project
  try {
    execSync('pkill -f "next dev" 2>/dev/null || true', { stdio: "ignore" });
  } catch {
    /* none */
  }
}

killStaleDevServers();

function clearNextCache() {
  const nextDir = path.join(ROOT, ".next");
  if (!fs.existsSync(nextDir)) return;
  try {
    fs.rmSync(nextDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    try {
      execSync(`rm -rf "${nextDir}"`, { stdio: "ignore" });
    } catch {
      console.warn("[dev] Could not fully clear .next — stop other dev servers and retry");
    }
  }
}

if (forceClean || isNextCacheCorrupt()) {
  clearNextCache();
  console.log("[dev] Cleared .next cache");
}

console.log(`[dev] Javis → http://localhost:${PORT}`);
console.log("[dev] Tip: npm run dev:clean  forces a fresh cache\n");

let cronProc;

const child = spawn("npx", ["next", "dev", "-p", PORT, "-H", "127.0.0.1"], {
  stdio: "inherit",
  cwd: ROOT,
  env: {
    ...process.env,
    PORT,
    // Polling avoids macOS EMFILE (too many open files) watcher crashes
    WATCHPACK_POLLING: "true",
    CHOKIDAR_USEPOLLING: "true",
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${PORT}`,
  },
});

// Start 1s automation scheduler (script waits for Next to be ready)
setTimeout(() => {
  console.log("[dev] Starting automation scheduler (1s poll, second-aligned)…");
  cronProc = spawn("node", ["scripts/run-automation-cron.mjs"], {
    stdio: "inherit",
    cwd: ROOT,
    env: {
      ...process.env,
      PORT,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${PORT}`,
    },
  });
}, 3000);

function shutdown(sig) {
  cronProc?.kill(sig);
  child.kill(sig);
}

child.on("exit", code => {
  cronProc?.kill("SIGTERM");
  process.exit(code ?? 0);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
