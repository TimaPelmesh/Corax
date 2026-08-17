#!/usr/bin/env node
/**
 * Run `docker compose --env-file backend/.env …` with host secret env vars
 * stripped so shell exports cannot override backend/.env (Compose prefers OS env).
 */
const { spawnSync } = require("child_process");
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

const env = { ...process.env };
for (const k of STRIP) delete env[k];

const args = ["compose", "--env-file", envFile, ...process.argv.slice(2)];
const r = spawnSync("docker", args, { stdio: "inherit", cwd: root, env, shell: false });
process.exit(r.status == null ? 1 : r.status);
