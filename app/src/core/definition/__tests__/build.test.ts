// Unit tests for the definition writer that do NOT need the git-ignored samples, so
// the schema stays protected in CI. The sample round-trip in roundtrip.test.ts is the
// stronger check; this pins the specific rules that are easy to regress.

import { describe, it, expect } from "vitest";
import {
  buildDefinition,
  emptyDefinition,
  formatAccountRef,
  formatItemRef,
  parseAccountRef,
  parseDefinition,
  parseItemRef,
} from "../index";
import { ASK_USER } from "../../model";
import type { PackageDefinition, SourceDefinition } from "../../model";

const ID = "{513A5371-AA83-4DB2-A559-E5687586B400}";

function withSources(...sources: SourceDefinition[]): PackageDefinition {
  return { ...emptyDefinition(), metadata: { name: "P" }, sources };
}

describe("item references", () => {
  it("round-trips a language- and version-scoped reference", () => {
    const ref = "/master/sitecore/content/Home/" + ID + "/invariant/0";
    const parsed = parseItemRef(ref);
    expect(parsed).toEqual({
      database: "master",
      path: "/sitecore/content/Home",
      id: ID,
      language: "invariant",
      version: 0,
    });
    expect(formatItemRef(parsed!)).toBe(ref);
  });

  it("keeps an explicit language and version", () => {
    const ref = "/web/sitecore/content/" + ID + "/en/2";
    expect(formatItemRef(parseItemRef(ref)!)).toBe(ref);
  });

  it("rejects shapes without a braced id", () => {
    expect(parseItemRef("/master/sitecore/content/Home/en/0")).toBeUndefined();
    expect(parseItemRef("nonsense")).toBeUndefined();
  });
});

describe("account references", () => {
  it("round-trips roles and users", () => {
    for (const ref of ["roles:sitecore\\Author", "users:sitecore\\jane@example.com"]) {
      expect(formatAccountRef(parseAccountRef(ref)!)).toBe(ref);
    }
  });

  it("rejects an unknown account type", () => {
    expect(parseAccountRef("groups:sitecore\\Author")).toBeUndefined();
  });
});

describe("buildDefinition", () => {
  it("writes an empty project with self-closing empty elements and CRLF, no trailing newline", () => {
    const xml = buildDefinition({ ...emptyDefinition(), metadata: { name: "Package Name" } });
    expect(xml).toBe(
      [
        "<project>",
        "  <Metadata>",
        "    <metadata>",
        "      <PackageName>Package Name</PackageName>",
        "      <Author />",
        "      <Version />",
        "      <Revision />",
        "      <License />",
        "      <Comment />",
        "      <Attributes />",
        "      <Readme />",
        "      <Publisher />",
        "      <PostStep />",
        "      <PackageID />",
        "    </metadata>",
        "  </Metadata>",
        "  <SaveProject>True</SaveProject>",
        "  <Sources />",
        "  <Converter>",
        "    <TrivialConverter>",
        "      <Transforms />",
        "    </TrivialConverter>",
        "  </Converter>",
        "  <Include />",
        "  <Exclude />",
        "  <Name />",
        "</project>",
      ].join("\r\n"),
    );
  });

  it("packs custom attributes with a trailing separator", () => {
    const xml = buildDefinition({
      ...emptyDefinition(),
      metadata: { name: "P", attributes: { a: "1", b: "2" } },
    });
    expect(xml).toContain("<Attributes>a=1|b=2|</Attributes>");
  });

  it("escapes markup in text content", () => {
    const xml = buildDefinition({
      ...emptyDefinition(),
      metadata: { name: "P", readme: "a < b & c > d" },
    });
    expect(xml).toContain("<Readme>a &lt; b &amp; c &gt; d</Readme>");
    expect(parseDefinition(xml).metadata.readme).toBe("a < b & c > d");
  });

  it("writes a bare Transforms for an xitems source left at Ask User", () => {
    const xml = buildDefinition(
      withSources({
        kind: "items-static",
        uid: "u",
        name: "s",
        behaviour: { ...ASK_USER },
        skipVersions: false,
        entries: [
          { database: "master", path: "/sitecore/content", id: ID, language: "invariant", version: 0 },
        ],
      }),
    );
    expect(xml).toContain("<ItemToEntryConverter>\r\n          <Transforms />");
    expect(xml).not.toContain("InstallerConfigurationTransform");
  });

  it("writes the behaviour block for an xitems source with an explicit mode", () => {
    const xml = buildDefinition(
      withSources({
        kind: "items-static",
        uid: "u",
        name: "s",
        behaviour: { itemMode: "Merge", itemMergeMode: "Append" },
        skipVersions: true,
        entries: [],
      }),
    );
    expect(xml).toContain("<ItemMode>Merge</ItemMode>");
    expect(xml).toContain("<ItemMergeMode>Append</ItemMergeMode>");
    expect(xml).toContain("<SkipVersions>True</SkipVersions>");
  });

  it("orders NotOlderThan before the ActionDate pair for ITEM date filters", () => {
    const xml = buildDefinition(
      withSources({
        kind: "items-dynamic",
        uid: "u",
        name: "s",
        behaviour: { ...ASK_USER },
        database: "master",
        root: ID,
        skipVersions: false,
        include: { created: { mode: "within", days: 30 } },
        exclude: {},
      }),
    );
    const block = xml.slice(xml.indexOf("<ItemDateFilter>"), xml.indexOf("</ItemDateFilter>"));
    expect(block.indexOf("NotOlderThan")).toBeLessThan(block.indexOf("ActionDateTo"));
  });

  it("orders NotOlderThan after the ActionDate pair for FILE date filters", () => {
    const xml = buildDefinition(
      withSources({
        kind: "files-dynamic",
        uid: "u",
        name: "s",
        behaviour: { ...ASK_USER },
        root: "/App_Config",
        converterRoot: "/",
        include: { created: { mode: "within", days: 30 } },
        exclude: {},
      }),
    );
    const block = xml.slice(xml.indexOf("<FileDateFilter>"), xml.indexOf("</FileDateFilter>"));
    expect(block.indexOf("NotOlderThan")).toBeGreaterThan(block.indexOf("ActionDateTo"));
  });

  it("round-trips an explicit date range", () => {
    const def = withSources({
      kind: "items-dynamic",
      uid: "u",
      name: "s",
      behaviour: { ...ASK_USER },
      database: "master",
      root: ID,
      skipVersions: false,
      include: { modified: { mode: "range", from: "20240101T000000", to: "20241231T000000" } },
      exclude: {},
    });
    const back = parseDefinition(buildDefinition(def));
    const src = back.sources[0];
    if (src.kind !== "items-dynamic") throw new Error("expected a dynamic item source");
    expect(src.include.modified).toEqual({
      mode: "range",
      from: "20240101T000000",
      to: "20241231T000000",
    });
  });

  it("round-trips every source kind in one project", () => {
    const def = withSources(
      {
        kind: "items-static",
        uid: "a",
        name: "static items",
        behaviour: { ...ASK_USER },
        skipVersions: false,
        entries: [
          { database: "master", path: "/sitecore/content", id: ID, language: "invariant", version: 0 },
        ],
      },
      {
        kind: "items-dynamic",
        uid: "b",
        name: "dynamic items",
        behaviour: { itemMode: "Overwrite", itemMergeMode: "Undefined" },
        database: "master",
        root: ID,
        skipVersions: false,
        include: { name: { pattern: "Home", searchType: "Simple" }, languages: ["en", "da"] },
        exclude: {},
      },
      {
        kind: "files-static",
        uid: "c",
        name: "static files",
        behaviour: { ...ASK_USER },
        entries: ["/bin/", "/bin/Thing.dll"],
        converterRoot: "/",
      },
      {
        kind: "files-dynamic",
        uid: "d",
        name: "dynamic files",
        behaviour: { ...ASK_USER },
        root: "/App_Config",
        converterRoot: "/",
        include: { name: { pattern: "*.config", acceptDirectories: true } },
        exclude: {},
      },
      {
        kind: "accounts",
        uid: "e",
        name: "accounts",
        behaviour: { ...ASK_USER },
        entries: [{ type: "roles", domain: "sitecore", name: "Author" }],
      },
    );

    const xml = buildDefinition(def);
    const back = parseDefinition(xml);

    expect(back.sources.map((s) => s.kind)).toEqual([
      "items-static",
      "items-dynamic",
      "files-static",
      "files-dynamic",
      "accounts",
    ]);
    // uid is client-side only and regenerated on parse, so compare everything else.
    expect(buildDefinition(back)).toBe(xml);
  });
});
