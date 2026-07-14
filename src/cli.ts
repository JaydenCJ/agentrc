import { createRequire } from "node:module";
import { parseArgs, type FlagDef } from "./cli/args.js";
import { defaultIO, type CliIO } from "./cli/context.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdImport } from "./commands/import.js";
import { cmdInit } from "./commands/init.js";
import { cmdSecret } from "./commands/secret.js";
import { cmdDiff, cmdStatus, cmdSync } from "./commands/sync.js";
import { AgentrcError } from "./core/errors.js";

const require = createRequire(import.meta.url);

export function version(): string {
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

const FLAGS: FlagDef[] = [
  { name: "home", takesValue: true },
  { name: "config", takesValue: true },
  { name: "project", takesValue: true },
  { name: "client", takesValue: true, repeatable: true },
  { name: "json", takesValue: false },
  { name: "dry-run", takesValue: false },
  { name: "refs", takesValue: false },
  { name: "no-backup", takesValue: false },
  { name: "check", takesValue: false },
  { name: "force", takesValue: false },
  { name: "output", alias: "o", takesValue: true },
  { name: "from", takesValue: true },
  { name: "no-secretize", takesValue: false },
  { name: "save-secrets", takesValue: false },
  { name: "store", takesValue: true },
  { name: "help", alias: "h", takesValue: false },
  { name: "version", alias: "V", takesValue: false },
];

const HELP = `agentrc ${version()} -- dotfiles manager for AI coding agents

Declare MCP servers, skills, hooks and permissions once; sync them to
Claude Code, Codex, Cursor and Gemini CLI.

Usage: agentrc <command> [options]

Commands:
  init                 Create a starter manifest (<home>/.agentrc/agentrc.yaml)
  sync                 Apply the manifest to every targeted client config
  status               Show what sync would change (never writes)
  diff                 Unified diffs of pending changes (never writes)
  import <client>      Convert an existing client config into manifest YAML
  secret set NAME [V]  Store a secret (keychain when available, else file store)
  secret get NAME      Resolve a secret (env > keychain > file store)
  secret list          List secrets in enumerable stores
  secret rm NAME       Remove a secret from writable stores
  doctor               Show detected clients, capabilities and secret backends
  help                 Show this help

Clients: claude-code, codex, cursor, gemini-cli

Options:
  --home <dir>         Override home directory (default: $AGENTRC_HOME or OS home)
  --config <file>      Manifest path (default: <home>/.agentrc/agentrc.yaml)
  --project <dir>      Project scope: merge the project overlay (.agentrc.yaml)
                       and write project-level client configs
  --client <id>        Restrict to one client (repeatable)
  --dry-run            sync: plan only, write nothing
  --refs               Write \${NAME} env-style references instead of secrets
  --no-backup          Skip <file>.agentrc.bak backups before overwriting
  --check              status: exit 1 when out of sync (for CI)
  --json               Machine-readable report
  -o, --output <file>  import: write YAML to a file instead of stdout
  --force              Overwrite existing files (init, import -o)
  --from <client>      init: seed the manifest from an existing client config
  --no-secretize       import: keep credential-looking values inline
  --save-secrets       import: store extracted credentials in the secret store
  --store <backend>    secret set: force backend (keychain | file)
  -h, --help           Show help
  -V, --version        Show version
`;

export function run(argv: string[], io: CliIO = defaultIO): number {
  const all = parseArgs(argv, FLAGS);
  if (all.flags.version === true) {
    io.out(version());
    return 0;
  }
  const command = all.positionals[0];
  if (command === undefined || command === "help" || all.flags.help === true) {
    io.out(HELP.trimEnd());
    return 0;
  }
  if (command === "version") {
    io.out(version());
    return 0;
  }

  const parsed = { flags: all.flags, positionals: all.positionals.slice(1) };

  switch (command) {
    case "init":
      return cmdInit(parsed, io);
    case "sync":
      return cmdSync(parsed, io);
    case "status":
      return cmdStatus(parsed, io);
    case "diff":
      return cmdDiff(parsed, io);
    case "import":
      return cmdImport(parsed, io);
    case "secret":
      return cmdSecret(parsed, io);
    case "doctor":
      return cmdDoctor(parsed, io);
    default:
      throw new AgentrcError(`unknown command "${command}" (see: agentrc help)`, 2);
  }
}
