// Schema introspection and the aliasing it feeds.
//
// This exists because guessing failed: the first version of fetchcaps.ts invented field
// names and a real tenant refused all three load-bearing capabilities at once. Asking the
// schema what it calls things turns that from a dead end into a lookup, and aliases keep
// every parser downstream reading one stable shape whatever the answer is.

import { describe, it, expect } from "vitest";
import type { PartialResult } from "../authoring";
import { describeShape, introspectSchema, pick } from "../introspect";
import type { SchemaShape } from "../introspect";
import { ASSUMED, CAPABILITIES, discover, itemSelection } from "../fetchcaps";
import type { CapabilityId } from "../fetchcaps";

/** A fake endpoint whose type graph is described by a plain object. */
function schemaServing(types: Record<string, Record<string, string | undefined>>) {
  const asked: string[] = [];
  const request = async <T,>(document: string): Promise<PartialResult<T>> => {
    if (document.includes("__schema")) {
      return { data: { __schema: { queryType: { name: "Query" } } } as T, errors: [] };
    }
    const name = document.match(/__type\(name: "([^"]+)"\)/)?.[1] ?? "";
    asked.push(name);
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
  return { request, asked };
}

/** A tenant whose spellings differ from the conventional ones in every interesting way. */
const UNCONVENTIONAL = {
  Query: { item: "ContentItem" },
  ContentItem: {
    itemId: "ID",
    name: "String",
    fields: "FieldConnection",
    versions: "VersionConnection",
    parentItem: "ContentItem",
    languages: "LanguageList",
  },
  FieldConnection: { nodes: "ContentField", totalCount: "Int" },
  VersionConnection: { nodes: "ContentItem" },
  ContentField: {
    templateFieldId: "ID",
    name: "String",
    value: "String",
    fieldType: "String",
    isStandardValue: "Boolean",
    isShared: "Boolean",
  },
};

describe("introspectSchema", () => {
  it("walks from the query root to the item and field types", async () => {
    const { request } = schemaServing(UNCONVENTIONAL);
    const schema = (await introspectSchema(request))!;
    expect(schema.item.name).toBe("ContentItem");
    expect(schema.field?.name).toBe("ContentField");
    expect(schema.fieldsAreConnection).toBe(true);
  });

  it("unwraps NonNull and List wrappers to reach the named type", async () => {
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("__schema")) {
        return { data: { __schema: { queryType: { name: "Query" } } } as T, errors: [] };
      }
      const name = document.match(/__type\(name: "([^"]+)"\)/)?.[1];
      if (name === "Query") {
        return {
          data: {
            __type: {
              name,
              fields: [
                {
                  name: "item",
                  // NonNull(List(NonNull(Item)))
                  type: {
                    kind: "NON_NULL",
                    ofType: { kind: "LIST", ofType: { kind: "NON_NULL", ofType: { name: "Item" } } },
                  },
                },
              ],
            },
          } as T,
          errors: [],
        };
      }
      return { data: { __type: { name, fields: [{ name: "itemId", type: { name: "ID" } }] } } as T, errors: [] };
    };
    const schema = await introspectSchema(request);
    expect(schema?.item.name).toBe("Item");
  });

  it("gives up rather than inventing a shape when introspection is disabled", async () => {
    const request = async <T,>(): Promise<PartialResult<T>> => ({ data: {} as T, errors: [] });
    expect(await introspectSchema(request)).toBeUndefined();
  });

  it("handles a fields list that is not a connection", async () => {
    const { request } = schemaServing({
      Query: { item: "Item" },
      Item: { fields: "ItemField" },
      ItemField: { id: "ID", name: "String", value: "String" },
    });
    const schema = (await introspectSchema(request))!;
    expect(schema.fieldsAreConnection).toBe(false);
    expect(schema.field?.name).toBe("ItemField");
  });
});

describe("pick", () => {
  const shape = { name: "F", fields: new Map([["TemplateFieldId", "ID"]]) };

  it("prefers the first candidate the schema actually has", () => {
    expect(pick({ name: "F", fields: new Map([["id", "ID"], ["fieldId", "ID"]]) }, ["id", "fieldId"])).toBe("id");
  });

  it("matches case-insensitively, since schemas differ on casing more than wording", () => {
    expect(pick(shape, ["templateFieldId"])).toBe("TemplateFieldId");
  });

  it("returns undefined rather than a guess", () => {
    expect(pick(shape, ["containsStandardValue"])).toBeUndefined();
  });
});

describe("discover + itemSelection", () => {
  it("aliases the tenant's names to the ones the parsers read", async () => {
    const { request } = schemaServing(UNCONVENTIONAL);
    const d = discover((await introspectSchema(request))!);
    const all = new Set<CapabilityId>(CAPABILITIES.map((c) => c.id));
    const selection = itemSelection(all, d);

    // Every downstream parser keeps reading `id`, `value`, `containsStandardValue`…
    expect(selection).toContain("id: templateFieldId");
    expect(selection).toContain("containsStandardValue: isStandardValue");
    expect(selection).toContain("shared: isShared");
    expect(selection).toContain("type: fieldType");
    expect(selection).toContain("parent: parentItem");
  });

  it("does not alias a name that already matches", async () => {
    const { request } = schemaServing({
      Query: { item: "Item" },
      Item: { fields: "FC", versions: "VC" },
      FC: { nodes: "IF" },
      VC: { nodes: "Item" },
      IF: { id: "ID", name: "String", value: "String" },
    });
    const d = discover((await introspectSchema(request))!);
    const selection = itemSelection(new Set<CapabilityId>(["fieldId"]), d);
    expect(selection).toContain("id ");
    expect(selection).not.toContain("id: id");
  });

  it("omits a capability the schema has no name for", async () => {
    const { request } = schemaServing({
      Query: { item: "Item" },
      Item: { fields: "FC" },
      FC: { nodes: "IF" },
      IF: { id: "ID", name: "String", value: "String" },
    });
    const d = discover((await introspectSchema(request))!);
    const selection = itemSelection(new Set<CapabilityId>(CAPABILITIES.map((c) => c.id)), d);
    expect(selection).not.toContain("versions");
    expect(selection).not.toContain("parent");
  });

  it("produces no probe document for a capability this schema cannot express", async () => {
    const { request } = schemaServing({
      Query: { item: "Item" },
      Item: { fields: "FC" },
      FC: { nodes: "IF" },
      IF: { id: "ID", name: "String", value: "String" },
    });
    const d = discover((await introspectSchema(request))!);
    // A definite no — there is nothing to ask, so no request should be spent asking.
    expect(CAPABILITIES.find((c) => c.id === "ownValues")!.selection(d)).toBeUndefined();
    expect(CAPABILITIES.find((c) => c.id === "fieldId")!.selection(d)).toBeDefined();
  });

  it("falls back to conventional spellings when introspection is unavailable", () => {
    const selection = itemSelection(new Set<CapabilityId>(["fieldId", "ownValues"]), ASSUMED);
    expect(selection).toContain("fields {");
    expect(selection).toContain("containsStandardValue");
  });
});

describe("describeShape", () => {
  it("lists what a type offers, for telling the user what IS available", () => {
    const shape: SchemaShape["item"] = {
      name: "ContentItem",
      fields: new Map([["itemId", "ID"], ["fields", "FC"]]),
    };
    expect(describeShape(shape)).toBe("ContentItem: itemId, fields");
  });

  it("truncates a long list and says how many there were", () => {
    const fields = new Map(Array.from({ length: 60 }, (_, i) => ["f" + i, "String"]));
    expect(describeShape({ name: "T", fields }, 5)).toContain("(60 total)");
  });

  it("says plainly when nothing was discovered", () => {
    expect(describeShape(undefined)).toBe("(not discovered)");
  });
});
