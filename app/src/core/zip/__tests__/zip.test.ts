import { describe, it, expect } from "vitest";
import { basename } from "node:path";
import { readZip, writeZip } from "../index";
import {
  hasSamples,
  samplePackages,
  readBytes,
  bytesEqual,
  firstDiff,
} from "../../__tests__/samples";

// Integration test for the raw-preserving zip codec: writeZip(readZip(b)) === b, for the
// outer wrapper AND the nested package.zip of every sample. Self-skips without samples.
describe.skipIf(!hasSamples)("zip codec — byte-faithful round-trip", () => {
  for (const path of samplePackages()) {
    const name = basename(path);

    it(`outer round-trips: ${name}`, () => {
      const bytes = readBytes(path);
      const out = writeZip(readZip(bytes));
      expect(firstDiff(out, bytes)).toBe(-1);
      expect(out.length).toBe(bytes.length);
    });

    it(`inner package.zip round-trips: ${name}`, () => {
      const outer = readZip(readBytes(path));
      const inner = outer.byName.get("package.zip");
      expect(inner, "outer should contain package.zip").toBeDefined();
      const innerBytes = inner!.data;
      const out = writeZip(readZip(innerBytes));
      expect(bytesEqual(out, innerBytes)).toBe(true);
    });
  }
});

// The 69 MB files-statically sample stores its inner package.zip UNCOMPRESSED (method 0);
// gate it behind RUN_LARGE so the default run stays fast.
describe.skipIf(!hasSamples || !process.env.RUN_LARGE)("zip codec — large sample", () => {
  for (const path of samplePackages(true).filter((p) => p.includes("files-statically"))) {
    it(`outer round-trips: ${basename(path)}`, () => {
      const bytes = readBytes(path);
      expect(bytesEqual(writeZip(readZip(bytes)), bytes)).toBe(true);
    });
  }
});
