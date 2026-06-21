import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readMetadata, writeMetadata } from "../metadata";
import { EXTRACTED_DIR, hasSamples, bytesEqual } from "./samples";

/** Load a sample's metadata/ folder as fileName → bytes. */
function loadMetadata(sample: string): Map<string, Uint8Array> {
  const dir = join(EXTRACTED_DIR, sample, "inner", "metadata");
  const out = new Map<string, Uint8Array>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    out.set(f, new Uint8Array(readFileSync(join(dir, f))));
  }
  return out;
}

describe.skipIf(!hasSamples)("metadata — read/write", () => {
  it("reads standard fields and custom attributes from empty-package", () => {
    const files = loadMetadata("empty-package");
    expect(files.size).toBeGreaterThan(0);
    const meta = readMetadata(files);
    expect(meta.name).toBe("Package Name");
    expect(meta.version).toBe("1.0.0");
    expect(meta.readme).toBe("Readme is here");
    // empty-package defines two custom attributes
    expect(meta.attributes?.["Custom attribute 1"]).toBe("Custom attribute 1 value");
  });

  it("re-emits byte-identical content for every standard field present", () => {
    const files = loadMetadata("empty-package");
    const written = writeMetadata(readMetadata(files));
    for (const [name, bytes] of files) {
      const out = written.get(name);
      expect(out, `missing re-emitted ${name}`).toBeDefined();
      expect(bytesEqual(out!, bytes), `mismatch for ${name}`).toBe(true);
    }
  });
});
