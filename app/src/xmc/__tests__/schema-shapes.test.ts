// Pinned against a REAL XM Cloud Authoring schema, read out of a live tenant by
// introspection (2026-09-19). Everything else about the fetch path is negotiated, but this
// is the one shape we have actually seen, so it gets a regression test.
//
// The two things it proves, both of which had already gone wrong once:
//
//  1. `Item.fields` is a CONNECTION (`{ nodes }`) while `Item.versions` is a plain LIST, in
//     the same schema. A GraphQL alias can rename a field but cannot reshape one, so the
//     parser has to accept both — assuming `nodes` everywhere is what made the versions
//     probe fail while the field probes passed.
//  2. `ItemField` carries no type and no sharing flags; it has a `templateField` instead.
//     Selecting `type` straight off the field node would be rejected outright.
//
// The Item and ItemField listings below are verbatim from the tenant. TemplateField's
// contents were not shown and are assumed — see the note on that constant.

import { describe, it, expect } from "vitest";
import type { PartialResult } from "../authoring";
import { introspectSchema } from "../introspect";
import {
  CAPABILITIES,
  discover,
  itemSelection,
  listOf,
  sharingOfField,
  typeOfField,
} from "../fetchcaps";
import type { CapabilityId } from "../fetchcaps";

/** The field lists the live tenant reported, verbatim. */
const ITEM_FIELDS = [
  "access", "ancestors", "children", "database", "displayName", "field", "fields",
  "hasChildren", "hasPresentation", "icon", "insertOptions", "isFallback", "itemId",
  "itemUri", "language", "lock", "name", "parent", "path", "publish", "template",
  "thumbnailUrl", "url", "version", "versionName", "versions", "workflow",
];

const ITEM_FIELD_FIELDS = [
  "access", "containsFallbackValue", "containsInheritedValue", "containsStandardValue",
  "fieldId", "label", "name", "templateField", "validation", "value",
];

// NOT observed — the tenant listing covered Item and ItemField only. These are the names
// we hope TemplateField carries; if it does not, `fieldType` and `fieldSharing` simply come
// back unsupported (neither blocks) and the template catalog answers instead.
const TEMPLATE_FIELD_FIELDS = ["templateFieldId", "name", "type", "shared", "unversioned"];

/** Reproduces the live tenant's type graph. */
function liveTenant() {
  const types: Record<string, Record<string, string>> = {
    Query: { item: "Item" },
    Item: Object.fromEntries(
      ITEM_FIELDS.map((f) => [
        f,
        f === "fields" ? "ItemSearchResults" : f === "versions" ? "Item" : f === "children" ? "ItemSearchResults" : "String",
      ]),
    ),
    // `fields` is a connection…
    ItemSearchResults: { nodes: "ItemField", totalCount: "Int" },
    ItemField: Object.fromEntries(
      ITEM_FIELD_FIELDS.map((f) => [f, f === "templateField" ? "TemplateField" : "String"]),
    ),
    TemplateField: Object.fromEntries(TEMPLATE_FIELD_FIELDS.map((f) => [f, "String"])),
  };

  const request = async <T,>(document: string): Promise<PartialResult<T>> => {
    if (document.includes("__schema")) {
      return { data: { __schema: { queryType: { name: "Query" } } } as T, errors: [] };
    }
    const name = document.match(/__type\(name: "([^"]+)"\)/)?.[1] ?? "";
    const fields = types[name];
    if (!fields) return { data: { __type: null } as T, errors: [] };
    return {
      data: {
        __type: {
          name,
          fields: Object.entries(fields).map(([f, t]) => ({ name: f, type: { name: t } })),
        },
      } as T,
      errors: [],
    };
  };
  return request;
}

const ALL = new Set<CapabilityId>(CAPABILITIES.map((c) => c.id));

describe("the live XM Cloud Authoring schema", () => {
  it("resolves the item and field types by walking from the query root", async () => {
    const schema = (await introspectSchema(liveTenant()))!;
    expect(schema.item.name).toBe("Item");
    expect(schema.field?.name).toBe("ItemField");
    expect(schema.templateField?.name).toBe("TemplateField");
  });

  it("sees fields as a connection but versions as a plain list", async () => {
    // The exact mix that broke the first attempt.
    const schema = (await introspectSchema(liveTenant()))!;
    expect(schema.fieldsAreConnection).toBe(true);
    expect(schema.versionsAreConnection).toBe(false);
  });

  it("finds the field GUID under fieldId, not id", async () => {
    const d = discover((await introspectSchema(liveTenant()))!);
    expect(d.fieldId).toBe("fieldId");
    expect(itemSelection(ALL, d)).toContain("id: fieldId");
  });

  it("finds containsStandardValue, so own-vs-inherited is decidable", async () => {
    const d = discover((await introspectSchema(liveTenant()))!);
    expect(d.ownValue).toBe("containsStandardValue");
  });

  it("asks for versions without a nodes wrapper", async () => {
    const d = discover((await introspectSchema(liveTenant()))!);
    const selection = CAPABILITIES.find((c) => c.id === "versions")!.selection(d)!;
    expect(selection).toBe("versions { version }");
    expect(selection).not.toContain("nodes");
  });

  it("reaches field type and sharing through templateField", async () => {
    // ItemField itself has neither, so selecting `type` on it would be rejected.
    const d = discover((await introspectSchema(liveTenant()))!);
    expect(d.fieldType).toBeUndefined();
    expect(d.tfType).toBe("type");
    const selection = itemSelection(ALL, d);
    expect(selection).toContain("templateField {");
    expect(selection).toContain("type");
    expect(selection).toContain("shared");
  });

  it("cannot ask an item which languages it has — there is no `languages` field", async () => {
    // Item exposes `language` (the one the query asked for) but no list, so the languages
    // to try have to come from the database instead. Everything else is expressible.
    const d = discover((await introspectSchema(liveTenant()))!);
    expect(d.languages).toBeUndefined();
    const unsupported = CAPABILITIES.filter((c) => c.selection(d) === undefined);
    expect(unsupported.map((c) => c.id)).toEqual(["languages"]);
  });

  it("can tell a real language version from a fallback", async () => {
    // Packaging a fallback would create a real version on the target where none existed.
    const d = discover((await introspectSchema(liveTenant()))!);
    expect(d.fallback).toBe("isFallback");
    expect(itemSelection(ALL, d)).toContain("isFallback");
  });
});

describe("parsing what this schema returns", () => {
  it("reads a versions LIST and a fields CONNECTION from the same item", () => {
    const item = {
      versions: [{ version: 1 }, { version: 2 }],
      fields: { nodes: [{ fieldId: "x" }] },
    };
    expect(listOf(item.versions).map((v) => v.version)).toEqual([1, 2]);
    expect(listOf(item.fields).length).toBe(1);
  });

  it("satisfies the versions capability from a list response", () => {
    // The assertion that failed before: the query was right, the parse was not.
    const versions = CAPABILITIES.find((c) => c.id === "versions")!;
    expect(versions.assert({ versions: [{ version: 1 }] })).toBe(true);
    expect(versions.assert({ versions: { nodes: [{ version: 1 }] } })).toBe(true);
    expect(versions.assert({ versions: [] })).toBe(false);
  });

  it("reads type and sharing off templateField", () => {
    const field = { templateField: { type: "Single-Line Text", shared: true } };
    expect(typeOfField(field)).toBe("Single-Line Text");
    expect(sharingOfField(field)).toBe("Shared");
  });

  it("prefers a flag on the field node over its definition", () => {
    expect(sharingOfField({ shared: false, templateField: { shared: true } })).toBe("Versioned");
  });

  it("reports unknown sharing as undefined rather than defaulting to Versioned", () => {
    // Defaulting here would quietly write a Shared field once per version.
    expect(sharingOfField({})).toBeUndefined();
    expect(sharingOfField({ templateField: null })).toBeUndefined();
  });

  it("treats unversioned as Unversioned only when not shared", () => {
    expect(sharingOfField({ unversioned: true })).toBe("Unversioned");
    expect(sharingOfField({ shared: true, unversioned: true })).toBe("Shared");
  });
});
