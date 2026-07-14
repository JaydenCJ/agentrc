#!/usr/bin/env bash
# agentrc end-to-end demo.
#
# Everything runs inside examples/sandbox/ (gitignored): a fake $HOME is used
# via --home, so your real client configs are never touched.
#
#   ./examples/demo.sh
set -euo pipefail

EXAMPLES_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$EXAMPLES_DIR")"
SANDBOX="$EXAMPLES_DIR/sandbox"
HOME_DIR="$SANDBOX/home"
PROJECT_DIR="$SANDBOX/project"

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

if [ ! -f "$ROOT_DIR/dist/index.js" ]; then
  step "building agentrc (npm run build)"
  (cd "$ROOT_DIR" && npm run build)
fi

agentrc() { node "$ROOT_DIR/dist/index.js" --home "$HOME_DIR" --config "$SANDBOX/agentrc.yaml" "$@"; }

step "preparing sandbox"
rm -rf "$SANDBOX"
mkdir -p "$HOME_DIR"
cp -r "$EXAMPLES_DIR/agentrc.yaml" "$EXAMPLES_DIR/presets" "$EXAMPLES_DIR/skills" "$EXAMPLES_DIR/hooks" "$SANDBOX/"
cp -r "$EXAMPLES_DIR/project" "$PROJECT_DIR"
echo "sandbox: $SANDBOX"

step "agentrc doctor"
agentrc doctor

step "store a secret (never written into the manifest)"
printf 'ghp_demo_token_123' | agentrc secret set DEMO_GITHUB_TOKEN --store file

step "agentrc sync -- one command, four clients"
agentrc sync

step "generated client configs"
for f in "$HOME_DIR/.claude.json" "$HOME_DIR/.claude/settings.json" \
         "$HOME_DIR/.codex/config.toml" "$HOME_DIR/.cursor/mcp.json" \
         "$HOME_DIR/.gemini/settings.json"; do
  echo
  echo "--- $f"
  cat "$f"
done
echo
echo "--- installed skill"
ls "$HOME_DIR/.claude/skills/code-review"

step "agentrc status --check (in sync -> exit 0)"
agentrc status --check

step "edit the manifest: drop the docs server, then diff"
sed -i.bak '/^  docs:/,/^    url: .*$/d' "$SANDBOX/agentrc.yaml" && rm -f "$SANDBOX/agentrc.yaml.bak"
agentrc diff || true

step "sync again: agentrc removes only what it manages"
agentrc sync

step "project scope: per-repo overlay (.agentrc.yaml) disables/adds servers"
agentrc sync --project "$PROJECT_DIR"
echo
echo "--- $PROJECT_DIR/.mcp.json"
cat "$PROJECT_DIR/.mcp.json"

step "import: convert an existing client config back into a manifest"
agentrc import codex

step "done"
if [ "${KEEP_SANDBOX:-0}" = "1" ]; then
  echo "The sandbox is left in $SANDBOX for inspection (KEEP_SANDBOX=1)."
else
  rm -rf "$SANDBOX"
  echo "Sandbox cleaned up (set KEEP_SANDBOX=1 to keep it for inspection)."
fi
