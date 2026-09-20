// The escaping spec, asserted against every real node Sitecore wrote rather than against
// a handful of invented cases: for each <content> body and each attribute value in the
// sample packages, escape(decode(raw)) must return the original bytes.
//
// That one property is the whole contract. It is what lets core/items/build.ts hand
// decoded model values to serializeItemXml (which escapes nothing) and still produce
// byte-identical output.

import { describe, it, expect } from "vitest";
import { readZip } from "../../zip";
import { parseItemXml, decodeXml } from "../index";
import { escapeAttr, escapeContent } from "../escape";
import { hasSamples, samplePackages, readBytes } from "../../__tests__/samples";

/** Every item entry across the sample packages, parsed. */
function sampleItemEntries() {
  const out: ReturnType<typeof parseItemXml>[] = [];
  for (const path of samplePackages()) {
    const inner = readZip(readZip(readBytes(path)).byName.get("package.zip")!.data);
    for (const e of inner.entries) {
      if (e.name.startsWith("items/") && e.name.endsWith("/xml")) {
        out.push(parseItemXml(new TextDecoder("utf-8").decode(e.data)));
      }
    }
  }
  return out;
}

describe("escaping — unit", () => {
  it("escapes only & < > in content, leaving quotes literal", () => {
    // Measured: 126 sample content nodes carry a bare `"`, and none carry &quot;/&apos;.
    expect(escapeContent('a & b < c > d "q" \'p\'')).toBe("a &amp; b &lt; c &gt; d \"q\" 'p'");
  });

  it("escapes & < \" in attributes but leaves > alone, as XmlTextWriter does", () => {
    expect(escapeAttr('a & b < c > d "q"')).toBe("a &amp; b &lt; c > d &quot;q&quot;");
  });

  it("escapes attribute whitespace that a parser would otherwise normalise away", () => {
    expect(escapeAttr("a\r\n\tb")).toBe("a&#xD;&#xA;&#x9;b");
  });

  it("round-trips one level, so nested markup survives unchanged", () => {
    const stored = "&lt;image mediaid=\"{F8B6426B-0000-0000-0000-000000000000}\" /&gt;";
    expect(decodeXml(stored)).toBe('<image mediaid="{F8B6426B-0000-0000-0000-000000000000}" />');
    expect(escapeContent(decodeXml(stored))).toBe(stored);
  });

  it("round-trips a value whose real text contains an entity", () => {
    const stored = "&amp;lt;not markup&amp;gt;";
    expect(decodeXml(stored)).toBe("&lt;not markup&gt;");
    expect(escapeContent(decodeXml(stored))).toBe(stored);
  });

  it("decodes numeric references, so the codec reads back its own attribute output", () => {
    expect(decodeXml(escapeAttr("a\rb"))).toBe("a\rb");
    // One level only: an escaped ampersand must not collapse two levels.
    expect(decodeXml("&amp;#x41;")).toBe("&#x41;");
  });
});

describe.skipIf(!hasSamples)("escaping — every value in the sample packages", () => {
  it("escapeContent(decodeXml(raw)) === raw for every <content> node", () => {
    let checked = 0;
    for (const entry of sampleItemEntries()) {
      for (const field of entry.fields) {
        if (field.content === null) continue;
        expect(escapeContent(decodeXml(field.content))).toBe(field.content);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("escapeAttr(decodeXml(raw)) === raw for every attribute value", () => {
    let checked = 0;
    for (const entry of sampleItemEntries()) {
      for (const a of [...entry.attrs, ...entry.fields.flatMap((f) => f.attrs)]) {
        expect(escapeAttr(decodeXml(a.value))).toBe(a.value);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
