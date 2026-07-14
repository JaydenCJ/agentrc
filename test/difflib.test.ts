import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/core/difflib.js";

describe("unifiedDiff", () => {
  it("returns an empty string for identical texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("marks additions and deletions with hunk headers", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nX\nc\n", { oldLabel: "old", newLabel: "new" });
    expect(diff).toContain("--- old");
    expect(diff).toContain("+++ new");
    expect(diff).toContain("-b");
    expect(diff).toContain("+X");
    expect(diff).toMatch(/@@ -1,3 \+1,3 @@/);
  });

  it("produces separate hunks for distant changes", () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[2] = "changed-early";
    newLines[27] = "changed-late";
    const diff = unifiedDiff(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`);
    const hunks = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunks).toHaveLength(2);
    expect(diff).toContain("+changed-early");
    expect(diff).toContain("+changed-late");
  });

  it("handles creation from empty text", () => {
    const diff = unifiedDiff("", "hello\nworld\n");
    expect(diff).toContain("+hello");
    expect(diff).toContain("+world");
    const deletions = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(deletions).toEqual([]);
  });
});
