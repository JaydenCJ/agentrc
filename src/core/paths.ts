import path from "node:path";

/** Directory where agentrc keeps its own files (config, state, secret store). */
export function agentrcDir(home: string): string {
  return path.join(home, ".agentrc");
}

export function defaultConfigPath(home: string): string {
  return path.join(agentrcDir(home), "agentrc.yaml");
}

export function statePath(home: string): string {
  return path.join(agentrcDir(home), "state.json");
}

export function secretsFilePath(home: string): string {
  return path.join(agentrcDir(home), "secrets.json");
}
