import type { ClientId } from "../types.js";
import { displayPath, type DirAction, type FileAction, type SyncReport } from "../core/engine.js";
import type { CliIO } from "./context.js";

const FILE_MARK: Record<FileAction["action"], string> = {
  create: "+",
  update: "~",
  unchanged: "=",
  skip: ".",
};

const DIR_MARK: Record<DirAction["action"], string> = {
  create: "+",
  update: "~",
  unchanged: "=",
  remove: "x",
};

export interface PrintOptions {
  dryRun: boolean;
  json?: boolean;
  showDiff?: boolean;
}

export function printReport(report: SyncReport, io: CliIO, options: PrintOptions): void {
  if (options.json === true) {
    io.out(JSON.stringify(report, null, 2));
    return;
  }

  const dp = (p: string): string => displayPath(p, report.home);
  io.out(`scope: ${report.scope}`);
  io.out(`manifest: ${report.manifestSources.map(dp).join(" + ")}`);
  for (const notice of report.notices) {
    io.out(`! ${notice}`);
  }
  io.out("");

  for (const client of report.clients) {
    io.out(client);
    const files = report.files.filter((f) => f.client === client);
    const dirs = report.dirs.filter((d) => d.client === client);
    const warnings = report.warnings.filter((w) => w.client === client);
    for (const file of files) {
      const detail = file.changes.length > 0 ? `  (${file.changes.join(", ")})` : "";
      const suffix = file.action === "skip" ? "  (nothing to write)" : detail;
      io.out(`  ${FILE_MARK[file.action]} ${dp(file.path)}${suffix}`);
      if (options.showDiff === true && file.diff !== undefined && file.diff !== "") {
        for (const line of file.diff.split("\n")) {
          if (line !== "") io.out(`      ${line}`);
        }
      }
    }
    for (const dir of dirs) {
      if (dir.action === "remove") {
        io.out(`  ${DIR_MARK[dir.action]} skill ${dir.name} removed from ${dp(dir.target)}`);
      } else {
        io.out(`  ${DIR_MARK[dir.action]} skill ${dir.name} -> ${dp(dir.target)}`);
      }
    }
    for (const warning of warnings) {
      io.out(`  ! ${warning.message}`);
    }
    if (files.length === 0 && dirs.length === 0 && warnings.length === 0) {
      io.out("  (nothing to do)");
    }
    io.out("");
  }

  io.out(summarize(report, options.dryRun));
}

export function summarize(report: SyncReport, dryRun: boolean): string {
  const created = report.files.filter((f) => f.action === "create").length;
  const updated = report.files.filter((f) => f.action === "update").length;
  const unchanged = report.files.filter((f) => f.action === "unchanged" || f.action === "skip").length;
  const skills = report.dirs.filter((d) => d.action === "create" || d.action === "update").length;
  const removed = report.dirs.filter((d) => d.action === "remove").length;
  const parts = [`${created} created`, `${updated} updated`, `${unchanged} unchanged`];
  if (skills > 0) parts.push(`${skills} skill(s) installed`);
  if (removed > 0) parts.push(`${removed} skill(s) removed`);
  if (report.warnings.length > 0) parts.push(`${report.warnings.length} warning(s)`);
  if (report.secretsResolved > 0) parts.push(`${report.secretsResolved} secret(s) resolved`);
  const prefix = dryRun ? "plan: " : "done: ";
  return prefix + parts.join(", ") + (dryRun ? " (nothing written)" : "");
}

export function clientList(report: SyncReport): ClientId[] {
  return report.clients;
}
