// Turning a source definition into the entries it actually contributes.
//
// Two things here are easy to get wrong and expensive when wrong. The first is the
// negotiation: an Authoring endpoint that does not know a *schema* field rejects the query
// outright, but one that does not know a *Sitecore field name* answers cheerfully with
// nothing — so "the request succeeded" proves nothing about whether the date filters can
// be applied. The second is what the walk does with the database: the previous per-level
// fetch dropped it, which would have walked `master` for a source pointed at `web`.

import { describe, it, expect, beforeEach } from "vitest";
import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import { resetPreviewSelection, resolveDefinition, resolveSource } from "../resolve";
import type { XmcContext } from "../client";
import { emptyDefinition } from "@/src/core/definition";
import type { DynamicItemSource, PackageDefinition, StaticItemSource } from "@/src/core/model";
import { ASK_USER } from "@/src/core/model";

const TEMPLATE = "a6c086ad96514912bc60512ca5417795";

/** What the probe finds, which decides how far the ladder falls. */
interface TenantShape {
  /** Rejects any selection naming Sitecore fields — the schema has no such thing. */
  rejectFieldSelections?: boolean;
  /** Validates but answers with no field values — the silent case. */
  emptyFields?: boolean;
  /** Omit the language list. */
  noLanguages?: boolean;
}

/**
 * A client serving a tree, recording every request and which selection it carried.
 *
 * Node ids are single letters padded into a GUID, so the leading character identifies a
 * node both on the way in and on the way back.
 */
function ctxServingTree(tree: Record<string, string[]>, shape: TenantShape = {}) {
  const calls: { id: string; database?: string; selection: string }[] = [];

  const fields = (id: string) => ({
    nodes: shape.emptyFields
      ? []
      : [
          { name: "__Created", value: id === "c" ? "20200101T000000Z" : "20240115T103000Z" },
          { name: "__Updated", value: "20240601T120000Z" },
          { name: "__Created by", value: "sitecore\\jane" },
          { name: "__Updated by", value: "sitecore\\bob" },
        ],
  });

  const raw = (id: string, hasChildren: boolean, selection: string) => ({
    itemId: id.padEnd(32, "0"),
    name: id === "a" ? "Home" : "Child " + id,
    path: "/sitecore/content/" + id,
    hasChildren,
    template: { templateId: TEMPLATE, name: "Sample" },
    ...(selection === "basic"
      ? {}
      : {
          languages: shape.noLanguages ? [] : [{ name: "en" }],
          fields: fields(id),
        }),
  });

  const client = {
    mutate: async (
      _op: string,
      o: { params: { body: { query: string; variables: Record<string, unknown> } } },
    ) => {
      const query = o.params.body.query;
      const selection = query.includes("fields(names:")
        ? "rich"
        : query.includes("fields {")
          ? "rich-all"
          : "basic";

      if (shape.rejectFieldSelections && selection !== "basic") {
        throw new Error("Authoring API: Unknown field 'fields' on type 'Item'");
      }

      const id = (String(o.params.body.variables.itemId ?? "")[0] ?? "").toLowerCase();
      calls.push({
        id,
        database: o.params.body.variables.database as string | undefined,
        selection,
      });

      const children = tree[id] ?? [];
      const item = raw(id, children.length > 0, selection);
      return query.includes("children {")
        ? {
            data: {
              data: {
                item: {
                  ...item,
                  children: {
                    nodes: children.map((c) => raw(c, (tree[c] ?? []).length > 0, selection)),
                  },
                },
              },
            },
          }
        : { data: { data: { item } } };
    },
  } as unknown as ClientSDK;

  const ctx: XmcContext = { client, contextId: "ctx-1", database: "master" };
  return { ctx, calls };
}

// a → b, c ; b → d
const TREE = { a: ["b", "c"], b: ["d"] };

function dynamic(over: Partial<DynamicItemSource> = {}): DynamicItemSource {
  return {
    uid: "u1",
    name: "dyn",
    behaviour: { ...ASK_USER },
    kind: "items-dynamic",
    database: "master",
    root: "{a}",
    skipVersions: false,
    include: {},
    exclude: {},
    ...over,
  };
}

function staticSource(over: Partial<StaticItemSource> = {}): StaticItemSource {
  return {
    uid: "u2",
    name: "stat",
    behaviour: { ...ASK_USER },
    kind: "items-static",
    entries: [],
    skipVersions: false,
    ...over,
  };
}

function definitionOf(...sources: PackageDefinition["sources"]): PackageDefinition {
  const definition = emptyDefinition();
  definition.sources = sources;
  return definition;
}

beforeEach(() => {
  // The negotiated selection is cached for the session; without this each case would
  // inherit whatever the previous one settled on.
  resetPreviewSelection();
});

describe("resolving a dynamic source", () => {
  it("returns the root and every descendant as entry references", async () => {
    const { ctx } = ctxServingTree(TREE);
    const result = await resolveSource(ctx, dynamic());
    expect(result.entries).toHaveLength(4);
    expect(result.scanned).toBe(4);
  });

  it("writes the entry key in the `<x-item>` form, scoped to all languages and versions", async () => {
    const { ctx } = ctxServingTree(TREE);
    const result = await resolveSource(ctx, dynamic());
    expect(result.entries[0].key).toBe(
      "/master/sitecore/content/{A0000000-0000-0000-0000-000000000000}/invariant/0",
    );
  });

  it("uses the SOURCE's database, not the connection's", async () => {
    // The walk used to drop the database on every child request, so a source pointed at
    // `web` silently enumerated `master` and produced entries for the wrong items.
    const { ctx, calls } = ctxServingTree(TREE);
    const result = await resolveSource(ctx, dynamic({ database: "web" }));
    expect(result.entries[0].ref?.database).toBe("web");
    expect(calls.every((c) => c.database === "web")).toBe(true);
  });

  it("issues no request at all when no search root is set yet", async () => {
    const { ctx, calls } = ctxServingTree(TREE);
    const result = await resolveSource(ctx, dynamic({ root: "" }));
    expect(result.entries).toEqual([]);
    expect(result.note).toMatch(/search root/i);
    expect(calls).toEqual([]);
  });
});

describe("filters over the walk", () => {
  it("drops items the include chain rejects", async () => {
    const { ctx } = ctxServingTree(TREE);
    const source = dynamic({ include: { name: { pattern: "Child", searchType: "Simple" } } });
    const result = await resolveSource(ctx, source);
    // "Home" (the root) is out; the three children are in.
    expect(result.entries).toHaveLength(3);
    expect(result.scanned).toBe(4);
  });

  it("filters the ROOT item too, rather than exempting it", async () => {
    const { ctx } = ctxServingTree(TREE);
    const source = dynamic({ include: { name: { pattern: "Home", searchType: "Simple" } } });
    const result = await resolveSource(ctx, source);
    expect(result.entries).toHaveLength(1);
  });

  it("applies a date filter once the metadata is available", async () => {
    const { ctx } = ctxServingTree(TREE);
    // Node "c" was created in 2020; the rest in 2024.
    const source = dynamic({ include: { created: { mode: "range", from: "2023-01-01" } } });
    const result = await resolveSource(ctx, source);
    expect(result.entries).toHaveLength(3);
    expect(result.unevaluated).toEqual([]);
  });

  it("excludes an item WITHOUT pruning its children — exclude is a filter, not a cut", async () => {
    const { ctx } = ctxServingTree(TREE);
    // "b" is excluded by name, but "d" hangs below it and must survive.
    const source = dynamic({ exclude: { name: { pattern: "Child b", searchType: "Simple" } } });
    const result = await resolveSource(ctx, source);
    expect(result.entries).toHaveLength(3);
    expect(result.scanned).toBe(4);
  });

  it("refuses to run on a name pattern that cannot compile", async () => {
    const { ctx } = ctxServingTree(TREE);
    const source = dynamic({ include: { name: { pattern: "(unclosed", searchType: "Regex" } } });
    // Matching everything instead would silently ignore the filter you are looking at.
    await expect(resolveSource(ctx, source)).rejects.toThrow(/not a valid regex pattern/i);
  });
});

describe("negotiating what the endpoint can tell us", () => {
  it("applies the date and account filters when the metadata comes back", async () => {
    const { ctx } = ctxServingTree(TREE);
    const source = dynamic({
      include: { created: { mode: "within", days: 3650 }, createdBy: ["sitecore\\jane"] },
    });
    expect((await resolveSource(ctx, source)).unevaluated).toEqual([]);
  });

  it("falls back and reports the filters it could not apply when the selection is refused", async () => {
    const { ctx } = ctxServingTree(TREE, { rejectFieldSelections: true });
    const source = dynamic({
      include: { created: { mode: "within", days: 30 }, createdBy: ["sitecore\\jane"] },
    });
    const result = await resolveSource(ctx, source);
    expect(result.unevaluated.sort()).toEqual(["created", "createdBy"]);
  });

  it("still lists items when it cannot filter them, rather than resolving to nothing", async () => {
    const { ctx } = ctxServingTree(TREE, { rejectFieldSelections: true });
    const source = dynamic({ include: { created: { mode: "within", days: 1 } } });
    const result = await resolveSource(ctx, source);
    expect(result.entries).toHaveLength(4);
  });

  it("keeps applying the filters it CAN judge while it falls back", async () => {
    const { ctx } = ctxServingTree(TREE, { rejectFieldSelections: true });
    const source = dynamic({
      include: {
        created: { mode: "within", days: 1 },
        name: { pattern: "Child", searchType: "Simple" },
      },
    });
    expect((await resolveSource(ctx, source)).entries).toHaveLength(3);
  });

  it("demotes a selection that VALIDATES but answers with no field values", async () => {
    // The trap: a Sitecore field name the endpoint does not know is an argument, not a
    // schema error, so nothing throws. Trusting that would leave every date filter
    // matching nothing while reporting itself as applied.
    const { ctx } = ctxServingTree(TREE, { emptyFields: true });
    const source = dynamic({ include: { created: { mode: "within", days: 30 } } });
    const result = await resolveSource(ctx, source);
    expect(result.unevaluated).toEqual(["created"]);
    expect(result.entries).toHaveLength(4);
  });

  it("reports the language filter as unapplied when no languages come back", async () => {
    const { ctx } = ctxServingTree(TREE, { noLanguages: true });
    const source = dynamic({ include: { languages: ["en"] } });
    expect((await resolveSource(ctx, source)).unevaluated).toEqual(["languages"]);
  });

  it("negotiates once per session, not once per item", async () => {
    const { ctx, calls } = ctxServingTree(TREE);
    await resolveSource(ctx, dynamic());
    const afterFirst = calls.length;
    await resolveSource(ctx, dynamic());
    // The second run repeats the walk but not the probe.
    expect(calls.length - afterFirst).toBe(afterFirst - 1);
  });

  it("reports an exclude-chain filter it cannot apply, which widens the package just as much", async () => {
    const { ctx } = ctxServingTree(TREE, { rejectFieldSelections: true });
    const source = dynamic({ exclude: { modifiedBy: ["sitecore\\bob"] } });
    expect((await resolveSource(ctx, source)).unevaluated).toEqual(["modifiedBy"]);
  });
});

describe("cancellation and size", () => {
  it("stops the walk and discards the partial result", async () => {
    const { ctx } = ctxServingTree(TREE);
    const controller = new AbortController();
    const run = resolveSource(ctx, dynamic(), { signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toThrow(/abort/i);
  });

  it("truncates rather than throwing, since a partial preview is still informative", async () => {
    // Add with Subitems throws here instead: it builds a STORED list, where a
    // breadth-first cut is not a selection anyone asked for.
    const { ctx } = ctxServingTree(TREE);
    const result = await resolveSource(ctx, dynamic(), { limit: 2 });
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThanOrEqual(2);
  });

  it("is not truncated on a subtree that fits", async () => {
    const { ctx } = ctxServingTree(TREE);
    expect((await resolveSource(ctx, dynamic())).truncated).toBe(false);
  });
});

describe("sources that need no network", () => {
  it("resolves a static source without issuing a single request", async () => {
    const { ctx, calls } = ctxServingTree(TREE);
    const source = staticSource({
      entries: [
        { database: "master", path: "/sitecore/content", id: "{A}", language: "invariant", version: 0 },
      ],
    });
    const result = await resolveSource(ctx, source);
    expect(result.entries).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("says why a file source resolves to nothing, rather than looking merely empty", async () => {
    const { ctx } = ctxServingTree(TREE);
    const result = await resolveSource(ctx, {
      uid: "u3",
      name: "files",
      behaviour: { ...ASK_USER },
      kind: "files-dynamic",
      root: "/bin",
      converterRoot: "/",
      include: {},
      exclude: {},
    });
    expect(result.entries).toEqual([]);
    expect(result.note).toMatch(/no server file system/i);
  });
});

describe("the whole package", () => {
  const ref = (id: string) => ({
    database: "master",
    path: "/sitecore/content",
    id,
    language: "invariant",
    version: 0,
  });

  it("removes an entry a later source repeats, as the generator's Uniq sink does", async () => {
    const { ctx } = ctxServingTree(TREE);
    const first = staticSource({ uid: "s1", entries: [ref("{A}"), ref("{B}")] });
    const second = staticSource({ uid: "s2", entries: [ref("{B}"), ref("{C}")] });

    const preview = await resolveDefinition(ctx, definitionOf(first, second));

    expect(preview.entries).toHaveLength(3);
    expect(preview.duplicates).toBe(1);
  });

  it("gives the entry to the FIRST source that claims it", async () => {
    const { ctx } = ctxServingTree(TREE);
    const first = staticSource({ uid: "s1", entries: [ref("{B}")] });
    const second = staticSource({ uid: "s2", entries: [ref("{B}")] });

    const preview = await resolveDefinition(ctx, definitionOf(first, second));

    expect(preview.entries[0].sourceUid).toBe("s1");
    expect(preview.sources.map((s) => s.contributed)).toEqual([1, 0]);
    expect(preview.sources.map((s) => s.resolved)).toEqual([1, 1]);
  });

  it("keeps previewing the other sources when one of them fails", async () => {
    const { ctx } = ctxServingTree(TREE);
    const broken = dynamic({ uid: "bad", include: { name: { pattern: "(", searchType: "Regex" } } });
    const fine = staticSource({ uid: "ok", entries: [ref("{A}")] });

    const preview = await resolveDefinition(ctx, definitionOf(broken, fine));

    expect(preview.sources[0].error).toMatch(/not a valid/i);
    expect(preview.sources[1].contributed).toBe(1);
    expect(preview.entries).toHaveLength(1);
  });

  it("carries each source's install options through, so the table can show them", async () => {
    const { ctx } = ctxServingTree(TREE);
    const source = staticSource({
      uid: "s1",
      entries: [ref("{A}")],
      behaviour: { itemMode: "Overwrite", itemMergeMode: "Undefined" },
    });
    const preview = await resolveDefinition(ctx, definitionOf(source));
    expect(preview.sources[0].behaviour.itemMode).toBe("Overwrite");
  });

  it("keeps account entries, which are in the definition and are saved back unchanged", async () => {
    const { ctx } = ctxServingTree(TREE);
    const preview = await resolveDefinition(
      ctx,
      definitionOf({
        uid: "acc",
        name: "accounts",
        behaviour: { ...ASK_USER },
        kind: "accounts",
        entries: [{ type: "roles", domain: "sitecore", name: "Author" }],
      }),
    );
    expect(preview.entries[0].key).toBe("roles:sitecore\\Author");
  });

  it("does not collide an account key with an item key", async () => {
    const { ctx } = ctxServingTree(TREE);
    const preview = await resolveDefinition(
      ctx,
      definitionOf(
        staticSource({ uid: "s1", entries: [ref("{A}")] }),
        {
          uid: "acc",
          name: "accounts",
          behaviour: { ...ASK_USER },
          kind: "accounts",
          entries: [{ type: "users", domain: "sitecore", name: "jane" }],
        },
      ),
    );
    expect(preview.entries).toHaveLength(2);
    expect(preview.duplicates).toBe(0);
  });

  it("previews an empty definition as empty rather than failing", async () => {
    const { ctx } = ctxServingTree(TREE);
    const preview = await resolveDefinition(ctx, emptyDefinition());
    expect(preview.entries).toEqual([]);
    expect(preview.sources).toEqual([]);
  });
});
