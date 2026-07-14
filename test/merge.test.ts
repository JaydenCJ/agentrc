import { describe, expect, it } from "vitest";
import { clone, deepMerge, isPlainObject, stripNulls } from "../src/core/merge.js";

describe("deepMerge", () => {
  it("merges nested objects recursively", () => {
    const base = { a: { x: 1, y: 2 }, keep: true };
    const overlay = { a: { y: 3, z: 4 } };
    expect(deepMerge(base, overlay)).toEqual({ a: { x: 1, y: 3, z: 4 }, keep: true });
  });

  it("replaces arrays instead of concatenating them", () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it("deletes a key when the overlay value is null", () => {
    const merged = deepMerge({ servers: { a: { command: "x" }, b: { command: "y" } } }, { servers: { a: null } });
    expect(merged).toEqual({ servers: { b: { command: "y" } } });
  });

  it("ignores a null deletion for a key that does not exist", () => {
    expect(deepMerge({ servers: {} }, { servers: { ghost: null } })).toEqual({ servers: {} });
  });

  it("lets scalars in the overlay replace objects", () => {
    expect(deepMerge({ a: { deep: true } }, { a: "flat" })).toEqual({ a: "flat" });
  });

  it("does not mutate its inputs and does not share references", () => {
    const base = { a: { list: [1] } };
    const overlay = { b: { nested: { v: 1 } } };
    const merged = deepMerge(base, overlay) as Record<string, unknown>;
    (merged.a as { list: number[] }).list.push(99);
    (merged.b as { nested: { v: number } }).nested.v = 42;
    expect(base.a.list).toEqual([1]);
    expect(overlay.b.nested.v).toBe(1);
  });

  it("returns a clone of base when the overlay is undefined", () => {
    const base = { a: 1 };
    const merged = deepMerge(base, undefined);
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });
});

describe("stripNulls", () => {
  it("removes null-valued entries recursively", () => {
    expect(stripNulls({ a: null, b: { c: null, d: 1 } })).toEqual({ b: { d: 1 } });
  });

  it("preserves arrays and scalars", () => {
    expect(stripNulls({ list: ["x", "y"], n: 0, s: "" })).toEqual({ list: ["x", "y"], n: 0, s: "" });
  });
});

describe("clone / isPlainObject", () => {
  it("distinguishes plain objects from arrays and null", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });

  it("deep-clones nested structures", () => {
    const original = { a: [{ b: 1 }] };
    const copy = clone(original);
    copy.a[0]!.b = 2;
    expect(original.a[0]!.b).toBe(1);
  });
});
