import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  parseItemXml,
  serializeItemXml,
  getAttr,
} from "../index";
import { EXTRACTED_DIR, hasSamples, walkFiles } from "../../__tests__/samples";

// Integration test for the item XML codec: serializeItemXml(parseItemXml(x)) === x for
// every real items/**/xml entry in files/extracted. Self-skips without samples.
const itemXmlFiles = hasSamples
  ? walkFiles(EXTRACTED_DIR).filter(
      (p) =>
        /[\\/]inner[\\/]items[\\/]/.test(p) &&
        !p.includes("properties") &&
        p.endsWith("xml"),
    )
  : [];

describe.skipIf(!hasSamples)("item XML codec — byte-faithful round-trip", () => {
  it(`found item entries to test`, () => {
    expect(itemXmlFiles.length).toBeGreaterThan(0);
  });

  for (const path of itemXmlFiles) {
    it(`round-trips: ${relative(EXTRACTED_DIR, path)}`, () => {
      const xml = readFileSync(path, "utf8");
      expect(serializeItemXml(parseItemXml(xml))).toBe(xml);
    });
  }
});

describe.skipIf(!hasSamples)("item XML codec — semantic parse", () => {
  it("reads item attributes and fields of the Data item", () => {
    const hit = itemXmlFiles.find((p) =>
      p.includes("{2C1361EB-9485-4764-A5A3-E5B402EEFBA3}"),
    );
    expect(hit).toBeDefined();
    const entry = parseItemXml(readFileSync(hit!, "utf8"));
    expect(getAttr(entry.attrs, "name")).toBe("Data");
    expect(getAttr(entry.attrs, "id")).toBe("{2C1361EB-9485-4764-A5A3-E5B402EEFBA3}");
    expect(getAttr(entry.attrs, "language")).toBe("en");
    expect(getAttr(entry.attrs, "version")).toBe("1");
    expect(entry.fields.length).toBeGreaterThan(0);
    // every field carries the authoritative template-field id
    for (const f of entry.fields) {
      expect(getAttr(f.attrs, "tfid")).toMatch(/^\{[0-9A-F-]+\}$/i);
    }
  });

  it("preserves escaped markup verbatim for a Layout/rendering field", () => {
    // Somewhere in the corpus a __renderings layout value is stored as escaped XML.
    let layoutContent: string | undefined;
    for (const path of itemXmlFiles) {
      const entry = parseItemXml(readFileSync(path, "utf8"));
      const f = entry.fields.find((x) => (x.content ?? "").includes("&lt;r "));
      if (f) {
        layoutContent = f.content!;
        break;
      }
    }
    expect(layoutContent, "expected an escaped-markup layout field").toBeDefined();
    // raw content keeps &lt;/&gt;/&amp; untouched (no decode on the faithful path):
    // a layout value's own `&` round-trips as the double-escaped `&amp;amp;`.
    expect(layoutContent).toContain("&amp;amp;");
  });
});
