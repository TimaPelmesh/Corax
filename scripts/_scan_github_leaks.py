#!/usr/bin/env python3
"""Scan origin/main tree + recent history for likely secret leaks. Never print secret values."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Patterns that look like real secrets (not intentional lab defaults in docs).
PATTERNS = [
    ("ssh_pass_literal", re.compile(r"baobab123", re.I)),
    ("healed_admin_sample", re.compile(r"LoBBjLFpRcRUVd71WC9m")),
    ("env_assignment_long_hex", re.compile(r"(?i)(SECRET_KEY|AGENT_TOKEN|AGENT_TOKEN_PEPPER|POSTGRES_PASSWORD)\s*=\s*[0-9a-f]{32,}")),
    ("aws_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private_key_block", re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----")),
    ("github_pat", re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}")),
    ("generic_bearer", re.compile(r"(?i)(api[_-]?key|password|token)\s*[:=]\s*['\"][^'\"]{16,}['\"]")),
]

# Allowed intentional defaults / docs noise
ALLOW_SNIPPETS = {
    "admin123",
    "inventory",
    "change-me",
    "generate-with-openssl",
    "dev-secret-key-change-me",
    "dev-agent-token-change-in-production",
    "BOOTSTRAP_ADMIN_PASSWORD=admin123",
    "POSTGRES_PASSWORD=inventory",
    "SECRET_KEY=dev-secret-key-change-me",
    "SECRET_KEY=generate-with-openssl-rand-hex-32",
    "POSTGRES_PASSWORD=generate-with-openssl-rand-hex-32",
}


def run(args: list[str]) -> str:
    p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.stdout


def main() -> int:
    print("=== Repo visibility / tip ===")
    print(run(["git", "rev-parse", "origin/main"]).strip())
    print("ahead:", run(["git", "rev-list", "--count", "origin/main..HEAD"]).strip())

    print("\n=== Forbidden pathnames ever in git? ===")
    names = run(["git", "log", "--all", "--pretty=format:", "--name-only", "--", "**/.env", ".env", "backend/.env", "**/.docker-credentials", "backend/.docker-credentials"])
    leaked_paths = sorted({ln.strip() for ln in names.splitlines() if ln.strip()})
    if leaked_paths:
        print("WARN paths appeared in history:")
        for p in leaked_paths:
            print(" ", p)
    else:
        print("OK: .env / .docker-credentials never appeared in name-only history search")

    print("\n=== Currently tracked suspicious names on origin/main ===")
    tree = run(["git", "ls-tree", "-r", "origin/main", "--name-only"])
    suspicious = []
    for ln in tree.splitlines():
        low = ln.lower()
        if low.endswith(".env") and not low.endswith(".env.example") and "example" not in low:
            suspicious.append(ln)
        if "docker-credentials" in low or low.endswith(".pem") or low.endswith(".key"):
            if "example" not in low:
                suspicious.append(ln)
        if "_remote_" in low:
            suspicious.append(ln)
    print("OK none" if not suspicious else "\n".join(suspicious))

    print("\n=== Content scan origin/main (blob text) ===")
    # Scan all text-ish blobs at origin/main without printing matches values
    files = [ln for ln in tree.splitlines() if ln]
    findings = []
    for rel in files:
        if any(rel.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".exe", ".dll", ".zip", ".7z", ".pdf", ".woff", ".woff2")):
            continue
        blob = run(["git", "show", f"origin/main:{rel}"])
        if not blob:
            continue
        for name, rx in PATTERNS:
            for m in rx.finditer(blob):
                snippet = m.group(0)
                # skip known lab defaults
                if any(a.lower() in snippet.lower() for a in ALLOW_SNIPPETS) and name in {
                    "generic_bearer",
                    "env_assignment_long_hex",
                }:
                    # still flag long hex assignments — those are real leaks
                    if name != "env_assignment_long_hex":
                        continue
                # For env_assignment_long_hex always flag
                line_no = blob[: m.start()].count("\n") + 1
                findings.append((rel, line_no, name, len(snippet)))

    if not findings:
        print("OK: no high-risk secret patterns on origin/main tip")
    else:
        print(f"WARN: {len(findings)} potential leak(s) on origin/main tip:")
        for rel, line_no, name, length in findings[:50]:
            print(f"  {rel}:{line_no}  kind={name}  match_len={length}  (value redacted)")

    print("\n=== Scan last 30 commits for baobab / long hex env assigns (redacted) ===")
    log = run(["git", "log", "origin/main", "-n", "30", "-p", "--", "*.py", "*.md", "*.sh", "*.js", "*.yml", "*.yaml", "*.example", "*.txt", "*.json"])
    hist_hits = []
    for name, rx in PATTERNS:
        for m in rx.finditer(log):
            # locate approximate file from diff headers nearby
            start = max(0, m.start() - 200)
            ctx = log[start : m.start()]
            file_hint = "?"
            for ln in reversed(ctx.splitlines()):
                if ln.startswith("+++ b/") or ln.startswith("diff --git"):
                    file_hint = ln.replace("+++ b/", "").split()[-1] if "+++ b/" in ln else ln
                    break
            hist_hits.append((name, file_hint, len(m.group(0))))
    if not hist_hits:
        print("OK: no high-risk patterns in last 30 commits patch text")
    else:
        # dedupe
        seen = set()
        print(f"WARN: {len(hist_hits)} hits in recent history patches:")
        for name, file_hint, length in hist_hits:
            key = (name, file_hint)
            if key in seen:
                continue
            seen.add(key)
            print(f"  kind={name}  near={file_hint}  match_len={length}  (value redacted)")

    print("\n=== Unpushed commit (if any) file list ===")
    print(run(["git", "diff", "--name-only", "origin/main..HEAD"]) or "(none)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
