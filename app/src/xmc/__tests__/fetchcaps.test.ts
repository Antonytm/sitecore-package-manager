// The capability ladder, driven by hand-written fixture responses.
//
// This is the file that gets corrected once the real Authoring schema is known, so its
// tests are about the DECISION LOGIC, not about any particular selection string: does a
// capability that merely validated still count as missing, and does a missing hard-stop
// capability actually stop generation.

import { describe, it, expect } from "vitest";
import {
  CAPABILITIES,
  describeBlocked,
  looksPreEscaped,
  probeDocument,
  reportFrom,
} from "../fetchcaps";
import type { CapabilityId, ProbeItem } from "../fetchcaps";

const answers = (m: Partial<Record<CapabilityId, ProbeItem | undefined>>) =>
  new Map(Object.entries(m) as [CapabilityId, ProbeItem | undefined][]);

/** An item that answers every capability properly. */
const FULL: ProbeItem = {
  itemId: "11111111111111111111111111111111",
  fields: {
    nodes: [
      {
        id: "{8CDC337E-A112-42FB-BBB4-4143751E123F}",
        name: "__Revision",
        value: "abc",
        type: "Single-Line Text",
        containsStandardValue: false,
        shared: false,
        unversioned: false,
      },
    ],
  },
  parent: { itemId: "22222222222222222222222222222222" },
  isFallback: false,
  versions: { nodes: [{ version: 1 }, { version: 2 }] },
  languages: [{ name: "en" }],
  children: { totalCount: 2, nodes: [{}, {}] },
};

const everything = () => answers(Object.fromEntries(CAPABILITIES.map((c) => [c.id, FULL])));

describe("probeDocument", () => {
  it("asks for one capability at a time", () => {
    // A single unknown field invalidates a whole document, so a combined probe could only
    // report that *something* was missing.
    const doc = probeDocument("languages { name }");
    expect(doc).toContain("languages { name }");
    expect(doc).not.toContain("versions");
    expect(doc).toContain("$itemId: ID");
  });

  it("declares itemId as ID, not String", () => {
    // GraphQL validates a declared variable type even when it is not supplied; declaring
    // this as String rejected every item query once already.
    expect(probeDocument("itemId")).toContain("$itemId: ID");
  });
});

describe("reportFrom", () => {
  it("reports every capability supported when the endpoint answers fully", () => {
    const report = reportFrom(everything());
    expect(report.missing).toEqual([]);
    expect(report.blocking).toEqual([]);
    expect(report.supported.size).toBe(CAPABILITIES.length);
  });

  it("treats a rejected request as missing", () => {
    const report = reportFrom(answers({ ...Object.fromEntries(CAPABILITIES.map((c) => [c.id, FULL])), versions: undefined }));
    expect(report.missing.map((c) => c.id)).toEqual(["versions"]);
    expect(report.blocking.map((c) => c.id)).toEqual(["versions"]);
  });

  it("treats a request that VALIDATES but answers with nothing as missing", () => {
    // The trap resolve.ts already hit: an unknown Sitecore field name is only an argument,
    // so the query is accepted and comes back empty. No error, no data, no capability.
    const empty: ProbeItem = { itemId: "x", fields: { nodes: [] } };
    const report = reportFrom(answers({ fieldId: empty, ownValues: empty }));
    expect(report.blocking.map((c) => c.id)).toContain("fieldId");
    expect(report.blocking.map((c) => c.id)).toContain("ownValues");
  });

  it("does not accept a field list that omits the id", () => {
    const noIds: ProbeItem = { fields: { nodes: [{ name: "Title", value: "x" }] } };
    expect(reportFrom(answers({ fieldId: noIds })).supported.has("fieldId")).toBe(false);
  });

  it("does not accept an id that is not a GUID", () => {
    const badId: ProbeItem = { fields: { nodes: [{ id: "Title", value: "x" }] } };
    expect(reportFrom(answers({ fieldId: badId })).supported.has("fieldId")).toBe(false);
  });

  it("requires containsStandardValue to be a boolean, not merely present", () => {
    const nulled: ProbeItem = {
      fields: { nodes: [{ id: "{8CDC337E-A112-42FB-BBB4-4143751E123F}", containsStandardValue: undefined }] },
    };
    expect(reportFrom(answers({ ownValues: nulled })).supported.has("ownValues")).toBe(false);
  });

  it("counts a truncated children list as missing even though it answered", () => {
    const truncated: ProbeItem = { children: { totalCount: 40, nodes: [{}, {}] } };
    const report = reportFrom(answers({ childrenTotal: truncated }));
    expect(report.supported.has("childrenTotal")).toBe(false);
    // Truncation is bad but not unbuildable — it does not block on its own.
    expect(report.blocking.map((c) => c.id)).not.toContain("childrenTotal");
  });

  it("classifies field type and languages as recoverable, not blocking", () => {
    const report = reportFrom(answers({ fieldId: FULL, ownValues: FULL, versions: FULL }));
    expect(report.missing.map((c) => c.id).sort()).toEqual(
      ["childrenTotal", "fallback", "fieldSharing", "fieldType", "languages", "parent"].sort(),
    );
    expect(report.blocking).toEqual([]);
  });
});

describe("describeBlocked", () => {
  it("says nothing when nothing blocks", () => {
    expect(describeBlocked(reportFrom(everything()))).toBeUndefined();
  });

  it("names each thing the endpoint would not supply", () => {
    const message = describeBlocked(reportFrom(new Map()))!;
    expect(message).toContain("the GUID of each field");
    expect(message).toContain("__Standard values");
    expect(message).toContain("the version numbers of each item");
  });
});

describe("looksPreEscaped", () => {
  it("spots a value the endpoint already escaped", () => {
    // Escaping it again would ship an Image field that renders as literal text.
    expect(looksPreEscaped('&lt;image mediaid="{F8B6426B}" /&gt;')).toBe(true);
    expect(looksPreEscaped("&amp;lt;image")).toBe(true);
  });

  it("passes a raw stored value through", () => {
    expect(looksPreEscaped('<image mediaid="{F8B6426B}" />')).toBe(false);
    expect(looksPreEscaped("plain text")).toBe(false);
  });
});
