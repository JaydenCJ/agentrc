#!/usr/bin/env bash
# agentrc smoke test.
#
# Exercises the built CLI end to end against a throwaway $HOME:
# init -> secret set -> sync (4 clients) -> status --check -> drift -> cleanup.
# Self-asserting: every step is verified; prints "SMOKE OK" and exits 0 only
# when everything passed. Runs entirely offline (no network access needed).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "smoke FAIL: $1" >&2
  exit 1
}

[ -d "$ROOT_DIR/node_modules" ] || fail "node_modules missing -- run 'npm ci' first"
if [ ! -f "$ROOT_DIR/dist/index.js" ]; then
  echo "[smoke] dist/ missing, building once"
  (cd "$ROOT_DIR" && npm run build) || fail "npm run build failed"
fi

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agentrc-smoke-XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
HOME_DIR="$SANDBOX/home"
mkdir -p "$HOME_DIR"

agentrc() { node "$ROOT_DIR/dist/index.js" --home "$HOME_DIR" "$@"; }

# Make sure the ambient environment cannot interfere with secret resolution.
unset AGENTRC_SMOKE_TOKEN || true

echo "[smoke] 1/8 --version and --help"
VERSION="$(agentrc --version)"
PKG_VERSION="$(node -p 'require("'"$ROOT_DIR"'/package.json").version')"
[ "$VERSION" = "$PKG_VERSION" ] || fail "--version printed '$VERSION', package.json says '$PKG_VERSION'"
agentrc --help | grep -q '^Usage: agentrc' || fail "--help does not print usage"

echo "[smoke] 2/8 init creates a starter manifest"
agentrc init >/dev/null
MANIFEST="$HOME_DIR/.agentrc/agentrc.yaml"
[ -f "$MANIFEST" ] || fail "init did not create $MANIFEST"

# Replace the starter manifest with a real one covering servers, a skill,
# a hook with a manifest-relative command, and permissions.
mkdir -p "$HOME_DIR/.agentrc/skills/smoke-skill" "$HOME_DIR/.agentrc/hooks"
printf '# smoke skill\n' > "$HOME_DIR/.agentrc/skills/smoke-skill/SKILL.md"
printf '#!/bin/sh\nexit 0\n' > "$HOME_DIR/.agentrc/hooks/guard.sh"
chmod +x "$HOME_DIR/.agentrc/hooks/guard.sh"
cat > "$MANIFEST" <<'YAML'
version: 1
clients: [claude-code, codex, cursor, gemini-cli]
mcpServers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:AGENTRC_SMOKE_TOKEN}"
  docs:
    transport: http
    url: https://mcp.example.com/docs
skills:
  smoke-skill:
    path: ./skills/smoke-skill
hooks:
  preToolUse:
    - matcher: Bash
      command: ./hooks/guard.sh
      timeout: 10
permissions:
  allow: ["Bash(npm run test:*)"]
YAML

echo "[smoke] 3/8 sync with a missing secret fails before writing"
if agentrc sync >/dev/null 2>&1; then
  fail "sync succeeded although the secret is missing"
fi
[ ! -f "$HOME_DIR/.claude.json" ] || fail "sync wrote files although the secret was missing"

echo "[smoke] 4/8 secret set + sync writes all four client configs"
printf 'smoke-secret-value' | agentrc secret set AGENTRC_SMOKE_TOKEN --store file 2>/dev/null
SYNC_OUT="$(agentrc sync)"
echo "$SYNC_OUT" | grep -q 'done:' || fail "sync did not print a summary"
grep -q '"GITHUB_PERSONAL_ACCESS_TOKEN": "smoke-secret-value"' "$HOME_DIR/.claude.json" \
  || fail "secret not resolved into ~/.claude.json"
grep -q '\[mcp_servers\.github\]' "$HOME_DIR/.codex/config.toml" || fail "Codex TOML table missing"
grep -q '"github"' "$HOME_DIR/.cursor/mcp.json" || fail "Cursor entry missing"
grep -q '"httpUrl": "https://mcp.example.com/docs"' "$HOME_DIR/.gemini/settings.json" \
  || fail "Gemini httpUrl entry missing"
grep -q '"docs"' "$HOME_DIR/.codex/config.toml" && fail "http server was not skipped for Codex"
[ -f "$HOME_DIR/.claude/skills/smoke-skill/SKILL.md" ] || fail "skill was not installed"
grep -q "\"command\": \"$HOME_DIR/.agentrc/hooks/guard.sh\"" "$HOME_DIR/.claude/settings.json" \
  || fail "hook command was not resolved against the manifest directory"

echo "[smoke] 5/8 status --check reports in-sync (exit 0)"
agentrc status --check >/dev/null || fail "status --check exited non-zero right after sync"

echo "[smoke] 6/8 second sync is idempotent"
agentrc sync | grep -q 'done: 0 created, 0 updated' || fail "second sync was not idempotent"

echo "[smoke] 7/8 env shadow notice is reported"
SHADOW_OUT="$(AGENTRC_SMOKE_TOKEN=ambient agentrc status)"
echo "$SHADOW_OUT" | grep -q 'shadowing the value stored in the file store' \
  || fail "env shadow notice missing from status output"

echo "[smoke] 8/8 dropping a server removes only that server"
sed -i.bak '/^  docs:/,/^    url: .*$/d' "$MANIFEST" && rm -f "$MANIFEST.bak"
agentrc status --check >/dev/null && fail "status --check did not detect drift"
agentrc sync >/dev/null
grep -q '"docs"' "$HOME_DIR/.claude.json" && fail "dropped server still present in ~/.claude.json"
grep -q '"github"' "$HOME_DIR/.claude.json" || fail "remaining server disappeared from ~/.claude.json"
agentrc status --check >/dev/null || fail "status --check still reports drift after sync"

echo "SMOKE OK"
