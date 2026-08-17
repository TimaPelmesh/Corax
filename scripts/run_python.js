#!/usr/bin/env node
/**
 * Run a Python script with python3 or python (whichever exists).
 * Needed because Linux often has only `python3`, and `sudo npm` drops the venv.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node scripts/run_python.js <script.py> [args...]");
  process.exit(2);
}

const script = args[0];
const scriptArgs = args.slice(1);
const candidates =
  process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];

let lastStatus = 1;
for (const bin of candidates) {
  const r = spawnSync(bin, [script, ...scriptArgs], {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: path.resolve(__dirname, ".."),
  });
  if (r.error && r.error.code === "ENOENT") {
    continue;
  }
  lastStatus = r.status == null ? 1 : r.status;
  process.exit(lastStatus);
}

console.error(
  "ERROR: neither python3 nor python found on PATH. Install Python 3.",
);
process.exit(lastStatus);
