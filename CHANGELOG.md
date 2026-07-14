# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-08

### Added

- Declarative manifest (`agentrc.yaml`, `version: 1`) describing MCP servers,
  skills, hooks and permission rules for all clients at once.
- Format converters (adapters) for four clients:
  - **Claude Code** — `~/.claude.json` (typed MCP entries), `~/.claude/settings.json`
    (hooks in native PascalCase event schema, permissions), `~/.claude/skills/`.
  - **Codex** — `~/.codex/config.toml` (`[mcp_servers.*]` tables); remote
    transports and unsupported features are skipped with explicit warnings.
  - **Cursor** — `~/.cursor/mcp.json` (stdio + url entries).
  - **Gemini CLI** — `~/.gemini/settings.json` (`httpUrl` for http, `url` for sse).
- `agentrc sync` with managed-entry state tracking (`~/.agentrc/state.json`):
  merges into existing configs, preserves user-owned entries, removes entries
  dropped from the manifest, atomic writes, `.agentrc.bak` backups,
  `--dry-run`, `--client`, `--no-backup`.
- Secret references `${secret:NAME}` with `$$` escaping, resolved via
  env > OS keychain (macOS `security` / Linux `secret-tool`) > chmod-600 file
  store; `--refs` mode (write `${NAME}` env-style references instead of
  values); `agentrc secret set/get/list/rm`. When an environment variable
  shadows an explicitly stored secret, `sync`/`status`/`diff` print a notice
  and `secret set` warns immediately.
- Team presets via `extends:` (cycle detection, diamond graphs supported) and
  per-project overlays (`.agentrc.yaml`, `null` deletes inherited entries)
  with project-scope sync (`--project`): `.mcp.json`, `.cursor/mcp.json`,
  `.gemini/settings.json`, `.claude/settings.json`.
- Skills sync: install/update/remove skill directories into
  `~/.claude/skills/` (or `<project>/.claude/skills/`).
- `agentrc status [--check]` (CI-friendly drift detection) and `agentrc diff`
  (unified diffs of pending changes).
- `agentrc import <client>` reverse converters, with automatic "secretize"
  (credential-looking values become `${secret:NAME}`; `--save-secrets` stores
  them) and `agentrc init --from <client>`.
- `agentrc init` starter manifest and `agentrc doctor` environment report
  (detected clients, capability matrix, secret backends, state summary).
- Strict manifest validation with actionable error messages; transport
  inference (command -> stdio, url -> http). Relative skill paths and
  `./`-style hook commands resolve against the file that declares them.
  All validation (including skill source existence) runs before the first
  byte is written.
- Human-facing output shows paths relative to `~`; reports and state keep
  real paths.
- Runnable end-to-end demo (`examples/demo.sh`) against a sandbox `$HOME`
  and a self-asserting smoke test (`scripts/smoke.sh`).
- 101 unit/integration tests (vitest); TypeScript strict mode; MIT license.
