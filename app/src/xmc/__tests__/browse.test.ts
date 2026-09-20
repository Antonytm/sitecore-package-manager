// The pure adapters in browse.ts. The Authoring API speaks bare lower-case GUIDs while
// the package format writes braced upper-case ones, so this conversion sits directly on
// the correctness path for every generated package.

import { describe, it, expect } from "vitest";
import {
  toBracedGuid,
  toItemRef,
  listDatabases,
  getItem,
  getChildren,
  enumerateSubtree,
  SubtreeTooLargeError,
} from "../browse";
import type { ItemNode } from "../browse";
import type { XmcContext } from "../client";
import type { ClientSDK } from "@sitecore-marketplace-sdk/client";

const node = (path: string, id = "513a5371aa834db2a559e5687586b400"): ItemNode => ({
  id: toBracedGuid(id),
  name: path.split("/").pop() ?? "",
  path,
  hasChildren: false,
  templateId: toBracedGuid("a6c086ad96514912bc60512ca5417795"),
  templateName: "Sample",
});

describe("toBracedGuid", () => {
  it("brackets, upper-cases and hyphenates a bare GUID", () => {
    expect(toBracedGuid("513a5371aa834db2a559e5687586b400")).toBe(
      "{513A5371-AA83-4DB2-A559-E5687586B400}",
    );
  });

  it("normalises an already-hyphenated GUID", () => {
    expect(toBracedGuid("513a5371-aa83-4db2-a559-e5687586b400")).toBe(
      "{513A5371-AA83-4DB2-A559-E5687586B400}",
    );
  });

  it("is idempotent on a value that is already braced", () => {
    const braced = "{513A5371-AA83-4DB2-A559-E5687586B400}";
    expect(toBracedGuid(braced)).toBe(braced);
    expect(toBracedGuid(toBracedGuid(braced))).toBe(braced);
  });
});

describe("toItemRef", () => {
  it("stores the PARENT path, since the id is its own reference segment", () => {
    const ref = toItemRef(node("/sitecore/content/Home"), "master");
    expect(ref.path).toBe("/sitecore/content");
    expect(ref.database).toBe("master");
  });

  it("scopes to all languages and versions, as picking an item does", () => {
    const ref = toItemRef(node("/sitecore/content/Home"), "master");
    expect(ref.language).toBe("invariant");
    expect(ref.version).toBe(0);
  });

  it("keeps a root-level item addressable", () => {
    expect(toItemRef(node("/sitecore"), "master").path).toBe("/");
  });
});

describe("listDatabases", () => {
  it("offers master first, since the Authoring API is scoped to it", () => {
    expect(listDatabases()[0]).toBe("master");
  });
});

// ── against a realistic Authoring API response ──────────────────────────────
//
// The adapters above are pure, but the lookups are only correct if they read the right
// level of the SDK's nested response. These drive getItem/getChildren through a client
// that answers with the real two-level shape.

function ctxReturning(graphqlData: unknown): XmcContext {
  const client = {
    mutate: async () => ({ data: { data: graphqlData } }),
  } as unknown as ClientSDK;
  return { client, contextId: "ctx-1", database: "master" };
}

const RAW_ROOT = {
  itemId: "11111111111111111111111111111111",
  name: "sitecore",
  path: "/sitecore",
  hasChildren: true,
  template: { templateId: "c6576836910c4cc3933cfce4d0ac0c58", name: "Root" },
};

// The Authoring API declares `ItemQueryInput.itemId` as `ID`. GraphQL validates a
// variable's declared type even when the operation supplies no value for it, so getting
// this wrong rejected EVERY item query — including the path-only ones — with
// "The specified value type of field `itemId` does not match the field type."
describe("item query declarations", () => {
  it("declares $itemId as ID, matching ItemQueryInput", async () => {
    let sent = "";
    const client = {
      mutate: async (_op: string, o: { params: { body: { query: string } } }) => {
        sent = o.params.body.query;
        return { data: { data: { item: null } } };
      },
    } as unknown as ClientSDK;
    const ctx: XmcContext = { client, contextId: "ctx-1", database: "master" };

    await getItem(ctx, { path: "/sitecore" });
    expect(sent).toContain("$itemId: ID");
    expect(sent).not.toContain("$itemId: String");

    await getChildren(ctx, { path: "/sitecore" });
    expect(sent).toContain("$itemId: ID");
    expect(sent).not.toContain("$itemId: String");
  });
});

describe("getItem", () => {
  it("builds a node from a found item", async () => {
    const node = await getItem(ctxReturning({ item: RAW_ROOT }), { path: "/sitecore" });
    expect(node).toEqual({
      id: "{11111111-1111-1111-1111-111111111111}",
      name: "sitecore",
      path: "/sitecore",
      hasChildren: true,
      templateId: "{C6576836-910C-4CC3-933C-FCE4D0AC0C58}",
      templateName: "Root",
    });
  });

  it("reports a genuinely absent item as undefined", async () => {
    expect(await getItem(ctxReturning({ item: null }), { path: "/nope" })).toBeUndefined();
  });
});

describe("getChildren", () => {
  it("reads the children connection's nodes", async () => {
    const children = await getChildren(
      ctxReturning({ item: { ...RAW_ROOT, children: { nodes: [RAW_ROOT] } } }),
      { path: "/sitecore" },
    );
    expect(children.map((c) => c.name)).toEqual(["sitecore"]);
  });

  it("treats an item with no children as an empty level, not an error", async () => {
    expect(await getChildren(ctxReturning({ item: RAW_ROOT }), { path: "/sitecore" })).toEqual([]);
  });
});

// ── subtree enumeration ─────────────────────────────────────────────────────
//
// Add with Subitems walks the tree one request per level, so a wide subtree runs for
// minutes. That makes cancellation part of the contract, not a nicety: without it the
// only way out of a 2500-item expansion was to close the dialog and hope.

/** A client that serves a tree, and counts the requests the walk actually issues. */
function ctxServingTree(tree: Record<string, string[]>) {
  const calls: string[] = [];
  const raw = (id: string, hasChildren: boolean) => ({
    itemId: id.padEnd(32, "0"),
    name: id,
    path: "/" + id,
    hasChildren,
    template: { templateId: "a6c086ad96514912bc60512ca5417795", name: "Sample" },
  });
  const client = {
    mutate: async (
      _op: string,
      o: { params: { body: { query: string; variables: Record<string, unknown> } } },
    ) => {
      // Node ids are single letters padded into a GUID, so the leading character is the
      // key both on the way in ("a") and on the way back ("A0000000-0000-...").
      const id = (String(o.params.body.variables.itemId ?? "")[0] ?? "").toLowerCase();
      calls.push(id);
      const children = tree[id] ?? [];
      const item = raw(id, children.length > 0);
      return o.params.body.query.includes("children")
        ? { data: { data: { item: { ...item, children: { nodes: children.map((c) => raw(c, (tree[c] ?? []).length > 0)) } } } } }
        : { data: { data: { item } } };
    },
  } as unknown as ClientSDK;
  const ctx: XmcContext = { client, contextId: "ctx-1", database: "master" };
  return { ctx, calls };
}

// a → b, c ; b → d
const TREE = { a: ["b", "c"], b: ["d"] };

describe("enumerateSubtree", () => {
  it("returns the root and every descendant", async () => {
    const { ctx } = ctxServingTree(TREE);
    const nodes = await enumerateSubtree(ctx, { itemId: "{a}" });
    expect(nodes.map((n) => n.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("reports progress as each level lands", async () => {
    const { ctx } = ctxServingTree(TREE);
    const seen: number[] = [];
    await enumerateSubtree(ctx, { itemId: "{a}" }, { onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([3, 4]);
  });

  it("refuses a subtree past the limit rather than filling the browser's memory", async () => {
    const { ctx } = ctxServingTree(TREE);
    await expect(
      enumerateSubtree(ctx, { itemId: "{a}" }, { limit: 2 }),
    ).rejects.toThrow(SubtreeTooLargeError);
  });

  describe("cancellation", () => {
    it("throws an AbortError when stopped mid-walk", async () => {
      const { ctx } = ctxServingTree(TREE);
      const controller = new AbortController();
      const walk = enumerateSubtree(ctx, { itemId: "{a}" }, {
        signal: controller.signal,
        // Stop as soon as the first level lands, the way the Stop button does.
        onProgress: () => controller.abort(),
      });
      await expect(walk).rejects.toThrow(/abort/i);
    });

    it("stops issuing requests once aborted", async () => {
      const { ctx, calls } = ctxServingTree(TREE);
      const controller = new AbortController();
      await enumerateSubtree(ctx, { itemId: "{a}" }, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }).catch(() => undefined);
      // getItem(a) + getChildren(a), then the abort lands before getChildren(b).
      expect(calls).toEqual(["a", "a"]);
    });

    it("discards the partial result — a breadth-first cut is not a selection", async () => {
      const { ctx } = ctxServingTree(TREE);
      const controller = new AbortController();
      const result = await enumerateSubtree(ctx, { itemId: "{a}" }, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }).catch(() => "threw");
      expect(result).toBe("threw");
    });

    it("issues no request at all when the signal is already aborted", async () => {
      const { ctx, calls } = ctxServingTree(TREE);
      await expect(
        enumerateSubtree(ctx, { itemId: "{a}" }, { signal: AbortSignal.abort() }),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  });

  // Preview walks the same tree with a selection that also carries item metadata. Passing
  // the fetchers in keeps the queue, the limit guard and the abort check here rather than
  // growing a second, subtly different copy of this loop.
  describe("with the fetchers replaced", () => {
    it("uses the supplied fetchers instead of the picker queries", async () => {
      const { ctx, calls } = ctxServingTree(TREE);
      const nodes = await enumerateSubtree(ctx, { itemId: "{a}" }, {
        fetchRoot: async () => node("/x", "aa000000000000000000000000000000"),
        fetchChildren: async () => [],
      });
      expect(nodes.map((n) => n.path)).toEqual(["/x"]);
      // The substituted fetchers issued no Authoring request of their own.
      expect(calls).toEqual([]);
    });

    it("still honours the abort check between levels", async () => {
      const { ctx } = ctxServingTree(TREE);
      const controller = new AbortController();
      const branching = { ...node("/r"), hasChildren: true };
      await expect(
        enumerateSubtree(ctx, { itemId: "{a}" }, {
          signal: controller.signal,
          fetchRoot: async () => branching,
          fetchChildren: async () => [branching],
          onProgress: () => controller.abort(),
        }),
      ).rejects.toThrow(/abort/i);
    });
  });

  describe("truncateAtLimit", () => {
    it("returns what it collected instead of throwing", async () => {
      // Preview opts into this: a partial list is informative, where a partial STORED
      // entry list would be a selection nobody asked for.
      const { ctx } = ctxServingTree(TREE);
      const nodes = await enumerateSubtree(ctx, { itemId: "{a}" }, {
        limit: 2,
        truncateAtLimit: true,
      });
      expect(nodes).toHaveLength(2);
    });

    it("leaves a subtree that fits untouched", async () => {
      const { ctx } = ctxServingTree(TREE);
      const nodes = await enumerateSubtree(ctx, { itemId: "{a}" }, { truncateAtLimit: true });
      expect(nodes.map((n) => n.name)).toEqual(["a", "b", "c", "d"]);
    });
  });
});
