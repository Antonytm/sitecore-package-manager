// Test-only helpers for the git-ignored sample packages under <repo>/files.
// These suites are developer-local integration tests over real bytes; they self-skip
// when the samples are absent (e.g. CI), so the unit suites still run everywhere.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** <repo>/files — two levels up from app/ (app/src/core/__tests__ → app → repo). */
export const FILES_DIR = resolve(__dirname, "../../../../files");
export const SAMPLES_DIR = join(FILES_DIR, "samples", "packages");
export const EXTRACTED_DIR = join(FILES_DIR, "extracted");

export const hasSamples = existsSync(SAMPLES_DIR);

/** Sample package zips, excluding the 69 MB files-statically by default (size guard). */
export function samplePackages(includeLarge = false): string[] {
  if (!hasSamples) return [];
  return readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".zip"))
    .filter((f) => includeLarge || !f.startsWith("files-statically"))
    .map((f) => join(SAMPLES_DIR, f));
}

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/** Recursively list files under a directory (absolute paths). */
export function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Index of the first differing byte, or -1 if equal (for friendly assertion messages). */
export function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
