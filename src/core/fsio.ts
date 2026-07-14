import fs from "node:fs";
import path from "node:path";
import { AgentrcError } from "./errors.js";

export function readTextIfExists(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write via a temp file + rename so a crash never leaves a half-written
 *  client config behind. */
export function writeFileAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.agentrc-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Copy `file` to `file.agentrc.bak` before the first destructive write. */
export function backupFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const backup = `${file}.agentrc.bak`;
  fs.copyFileSync(file, backup);
  return backup;
}

export function listFilesRecursive(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out.sort();
}

export function copyDirReplace(src: string, dest: string): void {
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new AgentrcError(`source directory not found: ${src}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true });
}

export function dirsEqual(a: string, b: string): boolean {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  const filesA = listFilesRecursive(a);
  const filesB = listFilesRecursive(b);
  if (filesA.join("\n") !== filesB.join("\n")) return false;
  return filesA.every((rel) => fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel))));
}

export function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}
