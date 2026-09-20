// The fetch half of generation, driven entirely by an injected request function.
//
// The GraphQL shape is unverified against a real tenant, so these tests deliberately do
// NOT pin selection strings. What they pin is the behaviour that must hold whatever the
// schema turns out to be: refuse rather than guess when something load-bearing is missing,
// never write an inherited or pre-escaped value, and keep the items that did resolve when
// one item in a batch fails.

import { describe, it, expect, beforeEach } from "vitest";
import type { ItemRef, StaticItemSource } from "../../core/model";
import type { PartialResult } from "../authoring";
import {
  ExportBlocked,
  exportSource,
  negotiateExport,
  realLanguage,
  resetExportCapabilities,
} from "../export";
import type { ExportOptions } from "../export";
import type { XmcContext } from "../client";
import type { TemplateInfo } from "../templates";

const ctx = {} as XmcContext;

const ref = (id: string, path: string): ItemRef => ({
  database: "master",
  path,
  id: "{" + id.padEnd(8, "0") + "-0000-0000-0000-000000000000}",
  language: "en",
  version: 1,
});

const field = (over: Record<string, unknown> = {}) => ({
  id: "{8CDC337E-A112-42FB-BBB4-4143751E123F}",
  name: "Title",
  value: "Hello",
  type: "Single-Line Text",
  containsStandardValue: false,
  shared: false,
  unversioned: false,
  ...over,
});

/** An item answer good enough to satisfy every capability probe. */
const answer = (over: Record<string, unknown> = {}) => ({
  itemId: "aaaaaaaa00000000000000000000000a",
  name: "Home",
  path: "/sitecore/content/Home",
  parent: { itemId: "bbbbbbbb00000000000000000000000b" },
  template: { templateId: "cccccccc00000000000000000000000c", name: "Sample" },
  fields: { nodes: [field()] },
  languages: [{ name: "en" }],
  versions: { nodes: [{ version: 1, fields: { nodes: [field()] } }] },
  children: { totalCount: 0, nodes: [] },
  ...over,
});

/**
 * A request function that answers probes and aliased item queries from one item shape.
 * `omit` removes keys from the answer, which is how a missing capability is simulated.
 */
function serving(item: Record<string, unknown>, omit: string[] = []) {
  const documents: string[] = [];
  const shaped = { ...item };
  for (const key of omit) delete shaped[key];

  const request = async <T,>(document: string): Promise<PartialResult<T>> => {
    documents.push(document);
    if (document.includes("ExportProbe")) {
      return { data: { item: shaped } as T, errors: [] };
    }
    // Aliased document: answer every alias with the same item.
    const aliases = [...document.matchAll(/^\s*(a\d+):/gm)].map((m) => m[1]);
    return {
      data: Object.fromEntries(aliases.map((a) => [a, shaped])) as T,
      errors: [],
    };
  };
  return { request, documents };
}

const source = (entries: ItemRef[]): StaticItemSource => ({
  kind: "items-static",
  uid: "u1",
  name: "Static",
  behaviour: { itemMode: "Undefined", itemMergeMode: "Undefined" },
  entries,
  skipVersions: false,
});

const run = (entries: ItemRef[], o: ExportOptions) => exportSource(ctx, source(entries), o);

beforeEach(() => resetExportCapabilities());

describe("negotiateExport", () => {
  it("probes each capability with its own document", () => {
    // One unknown field invalidates a whole query, so a combined probe could only say
    // that something, somewhere, was missing.
    const { request, documents } = serving(answer());
    return negotiateExport(ctx, ref("a", "/x"), { request }).then(() => {
      const probes = documents.filter((d) => d.includes("ExportProbe"));
      expect(probes.length).toBeGreaterThan(4);
      expect(probes.every((d) => d.includes("$itemId: ID"))).toBe(true);
    });
  });

  it("negotiates once and reuses the answer", async () => {
    const { request, documents } = serving(answer());
    await negotiateExport(ctx, ref("a", "/x"), { request });
    const after = documents.length;
    await negotiateExport(ctx, ref("b", "/y"), { request });
    // A walk must commit to one shape, or items come back classified inconsistently.
    expect(documents.length).toBe(after);
  });

  it("records a rejected probe as an unsupported capability", async () => {
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("versions")) throw new Error("Unknown field 'versions'");
      return { data: { item: answer() } as T, errors: [] };
    };
    const report = await negotiateExport(ctx, ref("a", "/x"), { request });
    expect(report.supported.has("versions")).toBe(false);
    expect(report.blocking.map((c) => c.id)).toContain("versions");
  });
});

describe("exportSource — refusing rather than guessing", () => {
  it("throws ExportBlocked naming what the endpoint would not supply", async () => {
    // No containsStandardValue anywhere: own-vs-inherited is undecidable, and a package
    // built anyway would install cleanly and be wrong.
    const { request } = serving(answer({ fields: { nodes: [field({ containsStandardValue: undefined })] } }));
    await expect(run([ref("a", "/sitecore/content/Home")], { request })).rejects.toThrow(
      ExportBlocked,
    );
    await expect(run([ref("a", "/sitecore/content/Home")], { request })).rejects.toThrow(
      /__Standard values/,
    );
  });

  it("does not block on a capability that is merely degraded", async () => {
    const { request } = serving(answer(), ["children"]);
    const out = await run([ref("a", "/sitecore/content/Home")], { request });
    expect(out.items.length).toBe(1);
  });

  it("makes no request at all for a source with no entries", async () => {
    const { request, documents } = serving(answer());
    const out = await run([], { request });
    expect(out.items).toEqual([]);
    expect(documents).toEqual([]);
  });
});

describe("exportSource — mapping", () => {
  const one = [ref("a", "/sitecore/content/Home")];

  it("keeps a field the item owns", async () => {
    const { request } = serving(answer());
    const out = await run(one, { request });
    expect(out.items[0].languages[0].versions[0].fields.map((f) => f.value)).toEqual(["Hello"]);
  });

  it("drops a field inherited from __Standard values", async () => {
    // Sitecore's own serializer omits these; writing the resolved value would bake the
    // default in and detach the item from its standard values on the target.
    const { request } = serving(
      answer({
        fields: { nodes: [field({ containsStandardValue: true })] },
        versions: { nodes: [{ version: 1, fields: { nodes: [field({ containsStandardValue: true })] } }] },
      }),
    );
    const out = await run(one, { request });
    expect(out.items[0].languages[0].versions[0].fields).toEqual([]);
  });

  it("drops an empty value instead of writing an empty <content>", async () => {
    const { request } = serving(
      answer({ versions: { nodes: [{ version: 1, fields: { nodes: [field({ value: "" })] } }] } }),
    );
    const out = await run(one, { request });
    expect(out.items[0].languages[0].versions[0].fields).toEqual([]);
  });

  it("refuses a value the endpoint already escaped, and says which field", async () => {
    // Escaping it again would ship an Image field that renders as literal text.
    const escaped = field({ name: "Image", value: '&lt;image mediaid="{F8B6426B}" /&gt;' });
    const { request } = serving(
      answer({ versions: { nodes: [{ version: 1, fields: { nodes: [escaped] } }] } }),
    );
    const out = await run(one, { request });
    expect(out.items[0].languages[0].versions[0].fields).toEqual([]);
    expect(out.problems.join(" ")).toContain("Image");
    expect(out.problems.join(" ")).toContain("already XML-escaped");
  });

  it("sorts fields into shared, unversioned and versioned buckets", async () => {
    const fields = [
      field({ id: "{11111111-1111-1111-1111-111111111111}", shared: true, value: "s" }),
      field({ id: "{22222222-2222-2222-2222-222222222222}", unversioned: true, value: "u" }),
      field({ id: "{33333333-3333-3333-3333-333333333333}", value: "v" }),
    ];
    const { request } = serving(
      answer({ versions: { nodes: [{ version: 1, fields: { nodes: fields } }] } }),
    );
    const out = await run(one, { request });
    const item = out.items[0];
    expect(item.sharedFields.map((f) => f.value)).toEqual(["s"]);
    expect(item.languages[0].unversionedFields.map((f) => f.value)).toEqual(["u"]);
    expect(item.languages[0].versions[0].fields.map((f) => f.value)).toEqual(["v"]);
  });

  it("falls back to the template catalog for sharing the item did not report", async () => {
    // The endpoint exposes no shared/unversioned on a field at all, so the probe reports
    // `fieldSharing` unsupported and the catalog is what decides the buckets.
    const bare = field({
      id: "{11111111-1111-1111-1111-111111111111}",
      shared: undefined,
      unversioned: undefined,
    });
    const { request } = serving(
      answer({
        fields: { nodes: [bare] },
        versions: { nodes: [{ version: 1, fields: { nodes: [bare] } }] },
      }),
    );
    const template = async (): Promise<TemplateInfo> => ({
      id: "{CCCCCCCC-0000-0000-0000-00000000000C}",
      fields: new Map([
        [
          "{11111111-1111-1111-1111-111111111111}",
          { id: "{11111111-1111-1111-1111-111111111111}", name: "T", sharing: "Shared" as const },
        ],
      ]),
    });
    const out = await run(one, { request, template });
    expect(out.items[0].sharedFields.map((f) => f.id)).toEqual([
      "{11111111-1111-1111-1111-111111111111}",
    ]);
  });

  it("takes the parent id from the API when it is offered", async () => {
    const { request } = serving(answer());
    const out = await run(one, { request });
    expect(out.items[0].parentId).toBe("{BBBBBBBB-0000-0000-0000-00000000000B}");
  });

  it("recovers a missing parent id by path from the other items in the package", async () => {
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) {
        return { data: { item: answer({ parent: undefined }) } as T, errors: [] };
      }
      const aliases = [...document.matchAll(/^\s*(a\d+):/gm)].map((m) => m[1]);
      const paths = ["/sitecore/content/Home", "/sitecore/content/Home/About"];
      const ids = ["aaaaaaaa00000000000000000000000a", "dddddddd00000000000000000000000d"];
      return {
        data: Object.fromEntries(
          aliases.map((a, i) => [
            a,
            answer({ parent: undefined, itemId: ids[i], path: paths[i] }),
          ]),
        ) as T,
        errors: [],
      };
    };
    const out = await run(
      [ref("a", "/sitecore/content/Home"), ref("d", "/sitecore/content/Home/About")],
      { request },
    );
    const child = out.items.find((i) => i.path.endsWith("/About"))!;
    expect(child.parentId).toBe("{AAAAAAAA-0000-0000-0000-00000000000A}");
  });

  it("says so when an item's parent is outside the package", async () => {
    const { request } = serving(answer({ parent: undefined }));
    const out = await run(one, { request });
    expect(out.items[0].parentId).toBe("");
    expect(out.problems.join(" ")).toContain("no position to install into");
  });
});

describe("language selection", () => {
  it("treats the definition's \"invariant\" as no language at all", () => {
    // `toItemRef` writes "invariant" because that is what an <x-item> entry carries. Sent
    // to GraphQL it earns "Culture is not supported … invariant is an invalid culture
    // identifier" once per item.
    expect(realLanguage("invariant")).toBeUndefined();
    expect(realLanguage("")).toBeUndefined();
    expect(realLanguage(undefined)).toBeUndefined();
    expect(realLanguage("en")).toBe("en");
    expect(realLanguage(" ja-JP ")).toBe("ja-JP");
  });

  it("asks in a real database language when the entries say invariant", async () => {
    const { request, documents } = serving(answer());
    await run([{ ...ref("a", "/x"), language: "invariant" }], {
      request,
      allLanguages: async () => ["da", "en"],
    });
    const fetches = documents.filter((d) => d.includes("ExportItems"));
    expect(fetches[0]).toContain('language: "da"');
    expect(fetches.join(" ")).not.toContain("invariant");
  });

  it("keeps a real language the entry already names", async () => {
    const { request, documents } = serving(answer());
    await run([{ ...ref("a", "/x"), language: "ja-JP" }], {
      request,
      allLanguages: async () => ["en"],
    });
    expect(documents.find((d) => d.includes("ExportItems"))).toContain('language: "ja-JP"');
  });

  it("skips a language whose version is only a fallback", async () => {
    // A fallback is not the item's own content; packaging it would create a real version
    // on the target where the source had none.
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: answer() } as T, errors: [] };
      const fallback = document.includes('language: "da"');
      return {
        data: { a0: answer({ isFallback: fallback }) } as T,
        errors: [],
      };
    };
    const out = await run([ref("a", "/x")], { request, allLanguages: async () => ["en", "da"] });
    expect(out.items[0].languages.map((l) => l.language)).toEqual(["en"]);
  });
});

describe("exportSource — batching and failure isolation", () => {
  it("aliases several items into one document", async () => {
    const { request, documents } = serving(answer());
    const refs = Array.from({ length: 6 }, (_, i) => ref(String(i), "/x/" + i));
    await run(refs, { request, batchSize: 3 });
    const fetches = documents.filter((d) => d.includes("ExportItems"));
    // Six items, three per batch — two documents, not six.
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches[0].match(/a\d+: item/g)?.length).toBe(3);
  });

  it("keeps the items that resolved when one in the batch errors", async () => {
    // With 25 items per document, throwing the batch away over one bad item would lose 24
    // good ones and fail identically on retry.
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: answer() } as T, errors: [] };
      return {
        data: { a0: answer(), a1: null } as T,
        errors: [{ message: "item a1 is not accessible" }],
      };
    };
    const out = await run([ref("a", "/x/a"), ref("b", "/x/b")], { request });
    expect(out.items.length).toBe(1);
    expect(out.problems.join(" ")).toContain("not accessible");
  });

  it("reports progress against the total", async () => {
    const { request } = serving(answer());
    const seen: number[] = [];
    await run(
      Array.from({ length: 4 }, (_, i) => ref(String(i), "/x/" + i)),
      { request, batchSize: 2, onProgress: (done, total) => seen.push(done / total) },
    );
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("stops between batches when aborted", async () => {
    const controller = new AbortController();
    const { request, documents } = serving(answer());
    const wrapped = async <T,>(d: string) => {
      if (d.includes("ExportItems")) controller.abort();
      return request<T>(d);
    };
    await expect(
      run(
        Array.from({ length: 10 }, (_, i) => ref(String(i), "/x/" + i)),
        { request: wrapped, batchSize: 2, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(documents.filter((d) => d.includes("ExportItems")).length).toBeLessThan(5);
  });
});
