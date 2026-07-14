import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentrcError } from "../core/errors.js";
import { defaultConfigPath } from "../core/paths.js";
import { CLIENT_IDS, isClientId, type ClientId } from "../types.js";
import { flagList, flagStr, type Parsed } from "./args.js";

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

export const defaultIO: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface GlobalContext {
  home: string;
  configPath: string;
  projectDir?: string;
  clients?: ClientId[];
}

export function buildContext(parsed: Parsed, env: NodeJS.ProcessEnv = process.env): GlobalContext {
  const home = path.resolve(flagStr(parsed, "home") ?? env.AGENTRC_HOME ?? os.homedir());
  const configPath = path.resolve(flagStr(parsed, "config") ?? env.AGENTRC_CONFIG ?? defaultConfigPath(home));
  const ctx: GlobalContext = { home, configPath };

  const project = flagStr(parsed, "project");
  if (project !== undefined) {
    const abs = path.resolve(project);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new AgentrcError(`project directory not found: ${abs}`);
    }
    ctx.projectDir = abs;
  }

  const clients = flagList(parsed, "client");
  if (clients.length > 0) {
    const ids: ClientId[] = [];
    for (const c of clients) {
      if (!isClientId(c)) {
        throw new AgentrcError(`unknown client "${c}" (expected one of: ${CLIENT_IDS.join(", ")})`);
      }
      ids.push(c);
    }
    ctx.clients = ids;
  }
  return ctx;
}
