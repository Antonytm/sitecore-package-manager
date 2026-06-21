import { describe, it, expect } from "vitest";
import { basename } from "node:path";
import { readPackage, writePackage } from "../package";
import {
  hasSamples,
  samplePackages,
  readBytes,
  bytesEqual,
  firstDiff,
} from "./samples";

// THE headline integration test: writePackage(readPackage(bytes)) === bytes, full outer
// envelope, for every sample package. Proves the ZIP↔model↔ZIP conversion is byte-faithful
// via provenance replay. Self-skips without samples; excludes the 69 MB files-statically.
describe.skipIf(!hasSamples)("package round-trip — byte-identical envelope", () => {
  for (const path of samplePackages()) {
    const name = basename(path);
    it(`round-trips: ${name}`, async () => {
      const bytes = readBytes(path);
      const out = await writePackage(await readPackage(bytes));
      const at = firstDiff(out, bytes);
      expect(at, `first differing byte at ${at}`).toBe(-1);
      expect(bytesEqual(out, bytes)).toBe(true);
    });
  }
});

describe.skipIf(!hasSamples)("package read — semantic model", () => {
  it("builds items, metadata and sources for items-statically", async () => {
    const path = samplePackages().find((p) => p.includes("items-statically"));
    expect(path).toBeDefined();
    const model = await readPackage(readBytes(path!));

    expect(model.metadata.name).toBe("Package Name");
    expect(model.items.length).toBeGreaterThan(0);

    // Every item carries identity + at least one language/version.
    for (const item of model.items) {
      expect(item.id).toMatch(/^\{[0-9A-Fa-f-]{36}\}$/);
      expect(item.templateId).toMatch(/^\{[0-9A-Fa-f-]{36}\}$/);
      expect(item.languages.length).toBeGreaterThan(0);
    }

    // The multi-language Dictionary item appears under several languages.
    const dict = model.items.find(
      (i) => i.id === "{08D3DCC5-AD4E-429C-A565-3858040829CD}",
    );
    expect(dict, "expected the Dictionary item").toBeDefined();
    const langs = dict!.languages.map((l) => l.language).sort();
    expect(langs).toEqual(["en", "en-CA", "en-GB", "ja-JP"]);

    // Shared fields are deduped once (not repeated per language/version).
    const sharedIds = dict!.sharedFields.map((f) => f.id);
    expect(new Set(sharedIds).size).toBe(sharedIds.length);

    expect(model.sources.some((s) => s.kind === "items-static")).toBe(true);
  });

  it("round-trips after dropping provenance is rejected (rebuild not yet supported)", async () => {
    const path = samplePackages().find((p) => p.includes("empty-package"));
    const model = await readPackage(readBytes(path!));
    model.provenance = undefined;
    await expect(writePackage(model)).rejects.toThrow(/not implemented/);
  });
});
