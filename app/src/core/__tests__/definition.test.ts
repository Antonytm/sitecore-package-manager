import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseDefinition } from "../definition";
import { EXTRACTED_DIR, hasSamples } from "./samples";

function readProject(sample: string): string | undefined {
  const p = join(EXTRACTED_DIR, sample, "inner", "installer", "project");
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

describe.skipIf(!hasSamples)("definition — semantic parse", () => {
  it("extracts metadata from empty-package", () => {
    const xml = readProject("empty-package");
    expect(xml).toBeDefined();
    const { metadata } = parseDefinition(xml!);
    expect(metadata.name).toBe("Package Name");
    expect(metadata.version).toBe("1.0.0");
    expect(metadata.author).toBe("Author");
    expect(metadata.attributes?.["Custom attribute 1"]).toBe("Custom attribute 1 value");
  });

  it("extracts a static item source with item GUIDs", () => {
    const xml = readProject("items-statically");
    expect(xml).toBeDefined();
    const { sources } = parseDefinition(xml!);
    const statics = sources.filter((s) => s.kind === "items-static");
    expect(statics.length).toBeGreaterThan(0);
    const withEntries = statics.find(
      (s) => s.kind === "items-static" && s.entries.length > 0,
    );
    expect(withEntries, "expected a static source with entries").toBeDefined();
    if (withEntries && withEntries.kind === "items-static") {
      expect(withEntries.database).toBe("master");
      for (const id of withEntries.entries) {
        expect(id).toMatch(/^\{[0-9A-Fa-f-]{36}\}$/);
      }
    }
  });

  it("extracts a dynamic item source with root + filters", () => {
    const xml = readProject("items-dynamically");
    expect(xml).toBeDefined();
    const { sources } = parseDefinition(xml!);
    const dyn = sources.find((s) => s.kind === "items-dynamic");
    expect(dyn, "expected a dynamic item source").toBeDefined();
    if (dyn && dyn.kind === "items-dynamic") {
      expect(dyn.database).toBe("master");
      expect(dyn.root).toMatch(/^\{[0-9A-Fa-f-]{36}\}$/);
    }
  });
});
