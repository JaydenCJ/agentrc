import fs from "node:fs";
import { flagBool, flagStr, type Parsed } from "../cli/args.js";
import { buildContext, type CliIO } from "../cli/context.js";
import { writeFileAtomic } from "../core/fsio.js";
import { renderImportedManifest } from "./import.js";

const TEMPLATE = `# agentrc manifest -- the single source of truth for your AI coding agents.
# Sync it with: agentrc sync
version: 1

# Team presets: merge other manifests underneath this one.
# extends:
#   - ./presets/team-base.yaml

# Which clients to sync. Remove the ones you do not use.
clients: [claude-code, codex, cursor, gemini-cli]

# MCP servers, declared once. agentrc converts each entry to every client's
# native format (JSON for Claude Code / Cursor / Gemini CLI, TOML for Codex).
mcpServers: {}
#   github:
#     command: npx
#     args: ["-y", "@modelcontextprotocol/server-github"]
#     env:
#       # Never write credentials here: reference the OS keychain instead.
#       GITHUB_PERSONAL_ACCESS_TOKEN: "\${secret:GITHUB_TOKEN}"
#   docs:
#     transport: http
#     url: https://mcp.example.com/docs

# Skills (directories with a SKILL.md) installed into clients that support
# them. Relative paths resolve against this file.
skills: {}
#   code-review:
#     path: ./skills/code-review

# Hooks (mapped to Claude Code's hook events; other clients warn + skip).
# hooks:
#   preToolUse:
#     - matcher: Bash
#       command: ./hooks/guard.sh
#       timeout: 10

# Permission rules (mapped to Claude Code; other clients warn + skip).
# permissions:
#   allow:
#     - "Bash(npm run test:*)"
#   deny:
#     - "Read(./.env)"
`;

export function cmdInit(parsed: Parsed, io: CliIO): number {
  const ctx = buildContext(parsed);
  const force = flagBool(parsed, "force");
  if (fs.existsSync(ctx.configPath) && !force) {
    io.err(`agentrc: ${ctx.configPath} already exists (use --force to overwrite)`);
    return 1;
  }

  const from = flagStr(parsed, "from");
  let content: string;
  if (from !== undefined) {
    const rendered = renderImportedManifest(from, ctx, parsed, io);
    if (rendered === undefined) return 1;
    content = rendered;
  } else {
    content = TEMPLATE;
  }

  writeFileAtomic(ctx.configPath, content);
  io.out(`created ${ctx.configPath}`);
  io.out(`next: edit it, then run "agentrc sync"`);
  return 0;
}
