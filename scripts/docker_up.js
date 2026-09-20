#!/usr/bin/env node
/**
 * npm run docker:up — one command to start CORAX.
 *
 * Creates backend/.env if missing, then compose up.
 * Rebuilds corax:local only when the image is missing or the build fingerprint
 * changed (same idea as update.sh). First raise takes minutes; later raises
 * are seconds. Force: CORAX_FORCE_BUILD=1 or --force.
 */
"use strict";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const fingerprintFile = path.join(root, ".corax-image-fingerprint");
const force = process.argv.includes("--force") || process.env.CORAX_FORCE_BUILD === "1";

process.env.DOCKER_BUILDKIT = process.env.DOCKER_BUILDKIT || "1";
process.env.COMPOSE_DOCKER_CLI_BUILD = process.env.COMPOSE_DOCKER_CLI_BUILD || "1";

function spawnNode(script, args, stdio) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    stdio: stdio || "inherit",
    cwd: root,
    env: process.env,
    shell: false,
  });
}

function compose(args) {
  const r = spawnNode("docker_compose_env.js", args);
  return r.status == null ? 1 : r.status;
}

function gitFingerprint() {
  const r = spawnSync(
    "git",
    [
      "rev-parse",
      "HEAD:Dockerfile",
      "HEAD:docker-compose.yml",
      "HEAD:.dockerignore",
      "HEAD:frontend",
      "HEAD:backend",
      "HEAD:agent",
      "HEAD:run.py",
      "HEAD:scripts",
      "HEAD:deploy/docker",
    ],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (r.status !== 0 || !r.stdout) return "";
  return crypto.createHash("sha256").update(r.stdout.replace(/\r\n/g, "\n")).digest("hex");
}

function workingTreeDirty() {
  const r = spawnSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "Dockerfile",
      "docker-compose.yml",
      ".dockerignore",
      "frontend",
      "backend",
      "agent",
      "run.py",
      "scripts",
      "deploy/docker",
    ],
    { cwd: root, encoding: "utf8", shell: false },
  );
  return r.status === 0 && Boolean((r.stdout || "").trim());
}

function filesFingerprint() {
  const files = [
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore",
    "frontend/package-lock.json",
    "frontend/package.json",
    "backend/requirements.txt",
  ];
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    const p = path.join(root, rel);
    h.update(rel);
    h.update("\0");
    h.update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0));
  }
  return h.digest("hex");
}

function currentFingerprint() {
  return gitFingerprint() || filesFingerprint();
}

function imageExists() {
  const r = spawnSync("docker", ["image", "inspect", "corax:local"], {
    stdio: "ignore",
    cwd: root,
    shell: false,
  });
  return r.status === 0;
}

function needBuild() {
  if (force) return "force";
  if (!imageExists()) return "missing-image";
  if (workingTreeDirty()) return "working-tree";
  const now = currentFingerprint();
  const prev = fs.existsSync(fingerprintFile) ? fs.readFileSync(fingerprintFile, "utf8").trim() : "";
  if (!now) return "no-fingerprint";
  if (now !== prev) return "fingerprint";
  return "";
}

function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get("http://127.0.0.1:3000/api/v1/health/ready", (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 400) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(4000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("health timeout"));
        return;
      }
      setTimeout(attempt, 2000);
    };
    attempt();
  });
}

async function main() {
  console.log("=== CORAX docker:up ===");

  const init = spawnNode("run_python.js", ["scripts/ensure_docker_env.py"]);
  if ((init.status ?? 1) !== 0) process.exit(init.status ?? 1);

  const reason = needBuild();
  if (reason) {
    console.log(`Сборка образа corax:local (причина: ${reason})`);
    console.log("Первый раз — минуты (apt + npm + pip + Vite). Дальше, если код образа не менялся — без сборки.");
    const built = compose(["build"]);
    if (built !== 0) process.exit(built);
  } else {
    console.log("Образ corax:local актуален — пересборка не нужна");
  }

  const up = compose(["up", "-d"]);
  if (up !== 0) process.exit(up);

  console.log("Ожидание health http://127.0.0.1:3000/api/v1/health/ready ...");
  try {
    await waitHealth(180000);
    console.log("Health OK");
  } catch {
    console.error("Health не ответил. Логи: npm run docker:logs");
    process.exit(1);
  }

  const fp = currentFingerprint();
  if (fp) fs.writeFileSync(fingerprintFile, `${fp}\n`);
  console.log("Панель: http://127.0.0.1:3000/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
