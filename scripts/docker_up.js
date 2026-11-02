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

const { spawn, spawnSync } = require("child_process");
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

function composeCapture(args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "docker_compose_env.js"), ...args], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  return {
    status: r.status == null ? 1 : r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function probeReady() {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:3000/api/v1/health/ready", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 4000) body += chunk;
      });
      res.on("end", () => {
        resolve({ ms: Date.now() - started, status: res.statusCode || 0, body: body.trim() });
      });
    });
    req.on("error", (err) => {
      resolve({ ms: Date.now() - started, status: 0, body: String(err && err.message ? err.message : err) });
    });
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ ms: Date.now() - started, status: 0, body: "timeout 8s" });
    });
  });
}

function printStartupReport(ready) {
  console.log("--- проверка запуска ---");
  console.log(`ready HTTP ${ready.status || "нет"} за ${ready.ms} мс`);
  console.log(ready.body || "(пустое тело)");
  let parsed = null;
  try {
    parsed = JSON.parse(ready.body);
  } catch {
    parsed = null;
  }
  if (ready.ms > 2000) {
    console.log("ВНИМАНИЕ: /health/ready дольше 2 с. База или процесс уже заняты.");
  }
  if (parsed && parsed.database && parsed.database !== "up") {
    console.log("ВНИМАНИЕ: база в пробе не up.");
  }
  if (parsed && parsed.snapshot === "missing") {
    console.log(
      "ВНИМАНИЕ: снимка дашборда ещё нет. Страница будет пустой, пока фоновый пересчёт не запишет строку. Это не падение контейнера.",
    );
  }
  if (parsed && parsed.snapshot === "table_missing") {
    console.log("ВНИМАНИЕ: таблицы dashboard_snapshots нет. Миграция не дошла.");
  }
  if (parsed && typeof parsed.snapshot_age_s === "number" && parsed.snapshot_age_s > 3600) {
    console.log(`ВНИМАНИЕ: снимок дашборда старше ${parsed.snapshot_age_s} с.`);
  }

  const ps = composeCapture(["ps"]);
  console.log("--- контейнеры ---");
  process.stdout.write(ps.stdout || ps.stderr || "(ps пустой)\n");

  const image = spawnSync("docker", ["image", "inspect", "corax:local", "--format", "{{.Created}}"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  console.log(`образ corax:local создан: ${(image.stdout || "").trim() || "(нет образа)"}`);

  const logs = composeCapture(["logs", "--since", "15m", "--tail", "200", "app"]);
  const interesting = (logs.stdout + "\n" + logs.stderr)
    .split(/\r?\n/)
    .filter((line) => /SLOW |ERROR|Error|Traceback|Exception|snapshot|not_ready|\[corax\]/.test(line))
    .filter((line) => !/password|secret|token/i.test(line))
    .slice(-40);
  console.log("--- строки запуска и ошибки (без секретов) ---");
  if (interesting.length === 0) console.log("(таких строк нет)");
  else interesting.forEach((line) => console.log(line));
  console.log(
    "Дальше зависание дашборда смотрите так: docker compose logs app --since 5m | findstr SLOW",
  );
  console.log("--- конец проверки ---");
}

function startWolRelay() {
  const dir = path.join(root, "data", "wol-queue");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o777);
  } catch {
    /* Windows */
  }
  const script = path.join(root, "scripts", "wol_relay.py");
  const logPath = path.join(root, "data", "wol-relay.log");
  const candidates =
    process.platform === "win32"
      ? [
          ["py", ["-3"]],
          ["python", []],
          ["python3", []],
        ]
      : [
          ["python3", []],
          ["python", []],
        ];
  for (const [bin, prefix] of candidates) {
    const probe = spawnSync(bin, [...prefix, "-c", "import sys"], {
      windowsHide: true,
      timeout: 15000,
      stdio: "ignore",
    });
    if (probe.status !== 0) continue;
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(bin, [...prefix, script], {
      cwd: root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      shell: false,
    });
    child.unref();
    fs.closeSync(logFd);
    console.log("WoL: ретранслятор на хосте (data/wol-queue). Пакет уходит с этой сетевой карты, не из Docker.");
    return;
  }
  console.error("WoL: не найден Python, ретранслятор не запущен. Кнопка в панели не разбудит ПК.");
}

async function main() {
  console.log("=== CORAX docker:up ===");

  const init = spawnNode("run_python.js", ["scripts/ensure_docker_env.py"]);
  if ((init.status ?? 1) !== 0) process.exit(init.status ?? 1);

  startWolRelay();

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
  let readyOk = false;
  try {
    await waitHealth(180000);
    readyOk = true;
    console.log("Health OK");
  } catch {
    console.error("Health не ответил за 180 с.");
  }
  const ready = await probeReady();
  printStartupReport(ready);
  if (!readyOk || !ready.status || ready.status >= 400) {
    console.error("Запуск не готов. Выше тело /health/ready и строки логов.");
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
