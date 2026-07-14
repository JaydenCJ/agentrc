import fs from "node:fs";
import { type Parsed } from "../cli/args.js";
import { buildContext, type CliIO } from "../cli/context.js";
import { ADAPTERS } from "../adapters/index.js";
import type { AdapterContext } from "../adapters/types.js";
import { defaultResolver } from "../core/secrets.js";
import { loadState } from "../core/state.js";
import { CLIENT_IDS } from "../types.js";

export function cmdDoctor(parsed: Parsed, io: CliIO): number {
  const ctx = buildContext(parsed);
  io.out(`home:   ${ctx.home}`);
  io.out(`config: ${ctx.configPath}${fs.existsSync(ctx.configPath) ? "" : "  (missing -- run: agentrc init)"}`);
  io.out("");

  const adapterCtx: AdapterContext = {
    home: ctx.home,
    scope: ctx.projectDir !== undefined ? "project" : "user",
    ...(ctx.projectDir !== undefined ? { projectDir: ctx.projectDir } : {}),
  };

  io.out("clients:");
  for (const id of CLIENT_IDS) {
    const adapter = ADAPTERS[id];
    const detect = adapter.detect(adapterCtx);
    const status = detect.detected ? `detected (${detect.evidence})` : "not detected";
    io.out(`  ${id.padEnd(12)} ${status}`);
    for (const file of adapter.configPaths(adapterCtx)) {
      io.out(`  ${"".padEnd(12)}   writes: ${file}${fs.existsSync(file) ? "" : "  (absent)"}`);
    }
  }
  io.out("");

  io.out("capability matrix (feature -> synced or skipped with a warning):");
  io.out(`  ${"client".padEnd(12)} mcp    hooks  perms  skills transports`);
  for (const id of CLIENT_IDS) {
    const c = ADAPTERS[id].capabilities;
    const yn = (v: boolean): string => (v ? "yes" : "no ").padEnd(6);
    io.out(`  ${id.padEnd(12)} ${yn(c.mcpServers)} ${yn(c.hooks)} ${yn(c.permissions)} ${yn(c.skills)} ${c.transports.join(",")}`);
  }
  io.out("");

  io.out("secret backends (resolution order):");
  const resolver = defaultResolver(ctx.home);
  for (const backend of resolver.backendsInfo()) {
    io.out(`  ${backend.id.padEnd(9)} ${backend.available ? "available" : "unavailable"}${backend.writable ? ", writable" : ""}`);
  }
  io.out("");

  try {
    const state = loadState(ctx.home);
    const files = Object.keys(state.files).length;
    io.out(`state:  ${files} managed file(s), ${state.dirs.length} managed skill dir(s)`);
  } catch (err) {
    io.out(`state:  unreadable (${(err as Error).message})`);
  }
  return 0;
}
