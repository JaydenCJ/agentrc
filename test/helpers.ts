import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentrc-test-"));
}

export function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
