#!/usr/bin/env node
/**
 * Run backend pytest with a UTF-8-safe Windows env and optional project .venv.
 * Prefer: .venv/Scripts/python.exe (Windows) or .venv/bin/python (Unix), else PATH python.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const extraArgs = process.argv.slice(2)

const venvPy =
  process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python')

const candidates = [venvPy, 'python', 'py', 'python3']

const env = {
  ...process.env,
  PYTHONUTF8: process.env.PYTHONUTF8 || '1',
  PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
  ENVIRONMENT: process.env.ENVIRONMENT || 'test',
}

let lastStatus = 1
for (const bin of candidates) {
  if (bin.includes(path.sep) && !fs.existsSync(bin)) continue
  const args = bin === 'py' ? ['-3', '-m', 'pytest', '-q', ...extraArgs] : ['-m', 'pytest', '-q', ...extraArgs]
  const r = spawnSync(bin, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && !bin.includes(path.sep),
    cwd: path.join(root, 'backend'),
    env,
  })
  if (r.error && r.error.code === 'ENOENT') continue
  lastStatus = r.status == null ? 1 : r.status
  process.exit(lastStatus)
}

console.error('ERROR: Python not found. Create .venv (py -3 -m venv .venv) or install Python 3 on PATH.')
process.exit(lastStatus)
