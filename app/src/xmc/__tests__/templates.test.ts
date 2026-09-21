// The template catalog: what falls back to the template when the item cannot say.
//
// Like the capability ladder, the selections here are unverified against a real schema, so
// these tests pin the negotiation BEHAVIOUR rather than any document: a shape that throws
// is skipped, a shape that validates but answers with nothing is also skipped, and whatever
// wins is committed to for the session so fields are never classified two different ways.

import { describe, it, expect, beforeEach } from "vitest";
import { AuthoringError } from "../authoring";
import { getTemplate, resetTemplateCatalog } from "../templates";
import type { XmcContext } from "../client";

const ctx = {} as XmcContext;
const TEMPLATE = "{CCCCCCCC-0000-0000-0000-00000000000C}";

/** Records the documents tried, and answers according to the shapes the tenant "has". */
function tenant(options: {
  rejects?: (document: string) => boolean;
  emptyFor?: (document: string) => boolean;
  shape?: "flags" | "standard-fields" | "versioning";
}) {
  const tried: string[] = [];
  const flagged = {
    templateFieldId: "11111111111111111111111111111111",
    name: "Title",
    type: "Single-Line Text",
    shared: true,
    unversioned: false,
  };
  // How the live Authoring schema states it: one enum on the template field, no booleans.
  const versioned = {
    templateFieldId: "11111111111111111111111111111111",
    name: "Title",
    type: "Single-Line Text",
    versioning: "SHARED",
  };
  const standard = {
    templateFieldId: "11111111111111111111111111111111",
    name: "Title",
    fields: {
      nodes: [
        { name: "__Shared", value: "1" },
        { name: "__Unversioned", value: "" },
        { name: "Type", value: "Single-Line Text" },
      ],
    },
  };

  const fetch = async (document: string) => {
    tried.push(document);
    if (options.rejects?.(document)) throw new AuthoringError("Unknown field", []);
    if (options.emptyFor?.(document)) return { templateId: TEMPLATE, fields: { nodes: [] } };
    const node =
      options.shape === "standard-fields"
        ? standard
        : options.shape === "versioning"
          ? versioned
          : flagged;
    return { templateId: TEMPLATE, name: "Sample", fields: { nodes: [node] } };
  };
  return { fetch, tried };
}

beforeEach(() => resetTemplateCatalog());

describe("getTemplate", () => {
  it("reads sharing and type from field flags when the schema has them", async () => {
    const { fetch } = tenant({});
    const info = await getTemplate(ctx, TEMPLATE, { fetch });
    const field = info!.fields.get("{11111111-1111-1111-1111-111111111111}")!;
    expect(field.sharing).toBe("Shared");
    expect(field.type).toBe("Single-Line Text");
  });

  it("reads sharing from the versioning enum, which is what this schema actually has", async () => {
    // `ItemTemplateField` has no shared/unversioned pair — only `versioning`. Knowing just
    // the booleans, the catalog answered nothing and every field defaulted to Versioned,
    // which silently mis-sorted every unversioned media field.
    const { fetch, tried } = tenant({ shape: "versioning" });
    const info = await getTemplate(ctx, TEMPLATE, { fetch });
    expect(info!.fields.get("{11111111-1111-1111-1111-111111111111}")!.sharing).toBe("Shared");
    expect(tried).toHaveLength(1);
  });

  it("asks for every field of a template, not the endpoint's default page", async () => {
    // `ItemTemplate.fields` is paginated and defaults to 50 here; a bigger template would
    // come back silently short and its extra fields would have no known sharing.
    const { fetch, tried } = tenant({});
    await getTemplate(ctx, TEMPLATE, { fetch });
    expect(tried[0]).toMatch(/fields\(first: \d{3,}\)/);
  });

  it("keys fields by id, because names repeat across an inheritance chain", async () => {
    const { fetch } = tenant({});
    const info = await getTemplate(ctx, TEMPLATE, { fetch });
    expect([...info!.fields.keys()]).toEqual(["{11111111-1111-1111-1111-111111111111}"]);
  });

  it("falls back to reading __Shared off the field item itself", async () => {
    // A template field IS an item, so its own standard fields answer the question using
    // only the fields(names: […]) mechanism already proven to work.
    const { fetch, tried } = tenant({
      rejects: (d) => d.includes("shared unversioned") || d.includes("type versioning"),
      shape: "standard-fields",
    });
    const info = await getTemplate(ctx, TEMPLATE, { fetch });
    expect(info!.fields.get("{11111111-1111-1111-1111-111111111111}")!.sharing).toBe("Shared");
    expect(tried.length).toBeGreaterThan(1);
  });

  it("skips a shape that VALIDATES but answers with no fields", async () => {
    // The trap from resolve.ts: succeeding is not the same as answering.
    const { fetch, tried } = tenant({
      emptyFor: (d) => d.includes("type versioning") || d.includes("shared unversioned"),
      shape: "standard-fields",
    });
    const info = await getTemplate(ctx, TEMPLATE, { fetch });
    expect(info).toBeDefined();
    expect(tried.length).toBeGreaterThan(1);
  });

  it("returns undefined when no shape can answer, rather than inventing sharing", async () => {
    const { fetch } = tenant({ rejects: () => true });
    expect(await getTemplate(ctx, TEMPLATE, { fetch })).toBeUndefined();
  });

  it("stops asking once every shape has been refused", async () => {
    const { fetch, tried } = tenant({ rejects: () => true });
    await getTemplate(ctx, TEMPLATE, { fetch });
    const after = tried.length;
    await getTemplate(ctx, "{DDDDDDDD-0000-0000-0000-00000000000D}", { fetch });
    expect(tried.length).toBe(after);
  });

  it("commits to the shape that worked and reuses it for other templates", async () => {
    const { fetch, tried } = tenant({
      rejects: (d) => d.includes("shared unversioned"),
      shape: "standard-fields",
    });
    await getTemplate(ctx, TEMPLATE, { fetch });
    const negotiating = tried.length;
    await getTemplate(ctx, "{DDDDDDDD-0000-0000-0000-00000000000D}", { fetch });
    // One request for the second template, not another walk down the ladder.
    expect(tried.length).toBe(negotiating + 1);
  });

  it("caches each template, so an item-heavy package pays once per template", async () => {
    const { fetch, tried } = tenant({});
    await getTemplate(ctx, TEMPLATE, { fetch });
    await getTemplate(ctx, TEMPLATE, { fetch });
    expect(tried.length).toBe(1);
  });

  it("sends bare GUIDs, as the API expects", async () => {
    let seen: string | undefined;
    await getTemplate(ctx, TEMPLATE, {
      fetch: async (_d, id) => {
        seen = id;
        return { templateId: TEMPLATE, fields: { nodes: [] } };
      },
    });
    // The catalog normalises to braced form for its own keys; the request path strips them.
    expect(seen).toBe(TEMPLATE);
  });
});
