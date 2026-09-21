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

  it("recovers an item the endpoint threw on, by dropping the selection it threw on", async () => {
    // Measured against a live tenant: asking a media item for `isFallback` makes the
    // Authoring API throw, and because the error propagates to the nearest nullable parent
    // the WHOLE item comes back null — every field of it lost over one boolean.
    const documents: string[] = [];
    // The capability only reaches the selection when the probe proves the endpoint answers
    // it, so the sample has to carry isFallback for this scenario to exist at all.
    const sample = answer({ isFallback: false });
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: sample } as T, errors: [] };
      documents.push(document);
      if (document.includes("isFallback")) {
        return {
          data: { a0: sample, a1: null } as T,
          errors: [
            {
              message: "Object reference not set to an instance of an object.",
              path: ["a1", "isFallback"],
            },
          ],
        };
      }
      // The retry, without isFallback: the item reads perfectly well.
      return { data: { a0: answer({ path: "/media/test" }) } as T, errors: [] };
    };

    const out = await run([ref("a", "/x/a"), ref("b", "/media/test")], { request });

    expect(out.items.length).toBe(2);
    // No caveat: this run packaged one language, and the fallback flag is only ever read
    // for the EXTRA ones. Nothing was lost, so nothing is claimed to have been.
    expect(out.problems.filter((p) => p.includes("read without"))).toEqual([]);
    // Only the failed item is asked for again, not the whole batch.
    const retried = documents.filter(
      (d) => d.includes("ExportItems") && !d.includes("isFallback"),
    );
    expect(retried.length).toBe(1);
    expect(retried[0].match(/a\d+: item/g)?.length).toBe(1);
  });

  it("says nothing about a lost flag that this run was never going to read", async () => {
    // `isFallback` is consulted only in the extra-language pass. A single-language export
    // that loses it has lost nothing, and a caveat there is the kind of noise that trains
    // people to skim past the real ones.
    const sample = answer({ isFallback: false });
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: sample } as T, errors: [] };
      if (document.includes("isFallback")) {
        return {
          data: { a0: null } as T,
          errors: [{ message: "boom", path: ["a0", "isFallback"] }],
        };
      }
      return { data: { a0: sample } as T, errors: [] };
    };

    const out = await run([ref("a", "/sitecore/templates/Project")], { request });
    expect(out.items).toHaveLength(1);
    expect(out.problems.filter((p) => p.includes("read without"))).toEqual([]);
  });

  it("groups one structural failure into one caveat, however many items it hit", async () => {
    // `Item.isFallback` resolves through `FindSiteForItem()`, which returns null for any
    // path no site covers — so every item under /sitecore/templates throws, always. A
    // template folder used to produce one identically-worded sentence per item.
    const sample = answer({ isFallback: false, languages: [{ name: "en" }, { name: "en-CA" }] });
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: sample } as T, errors: [] };
      const aliases = [...document.matchAll(/^\s*(a\d+):/gm)].map((m) => m[1]);
      if (document.includes("isFallback")) {
        return {
          data: {} as T,
          errors: aliases.map((a) => ({ message: "boom", path: [a, "isFallback"] })),
        };
      }
      return { data: Object.fromEntries(aliases.map((a) => [a, sample])) as T, errors: [] };
    };

    const refs = Array.from({ length: 18 }, (_, i) =>
      ref(String(i), "/sitecore/templates/Project/t" + i),
    );
    const out = await run(refs, { request });

    const caveats = out.problems.filter((p) => p.includes("read without"));
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain("18 items");
    // A few paths named, the rest counted — enough to recognise the region, short enough
    // to read.
    expect(caveats[0]).toContain("/sitecore/templates/Project/t0");
    expect(caveats[0]).toContain("and 15 more");
    expect(caveats[0]).toContain("en-CA");
  });

  it("reports one caveat per degraded item, not one per language", async () => {
    // The endpoint throws in every language it is asked for, so the per-language form said
    // the same sentence three times and read like three distinct faults.
    const sample = answer({ isFallback: false, languages: [{ name: "en" }, { name: "en-CA" }] });
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: sample } as T, errors: [] };
      if (document.includes("isFallback")) {
        return {
          data: { a0: null } as T,
          errors: [{ message: "boom", path: ["a0", "isFallback"] }],
        };
      }
      return { data: { a0: sample } as T, errors: [] };
    };

    const out = await run([ref("a", "/media/test")], { request });
    const caveats = out.problems.filter((p) => p.includes("read without"));
    expect(caveats.length).toBe(1);
    // What varies between languages is only the language list, so that is what is listed.
    expect(caveats[0]).toContain("en");
    expect(caveats[0]).toContain("en-CA");
  });

  it("does not retry when the error names a selection that cannot be given up", async () => {
    // Dropping `versions` would produce a package worth nothing, so a throw there is
    // reported as a failure rather than worked around.
    const documents: string[] = [];
    const sample = answer({ isFallback: false });
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: sample } as T, errors: [] };
      if (document.includes("ExportItems")) documents.push(document);
      return {
        data: { a0: null } as T,
        errors: [{ message: "boom", path: ["a0", "versions"] }],
      };
    };
    const out = await run([ref("a", "/x/a")], { request });
    expect(out.items.length).toBe(0);
    expect(out.problems.join(" ")).toContain("boom");
    expect(documents.length).toBe(1);
  });

  it("reports the original failure when the retry cannot save the item either", async () => {
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) {
        return { data: { item: answer({ isFallback: false }) } as T, errors: [] };
      }
      if (document.includes("isFallback")) {
        return {
          data: { a0: null } as T,
          errors: [{ message: "first failure", path: ["a0", "isFallback"] }],
        };
      }
      return { data: { a0: null } as T, errors: [{ message: "still broken", path: ["a0"] }] };
    };
    const out = await run([ref("a", "/x/a")], { request });
    expect(out.problems.join(" ")).toContain("still broken");
    expect(out.problems.join(" ")).toContain("could not be read");
  });

  it("names the item and the field a server error came from", async () => {
    // A bare "Object reference not set to an instance of an object." names neither, and is
    // what a media item actually produced against a live tenant. The alias and the rest of
    // the GraphQL path are the only record of where the server threw.
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: answer() } as T, errors: [] };
      return {
        data: { a0: answer(), a1: null } as T,
        errors: [
          {
            message: "Object reference not set to an instance of an object.",
            path: ["a1", "versions", "nodes", 0, "fields", "nodes", 2, "value"],
          },
        ],
      };
    };
    const out = await run(
      [ref("a", "/sitecore/content/Home"), ref("b", "/sitecore/media library/Project/test")],
      { request },
    );
    const reported = out.problems.join(" | ");
    expect(reported).toContain("/sitecore/media library/Project/test");
    expect(reported).toContain("Object reference not set");
    expect(reported).toContain("versions.nodes.0.fields.nodes.2.value");
    // The alias is batching bookkeeping, not something a user can act on, so it is
    // stripped rather than passed through into the message.
    expect(reported).not.toContain("(at a1");
  });

  it("says which language a failure came from", async () => {
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: answer() } as T, errors: [] };
      return {
        data: { a0: answer() } as T,
        errors: [{ message: "boom", path: ["a0"] }],
      };
    };
    const out = await run([ref("a", "/x/a")], { request });
    expect(out.problems.join(" ")).toContain("[en]");
  });

  it("still reports an error the server did not attribute to an alias", async () => {
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: answer() } as T, errors: [] };
      return { data: { a0: null } as T, errors: [{ message: "something broke" }] };
    };
    const out = await run([ref("a", "/x/a")], { request });
    // Unattributable is not the same as unreportable — dropping it would hide the cause.
    expect(out.problems.join(" ")).toContain("something broke");
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

  it("says so when the endpoint returned fewer fields than it says the item has", async () => {
    // A connection answers ONE PAGE — 50 by default on this endpoint. An item whose field
    // closure is bigger comes back as a silent prefix, and the package installs cleanly
    // with content missing. This is the one failure mode a package cannot be checked for
    // after the fact, so it has to be reported while it happens.
    const truncated = answer({
      versions: { nodes: [{ version: 1, fields: { nodes: [field()], totalCount: 97 } }] },
    });
    const { request } = serving(truncated);
    const out = await run([ref("a", "/sitecore/content/Home")], { request });
    expect(out.problems.join(" ")).toMatch(/returned 1 of 97 fields/);
    // Reported, not refused: a partial item still beats no package at all.
    expect(out.items).toHaveLength(1);
  });

  it("says nothing when the page held everything", async () => {
    const whole = answer({
      versions: { nodes: [{ version: 1, fields: { nodes: [field()], totalCount: 1 } }] },
    });
    const out = await run([ref("a", "/sitecore/content/Home")], { request: serving(whole).request });
    expect(out.problems.join(" ")).not.toMatch(/fields/);
  });

  it("halves a batch the transport dropped, and keeps every item", async () => {
    // Measured as net::ERR_QUIC_PROTOCOL_ERROR surfacing through the SDK as "Failed to
    // fetch": the request never completes, so there is no `errors` array to read and no
    // path naming an item. Asking for fewer items per request is the only lever.
    const sample = answer();
    let refused = 0;
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: sample } as T, errors: [] };
      const aliases = [...document.matchAll(/^\s*(a\d+):/gm)].map((m) => m[1]);
      if (aliases.length > 2) {
        refused++;
        throw new Error("Failed to fetch");
      }
      return {
        data: Object.fromEntries(
          aliases.map((a, i) => [a, answer({ path: "/x/" + a + i })]),
        ) as T,
        errors: [],
      };
    };

    const refs = Array.from({ length: 8 }, (_, i) => ref(String(i), "/x/" + i));
    const out = await run(refs, { request, batchSize: 8 });

    expect(refused).toBeGreaterThan(0);
    expect(out.items).toHaveLength(8);
    expect(out.problems).toEqual([]);
  });

  it("re-keys the aliases of each half against the original batch", async () => {
    // Each half answers with `a0…` against its OWN array, so the right half's `a0` is the
    // parent's `a4`. Merging without re-keying reads every item after the split as the
    // wrong item — and the package would install content under the wrong paths.
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) {
        return { data: { item: answer() } as T, errors: [] };
      }
      const aliases = [...document.matchAll(/^\s*(a\d+): item\(where: \{ itemId: "([^"]+)"/gm)];
      if (aliases.length > 1) throw new Error("Failed to fetch");
      // One item per request now: answer with a path derived from the id it was asked for,
      // so a mis-keyed merge cannot go unnoticed.
      const [, alias, itemId] = aliases[0];
      // `aliasedDocument` strips the braces, so the ref's first character is its index.
      return {
        data: { [alias]: answer({ path: "/x/" + itemId[0], itemId }) } as T,
        errors: [],
      };
    };

    const refs = Array.from({ length: 4 }, (_, i) => ref(String(i), "/x/" + i));
    const out = await run(refs, { request, batchSize: 4 });
    expect(out.items.map((i) => i.path)).toEqual(["/x/0", "/x/1", "/x/2", "/x/3"]);
  });

  it("reports the one item it still cannot fetch rather than losing the package", async () => {
    const sample = answer();
    const request = async <T,>(document: string): Promise<PartialResult<T>> => {
      if (document.includes("ExportProbe")) return { data: { item: sample } as T, errors: [] };
      const aliases = [...document.matchAll(/^\s*(a\d+): item\(where: \{ itemId: "([^"]+)"/gm)];
      if (aliases.some(([, , id]) => id.startsWith("b"))) throw new Error("Failed to fetch");
      return {
        data: Object.fromEntries(
          aliases.map(([, a, itemId]) => [a, answer({ itemId, path: "/x/a" })]),
        ) as T,
        errors: [],
      };
    };

    const out = await run([ref("a", "/x/a"), ref("b", "/x/b")], { request, batchSize: 2 });
    expect(out.items).toHaveLength(1);
    expect(out.problems.join(" ")).toMatch(/\/x\/b \[en\]: the request failed — Failed to fetch/);
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
