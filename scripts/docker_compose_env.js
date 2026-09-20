#!/usr/bin/env node
/**
 * Run `docker compose --env-file backend/.env …` with host secret env vars
 * stripped so shell exports cannot override backend/.env (Compose prefers OS env).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const envFile = path.join(root, "backend", ".env");

const STRIP = [
  "AGENT_TOKEN",
  "SECRET_KEY",
  "AGENT_TOKEN_PEPPER",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "POSTGRES_PASSWORD",
  "POSTGRES_USER",
  "DATABASE_URL",
  "AGENT_LEGACY_TOKENS",
];

function envFileValue(key) {
  try {
    const text = fs.readFileSync(envFile, "utf8");
    const re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=(.*)$", "m");
    const m = text.match(re);
    if (!m) return "";
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!v || v.startsWith("#")) return "";
    return v;
  } catch {
    return "";
  }
}

function detectHostLanNetworks() {
  const script = path.join(root, "scripts", "host_lan_networks.py");
  const candidates =
    process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const bin of candidates) {
    const r = spawnSync(bin, [script], {
      encoding: "utf8",
      cwd: root,
      shell: process.platform === "win32",
      timeout: 8000,
    });
    if (r.error && r.error.code === "ENOENT") continue;
    if (r.status === 0 && r.stdout) {
      return String(r.stdout).trim().replace(/\s+/g, "");
    }
  }
  return "";
}

const env = { ...process.env };
for (const k of STRIP) delete env[k];

if (!env.CORAX_HOST_LAN_NETWORKS && !envFileValue("CORAX_HOST_LAN_NETWORKS")) {
  const lan = detectHostLanNetworks();
  if (lan) {
    env.CORAX_HOST_LAN_NETWORKS = lan;
    const cmd = (process.argv.slice(2)[0] || "").toLowerCase();
    if (cmd === "up" || cmd === "run") {
      console.log("SNMP LAN (хост, не Docker 172.x): " + lan);
    }
  }
}

const args = ["compose", "--env-file", envFile, ...process.argv.slice(2)];
const r = spawnSync("docker", args, { stdio: "inherit", cwd: root, env, shell: false });
process.exit(r.status == null ? 1 : r.status);
