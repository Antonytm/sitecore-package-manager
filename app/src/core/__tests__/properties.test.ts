import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  parseProperties,
  serializeProperties,
  getProperty,
  parseFieldSharing,
} from "../properties";
import { EXTRACTED_DIR, hasSamples, walkFiles, bytesEqual } from "./samples";

const propFiles = hasSamples
  ? walkFiles(EXTRACTED_DIR).filter(
      (p) => /[\\/]properties[\\/]items[\\/]/.test(p) && p.endsWith("xml"),
    )
  : [];

describe.skipIf(!hasSamples)("properties side-car — byte-faithful round-trip", () => {
  it("found properties entries to test", () => {
    expect(propFiles.length).toBeGreaterThan(0);
  });

  for (const path of propFiles) {
    it(`round-trips: ${relative(EXTRACTED_DIR, path)}`, () => {
      const bytes = new Uint8Array(readFileSync(path));
      const out = serializeProperties(parseProperties(bytes));
      expect(bytesEqual(out, bytes)).toBe(true);
    });
  }
});

describe.skipIf(!hasSamples)("properties side-car — semantic parse", () => {
  it("reads identity fields and field sharing", () => {
    const path = propFiles.find((p) =>
      p.includes("{2C1361EB-9485-4764-A5A3-E5B402EEFBA3}"),
    );
    expect(path).toBeDefined();
    const props = parseProperties(new Uint8Array(readFileSync(path!)));
    expect(getProperty(props, "database")).toBe("master");
    expect(getProperty(props, "language")).toBe("en");
    expect(getProperty(props, "version")).toBe("1");
    const sharing = parseFieldSharing(props);
    expect(sharing.size).toBeGreaterThan(0);
    for (const v of sharing.values()) {
      expect(["Shared", "Unversioned", "Versioned"]).toContain(v);
    }
  });
});
