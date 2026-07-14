import { flagBool, type Parsed } from "../cli/args.js";
import { buildContext, type CliIO } from "../cli/context.js";
import { displayPath, runEngine } from "../core/engine.js";
import { printReport } from "../cli/report.js";

export function cmdSync(parsed: Parsed, io: CliIO): number {
  const ctx = buildContext(parsed);
  const dryRun = flagBool(parsed, "dry-run");
  const report = runEngine({
    home: ctx.home,
    configPath: ctx.configPath,
    ...(ctx.projectDir !== undefined ? { projectDir: ctx.projectDir } : {}),
    ...(ctx.clients !== undefined ? { clients: ctx.clients } : {}),
    write: !dryRun,
    refs: flagBool(parsed, "refs"),
    backup: !flagBool(parsed, "no-backup"),
  });
  printReport(report, io, { dryRun, json: flagBool(parsed, "json") });
  return 0;
}

export function cmdStatus(parsed: Parsed, io: CliIO): number {
  const ctx = buildContext(parsed);
  const report = runEngine({
    home: ctx.home,
    configPath: ctx.configPath,
    ...(ctx.projectDir !== undefined ? { projectDir: ctx.projectDir } : {}),
    ...(ctx.clients !== undefined ? { clients: ctx.clients } : {}),
    write: false,
    refs: flagBool(parsed, "refs"),
  });
  printReport(report, io, { dryRun: true, json: flagBool(parsed, "json") });
  if (flagBool(parsed, "check") && report.changed) return 1;
  return 0;
}

export function cmdDiff(parsed: Parsed, io: CliIO): number {
  const ctx = buildContext(parsed);
  const report = runEngine({
    home: ctx.home,
    configPath: ctx.configPath,
    ...(ctx.projectDir !== undefined ? { projectDir: ctx.projectDir } : {}),
    ...(ctx.clients !== undefined ? { clients: ctx.clients } : {}),
    write: false,
    wantDiff: true,
    refs: flagBool(parsed, "refs"),
  });
  if (flagBool(parsed, "json")) {
    io.out(JSON.stringify(report, null, 2));
    return 0;
  }
  let printed = false;
  for (const file of report.files) {
    if (file.diff !== undefined && file.diff !== "") {
      io.out(file.diff.trimEnd());
      io.out("");
      printed = true;
    }
  }
  for (const dir of report.dirs) {
    if (dir.action !== "unchanged") {
      io.out(`skill ${dir.name}: would ${dir.action} ${displayPath(dir.target, report.home)}`);
      printed = true;
    }
  }
  if (!printed) io.out("everything in sync");
  return 0;
}
