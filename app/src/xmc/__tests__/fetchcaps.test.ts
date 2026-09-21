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
  discover,
  itemSelection,
  looksPreEscaped,
  probeDocument,
  reportFrom,
  sharingFromVersioning,
  sharingOfField,
  totalOf,
} from "../fetchcaps";
import type { CapabilityId, ProbeItem } from "../fetchcaps";
import type { SchemaShape } from "../introspect";

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

// ── the live Authoring schema's actual shapes ────────────────────────────────
//
// Two defects found by installing a media item and getting an item with no version at all.
// Both were silent: the package built, the install reported success, and the result was
// wrong. The fixtures below are the real schema — `ItemTemplateField.versioning` as a
// single enum, and a paginated `fields` connection.

/** The live schema, as introspection reports it. */
const LIVE: SchemaShape = {
  item: {
    name: "Item",
    fields: new Map([
      ["itemId", "ID"],
      ["name", "String"],
      ["fields", "ItemFieldConnection"],
      ["versions", "Item"],
      ["isFallback", "Boolean"],
      ["parent", "Item"],
    ]),
    args: new Map([["fields", new Set(["first", "after", "ownFields", "excludeStandardFields"])]]),
  },
  field: {
    name: "ItemField",
    fields: new Map([
      ["name", "String"],
      ["value", "String"],
      ["fieldId", "ID"],
      ["containsStandardValue", "Boolean"],
      ["templateField", "ItemTemplateField"],
    ]),
    args: new Map(),
  },
  // No `shared`, no `unversioned` — just the one enum. This is the whole bug.
  templateField: {
    name: "ItemTemplateField",
    fields: new Map([
      ["name", "String"],
      ["type", "String"],
      ["versioning", "FieldVersioning"],
      ["templateFieldId", "ID"],
    ]),
    args: new Map(),
  },
  fieldsConnection: {
    name: "ItemFieldConnection",
    fields: new Map([
      ["nodes", "ItemField"],
      ["totalCount", "Int"],
      ["pageInfo", "PageInfo"],
    ]),
    args: new Map(),
  },
  fieldsAreConnection: true,
  versionsAreConnection: false,
};

describe("field sharing on a schema that states it as one enum", () => {
  it("selects templateField { versioning } when there is no boolean pair", () => {
    const d = discover(LIVE);
    expect(d.tfVersioning).toBe("versioning");
    const selection = itemSelection(new Set<CapabilityId>(["fieldSharing"]), d);
    expect(selection).toContain("versioning");
  });

  it("maps the enum to our three sharings, whatever its casing", () => {
    expect(sharingFromVersioning("SHARED")).toBe("Shared");
    expect(sharingFromVersioning("UNVERSIONED")).toBe("Unversioned");
    expect(sharingFromVersioning("Versioned")).toBe("Versioned");
    expect(sharingFromVersioning("nonsense")).toBeUndefined();
    expect(sharingFromVersioning(undefined)).toBeUndefined();
  });

  it("reads an Unversioned media field, which the boolean pair could never see", () => {
    // A media item on Unversioned/Image keeps blob, size and extension unversioned. Read as
    // Versioned, they are written as version-1 values, the target files them as unversioned
    // anyway, and the version is left with nothing in it — an item with no version.
    expect(sharingOfField({ templateField: { versioning: "UNVERSIONED" } })).toBe("Unversioned");
    expect(sharingOfField({ versioning: "SHARED" })).toBe("Shared");
  });

  it("still prefers explicit booleans where a schema has them", () => {
    expect(sharingOfField({ shared: true, versioning: "UNVERSIONED" })).toBe("Shared");
  });

  it("counts the capability as supported once the enum answers", () => {
    const capability = CAPABILITIES.find((c) => c.id === "fieldSharing")!;
    expect(capability.selection(discover(LIVE))).toBeDefined();
    expect(
      capability.assert({ fields: { nodes: [{ templateField: { versioning: "VERSIONED" } }] } }),
    ).toBe(true);
  });
});

describe("the fields connection is paged", () => {
  it("asks for the whole field set rather than the endpoint's default page", () => {
    // The default is 50 (`GraphQL.DefaultPageSize`) and the Standard Template alone brings
    // about ninety fields, so an unpaged selection packages a prefix of every item.
    const selection = itemSelection(new Set<CapabilityId>(), discover(LIVE));
    expect(selection).toMatch(/fields\(first: \d{3,}\)/);
  });

  it("asks for totalCount when the connection reports it, so truncation is visible", () => {
    expect(itemSelection(new Set<CapabilityId>(), discover(LIVE))).toContain("totalCount");
  });

  it("does not send a paging argument the schema has no argument for", () => {
    // Sending `first:` at a connection that does not take one turns a working query into a
    // validation error, and `fieldId` is a hard stop — so an unpageable schema stays
    // readable rather than becoming unusable.
    const noArgs: SchemaShape = { ...LIVE, item: { ...LIVE.item, args: new Map() } };
    const selection = itemSelection(new Set<CapabilityId>(), discover(noArgs));
    expect(selection).not.toContain("first:");
    expect(selection).toContain("nodes {");
  });

  it("reports how many entries a connection says it holds", () => {
    expect(totalOf({ nodes: [{}], totalCount: 97 })).toBe(97);
    expect(totalOf([{}])).toBeUndefined();
    expect(totalOf({ nodes: [{}] })).toBeUndefined();
  });
});
