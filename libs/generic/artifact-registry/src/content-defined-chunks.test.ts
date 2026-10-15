import { describe, expect, it } from "vitest";
import {
  contentDefinedChunkBoundaries,
  contentDefinedChunks,
  DEFAULT_CDC_AVG_SIZE,
} from "./content-defined-chunks.js";

/** Deterministic pseudo-random bytes (LCG), so every assertion is reproducible. */
function prng(n: number, seed = 12345): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const key = (chunk: Uint8Array): string => Array.from(chunk).join(",");

describe("contentDefinedChunkBoundaries", () => {
  it("tiles the input exactly, in order", () => {
    const bytes = prng(300_000);
    const chunks = contentDefinedChunks(bytes);
    expect(chunks.length).toBeGreaterThan(1);
    expect(concat(...chunks)).toEqual(bytes);
    const ends = contentDefinedChunkBoundaries(bytes);
    expect(ends.at(-1)).toBe(bytes.length);
    for (let i = 1; i < ends.length; i++) expect(ends[i]!).toBeGreaterThan(ends[i - 1]!);
  });

  it("keeps every chunk inside [minSize, maxSize] except a short final chunk", () => {
    const avgSize = 1024;
    const chunks = contentDefinedChunks(prng(400_000, 7), { avgSize });
    for (const c of chunks.slice(0, -1)) {
      expect(c.length).toBeGreaterThanOrEqual(avgSize / 4);
      expect(c.length).toBeLessThanOrEqual(avgSize * 8);
    }
    expect(chunks.at(-1)!.length).toBeLessThanOrEqual(avgSize * 8);
  });

  it("averages near the requested size on random data", () => {
    const bytes = prng(2_000_000, 99);
    const mean = bytes.length / contentDefinedChunkBoundaries(bytes).length;
    expect(mean).toBeGreaterThan(DEFAULT_CDC_AVG_SIZE * 0.6);
    expect(mean).toBeLessThan(DEFAULT_CDC_AVG_SIZE * 1.6);
  });

  it("cuts at a forced maxSize on content with no natural boundary", () => {
    const zeros = new Uint8Array(100_000);
    const ends = contentDefinedChunkBoundaries(zeros, { avgSize: 1024 });
    expect(ends[0]).toBe(1024 * 8);
  });

  it("returns no chunks for empty input and one chunk for input at or under minSize", () => {
    expect(contentDefinedChunkBoundaries(new Uint8Array(0))).toEqual([]);
    expect(contentDefinedChunkBoundaries(prng(100))).toEqual([100]);
  });

  it("re-synchronizes after an insertion: a shared prefix and suffix keep their chunks", () => {
    // The dedupe property the gateway spool relies on: turn N+1's body is turn N's
    // body with an edit near the end and a new tail. Only chunks around the edit change.
    const base = prng(600_000, 3);
    const edited = concat(base.subarray(0, 450_000), prng(700, 4), base.subarray(450_000), prng(20_000, 5));
    const before = new Set(contentDefinedChunks(base).map(key));
    const after = contentDefinedChunks(edited);
    const newBytes = after.filter((c) => !before.has(key(c))).reduce((n, c) => n + c.length, 0);
    // 20.7 kB of genuinely new bytes; allow two re-synchronization chunks on top.
    expect(newBytes).toBeLessThan(20_700 + 2 * DEFAULT_CDC_AVG_SIZE * 8);
    expect(newBytes / edited.length).toBeLessThan(0.15);
  });

  it("is deterministic across calls", () => {
    const bytes = prng(150_000, 11);
    expect(contentDefinedChunkBoundaries(bytes)).toEqual(contentDefinedChunkBoundaries(bytes));
  });

  it("GOLDEN: boundaries are pinned (changing the gear table or masks breaks dedupe against stored chunks)", () => {
    const ends = contentDefinedChunkBoundaries(prng(200_000));
    expect(ends.length).toBe(22);
    expect(ends.slice(0, 8)).toEqual([11661, 14494, 23564, 40954, 49741, 59924, 69007, 74608]);
  });

  it("rejects a non-power-of-two average and inconsistent sizes", () => {
    expect(() => contentDefinedChunkBoundaries(prng(10), { avgSize: 1000 })).toThrow(RangeError);
    expect(() => contentDefinedChunkBoundaries(prng(10), { avgSize: 128 })).toThrow(RangeError);
    expect(() => contentDefinedChunkBoundaries(prng(10), { avgSize: 1024, minSize: 2048 })).toThrow(RangeError);
    expect(() => contentDefinedChunkBoundaries(prng(10), { avgSize: 1024, maxSize: 512 })).toThrow(RangeError);
  });
});
