/** Minimal line-based unified diff (LCS backtracking). Config files are
 *  small, so the O(n*m) table is fine. */

type Op = { type: "eq" | "del" | "add"; line: string };

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", line: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++]! });
  while (j < m) ops.push({ type: "add", line: b[j++]! });
  return ops;
}

export interface DiffOptions {
  oldLabel?: string;
  newLabel?: string;
  context?: number;
}

/** Returns "" when the texts have no line-level differences. */
export function unifiedDiff(oldText: string, newText: string, options: DiffOptions = {}): string {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  if (!ops.some((op) => op.type !== "eq")) return "";

  const context = options.context ?? 3;
  const oldLabel = options.oldLabel ?? "current";
  const newLabel = options.newLabel ?? "new";

  // Expand each changed op by `context` lines, merging overlapping ranges.
  const ranges: Array<[number, number]> = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type === "eq") continue;
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length - 1, k + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }

  // Old/new line numbers at each op index.
  const positions: Array<{ old: number; new: number }> = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    positions.push({ old: oldLine, new: newLine });
    if (op.type !== "add") oldLine++;
    if (op.type !== "del") newLine++;
  }

  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const [lo, hi] of ranges) {
    const slice = ops.slice(lo, hi + 1);
    const oldCount = slice.filter((op) => op.type !== "add").length;
    const newCount = slice.filter((op) => op.type !== "del").length;
    const pos = positions[lo]!;
    out.push(`@@ -${pos.old},${oldCount} +${pos.new},${newCount} @@`);
    for (const op of slice) {
      const prefix = op.type === "eq" ? " " : op.type === "del" ? "-" : "+";
      out.push(prefix + op.line);
    }
  }
  return `${out.join("\n")}\n`;
}
