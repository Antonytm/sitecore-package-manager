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

  // Without provenance there are no source bytes to replay, so the package is rebuilt from
  // the model. That cannot be byte-identical — cross-implementation DEFLATE is not
  // canonical — but it must be a readable package that means the same thing. Entry-level
  // byte-equality is asserted separately, in rebuild.test.ts.
  it("rebuilds a readable, equivalent package after dropping provenance", async () => {
    const path = samplePackages().find((p) => p.includes("items-dynamically"));
    const model = await readPackage(readBytes(path!));
    model.provenance = undefined;

    const again = await readPackage(await writePackage(model));

    expect(again.metadata).toEqual(model.metadata);
    expect(again.items.length).toBe(model.items.length);
    expect(again.sources.map((s) => s.kind)).toEqual(model.sources.map((s) => s.kind));

    const byId = new Map(again.items.map((i) => [i.id, i]));
    for (const item of model.items) {
      const round = byId.get(item.id);
      expect(round, item.path).toBeDefined();
      expect(round!.templateId).toBe(item.templateId);
      expect(round!.parentId).toBe(item.parentId);
      expect(round!.created).toBe(item.created);
      expect(round!.sortorder).toBe(item.sortorder);
      // Empty-valued fields are deliberately not serialized, so compare what survives.
      const kept = (i: typeof item) =>
        i.sharedFields.filter((f) => f.value !== "").map((f) => f.id + "=" + f.value);
      expect(kept(round!).sort()).toEqual(kept(item).sort());
      expect(round!.languages.map((l) => l.language)).toEqual(
        item.languages.map((l) => l.language),
      );
    }
  });
});
