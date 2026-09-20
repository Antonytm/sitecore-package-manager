// Edge cases for ItemModel -> entries that the sample packages cannot exercise, because
// Sitecore never produced them: a language with no versions, non-contiguous version
// numbers, a name needing escaping, and an item whose `fieldproperties` was never read
// from a package (the generate-from-live path).
//
// The byte-for-byte agreement with real Sitecore output is asserted separately, in
// core/__tests__/rebuild.test.ts.

import { describe, it, expect } from "vitest";
import type { FieldModel, ItemModel } from "../../model";
import { serializeItemXml } from "../index";
import { serializeProperties } from "../../properties";
import { buildItemEntries, itemEntryKey } from "../build";

const field = (id: string, value: string, extra: Partial<FieldModel> = {}): FieldModel => ({
  id,
  name: "f" + id,
  type: "Single-Line Text",
  value,
  ...extra,
});

function item(over: Partial<ItemModel> = {}): ItemModel {
  return {
    id: "{11111111-1111-1111-1111-111111111111}",
    name: "Home",
    path: "/sitecore/content/Home",
    templateId: "{22222222-2222-2222-2222-222222222222}",
    parentId: "{33333333-3333-3333-3333-333333333333}",
    database: "master",
    sharedFields: [],
    languages: [{ language: "en", unversionedFields: [], versions: [{ version: 1, fields: [] }] }],
    ...over,
  };
}

const textOf = (e: { item: Parameters<typeof serializeItemXml>[0] }) => serializeItemXml(e.item);
const propsOf = (e: { properties: Parameters<typeof serializeProperties>[0] }) =>
  new TextDecoder().decode(serializeProperties(e.properties));

describe("itemEntryKey", () => {
  it("builds items/<db>/<path>/{ID}/<lang>/<ver>/xml", () => {
    expect(itemEntryKey(item(), "en", 1)).toBe(
      "items/master/sitecore/content/Home/{11111111-1111-1111-1111-111111111111}/en/1/xml",
    );
  });

  it("uses the item's own database, not a fixed one", () => {
    expect(itemEntryKey(item({ database: "web" }), "en", 1)).toContain("items/web/");
  });
});

describe("buildItemEntries", () => {
  it("emits one entry per language and version", () => {
    const entries = buildItemEntries(
      item({
        languages: [
          {
            language: "en",
            unversionedFields: [],
            versions: [{ version: 1, fields: [] }, { version: 2, fields: [] }],
          },
          { language: "da", unversionedFields: [], versions: [{ version: 1, fields: [] }] },
        ],
      }),
    );
    expect(entries.map((e) => e.key.slice(-9))).toEqual(["/en/1/xml", "/en/2/xml", "/da/1/xml"]);
  });

  it("uses the stored version number, not the array index", () => {
    // Deleting version 2 of 3 leaves {1,3}; a 1..N loop would emit /2/ and lose /3/.
    const entries = buildItemEntries(
      item({
        languages: [
          {
            language: "en",
            unversionedFields: [],
            versions: [{ version: 1, fields: [] }, { version: 3, fields: [] }],
          },
        ],
      }),
    );
    expect(entries.map((e) => e.key.slice(-9))).toEqual(["/en/1/xml", "/en/3/xml"]);
    expect(propsOf(entries[1])).toContain("version=3");
  });

  it("emits nothing for a language with no versions", () => {
    // `version=0` would read back as version-invariant, which is a different thing.
    const entries = buildItemEntries(
      item({ languages: [{ language: "fr", unversionedFields: [], versions: [] }] }),
    );
    expect(entries).toEqual([]);
  });

  it("omits empty-valued fields entirely rather than writing an empty <content>", () => {
    // Sitecore writes zero <content></content> nodes across 93 sample entries; emitting
    // one would blank a field that should inherit from __Standard values.
    const entries = buildItemEntries(
      item({
        sharedFields: [field("{A}", ""), field("{B}", "kept")],
      }),
    );
    const xml = textOf(entries[0]);
    expect(xml).toContain('tfid="{B}"');
    expect(xml).not.toContain('tfid="{A}"');
    expect(xml).not.toContain("<content></content>");
  });

  it("orders fields Versioned then Unversioned then Shared", () => {
    const entries = buildItemEntries(
      item({
        sharedFields: [field("{S}", "s", { sharing: "Shared" })],
        languages: [
          {
            language: "en",
            unversionedFields: [field("{U}", "u", { sharing: "Unversioned" })],
            versions: [{ version: 1, fields: [field("{V}", "v", { sharing: "Versioned" })] }],
          },
        ],
      }),
    );
    const order = [...textOf(entries[0]).matchAll(/tfid="\{(\w)\}"/g)].map((m) => m[1]);
    expect(order).toEqual(["V", "U", "S"]);
  });

  it("escapes attribute and content values", () => {
    const entries = buildItemEntries(
      item({ name: "R&D", sharedFields: [field("{A}", "a < b & c")] }),
    );
    const xml = textOf(entries[0]);
    expect(xml).toContain('name="R&amp;D"');
    expect(xml).toContain("<content>a &lt; b &amp; c</content>");
  });

  it("writes the item attributes in Sitecore's order, with key defaulting to the name", () => {
    const xml = textOf(buildItemEntries(item({ name: "Home Page" }))[0]);
    expect(xml.slice(0, 5)).toBe("<item");
    expect([...xml.matchAll(/ (\w+)="/g)].map((m) => m[1]).slice(0, 11)).toEqual([
      "name", "key", "id", "tid", "mid", "sortorder", "language", "version",
      "template", "parentid", "created",
    ]);
    expect(xml).toContain('key="home page"');
  });

  describe("casing and derived attributes (found in real generated output)", () => {
    it("lower-cases the field key, as Sitecore does", () => {
      // Real output writes `key="__updated"`, never `key="__Updated"` — but the Authoring
      // API answers with `__Updated`, so the writer has to fold it.
      const xml = textOf(
        buildItemEntries(item({ sharedFields: [field("{A}", "x", { name: "__Updated" })] }))[0],
      );
      expect(xml).toContain('key="__updated"');
      expect(xml).not.toContain('key="__Updated"');
    });

    it("lower-cases the template name", () => {
      // `template="headless tenant"` in the samples; `tid` is the authoritative reference.
      const xml = textOf(buildItemEntries(item({ templateName: "Folder" }))[0]);
      expect(xml).toContain('template="folder"');
    });

    it("derives created from __Created when the model has no attribute", () => {
      // Sitecore writes the RESOLVED value as an attribute, which is why it can be present
      // while the field is not. Generated items only have the field to go on.
      const xml = textOf(
        buildItemEntries(
          item({
            created: undefined,
            sharedFields: [field("{25BED78C-4957-4165-998A-CA1B52F67497}", "20260429T122057Z")],
          }),
        )[0],
      );
      expect(xml).toContain('created="20260429T122057Z"');
    });

    it("derives sortorder from __Sortorder when the model has no attribute", () => {
      const xml = textOf(
        buildItemEntries(
          item({
            sortorder: undefined,
            sharedFields: [field("{BA3F86A2-4A1C-4D78-B63D-91C2779C1B5E}", "300")],
          }),
        )[0],
      );
      expect(xml).toContain('sortorder="300"');
    });

    it("prefers the model's own attribute over the field, so a round-trip is unchanged", () => {
      const xml = textOf(
        buildItemEntries(
          item({
            created: "20200101T000000Z",
            sortorder: "100",
            sharedFields: [
              field("{25BED78C-4957-4165-998A-CA1B52F67497}", "20260429T122057Z"),
              field("{BA3F86A2-4A1C-4D78-B63D-91C2779C1B5E}", "300"),
            ],
          }),
        )[0],
      );
      expect(xml).toContain('created="20200101T000000Z"');
      expect(xml).toContain('sortorder="100"');
    });

    it("falls back to empty and zero when neither is available", () => {
      const xml = textOf(buildItemEntries(item({ created: undefined, sortorder: undefined }))[0]);
      expect(xml).toContain('created=""');
      expect(xml).toContain('sortorder="0"');
    });
  });

  it("emits bid only when a branch id is set", () => {
    expect(textOf(buildItemEntries(item())[0])).not.toContain(" bid=");
    expect(textOf(buildItemEntries(item({ branchId: "{BB}" }))[0])).toContain('bid="{BB}"');
  });

  it("falls back to the zero GUID for an unknown branch id", () => {
    expect(textOf(buildItemEntries(item())[0])).toContain(
      'mid="{00000000-0000-0000-0000-000000000000}"',
    );
  });

  describe("the properties side-car", () => {
    it("is UTF-8 with BOM, CRLF, and a trailing CRLF", () => {
      const bytes = serializeProperties(buildItemEntries(item())[0].properties);
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes.subarray(3));
      expect(text.endsWith("\r\n")).toBe(true);
      expect(text.split("\r\n")[0]).toBe("database=master");
    });

    it("repeats the __revision field value as revision=", () => {
      const rev = "{8CDC337E-A112-42FB-BBB4-4143751E123F}";
      const entries = buildItemEntries(
        item({
          languages: [
            {
              language: "en",
              unversionedFields: [],
              versions: [{ version: 1, fields: [field(rev, "abc-123")] }],
            },
          ],
        }),
      );
      expect(propsOf(entries[0])).toContain("revision=abc-123");
    });

    it("replays a preserved fieldproperties string verbatim", () => {
      // The real list covers the full inherited template closure — 129 tokens for an item
      // with 25 fields — so it can only be reproduced by keeping it.
      const preserved = "{X}:Shared|{Y}:Versioned|{Z}:Unversioned";
      const entries = buildItemEntries(item({ fieldProperties: preserved }));
      expect(propsOf(entries[0])).toContain("fieldproperties=" + preserved);
    });

    it("composes a subset from the fields present when none was preserved", () => {
      const entries = buildItemEntries(
        item({
          sharedFields: [field("{S}", "s", { sharing: "Shared" })],
          languages: [
            {
              language: "en",
              unversionedFields: [field("{U}", "u", { sharing: "Unversioned" })],
              versions: [{ version: 1, fields: [field("{V}", "v", { sharing: "Versioned" })] }],
            },
          ],
        }),
      );
      expect(propsOf(entries[0])).toContain(
        "fieldproperties={V}:Versioned|{U}:Unversioned|{S}:Shared",
      );
    });

    it("is identical across every language and version of one item", () => {
      const entries = buildItemEntries(
        item({
          sharedFields: [field("{S}", "s", { sharing: "Shared" })],
          languages: [
            { language: "en", unversionedFields: [], versions: [{ version: 1, fields: [] }] },
            { language: "da", unversionedFields: [], versions: [{ version: 1, fields: [] }] },
          ],
        }),
      );
      const fp = (i: number) => propsOf(entries[i]).match(/fieldproperties=.*/)![0];
      expect(fp(0)).toBe(fp(1));
    });
  });
});
