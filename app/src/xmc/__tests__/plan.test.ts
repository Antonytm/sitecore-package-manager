// The read-only plan pass, driven through its injected request seam.
//
// The behaviours worth pinning are the ones that decide whether a user is warned before an
// irreversible write: a missing template must block only the items that use it, and a
// per-item error must not be mistaken for "this item does not exist" — which would silently
// turn an update into a create.

import { describe, it, expect } from "vitest";
import type { ItemModel, PackageModel } from "../../core/model";
import type { XmcContext } from "../client";
import { findExisting, planInstall, type PlanRequest } from "../plan";

const ctx = { client: {}, contextId: "c", database: "master" } as unknown as XmcContext;

const item = (id: string, over: Partial<ItemModel> = {}): ItemModel => ({
  id,
  name: "n" + id,
  path: "/sitecore/content/n" + id,
  templateId: "{DDDDDDDD-0000-0000-0000-000000000001}",
  parentId: "{0DE95AE4-41AB-4D01-9EB0-67441B7C2450}",
  sharedFields: [],
  languages: [],
  ...over,
});

const pkg = (items: ItemModel[]): PackageModel => ({
  metadata: { name: "p" },
  items,
  sources: [],
});

/** Answers "exists" for the given bare ids; everything else comes back null. */
function serving(existing: string[], errors: { message: string; path?: string[] }[] = []) {
  const documents: string[] = [];
  const request: PlanRequest = async <T,>(document: string) => {
    documents.push(document);
    const aliases = [...document.matchAll(/(a\d+): item\(where: \{ itemId: "([0-9A-Fa-f-]+)"/g)];
    const data: Record<string, unknown> = {};
    for (const [, alias, id] of aliases) {
      data[alias] = existing.some((e) => e.toLowerCase() === id.toLowerCase())
        ? { itemId: id, path: "/sitecore/content/" + id }
        : null;
    }
    return { data: data as T, errors };
  };
  return { request, documents };
}

describe("findExisting", () => {
  it("reports only the ids the target actually returned", async () => {
    const { request } = serving(["AAAAAAAA-0000-0000-0000-000000000001"]);
    const { found } = await findExisting(
      ctx,
      ["{AAAAAAAA-0000-0000-0000-000000000001}", "{BBBBBBBB-0000-0000-0000-000000000002}"],
      { request },
    );
    expect(found.has("{AAAAAAAA-0000-0000-0000-000000000001}")).toBe(true);
    expect(found.has("{BBBBBBBB-0000-0000-0000-000000000002}")).toBe(false);
  });

  it("batches rather than asking one item at a time", async () => {
    const ids = Array.from({ length: 60 }, (_, i) =>
      "{AAAAAAAA-0000-0000-0000-" + String(i).padStart(12, "0") + "}",
    );
    const { request, documents } = serving([]);
    await findExisting(ctx, ids, { request, batchSize: 25 });
    expect(documents.length).toBe(3);
  });

  it("attributes a per-alias error to its item instead of dropping it", async () => {
    const { request } = serving([], [{ message: "no access", path: ["a1"] }]);
    const { problems } = await findExisting(
      ctx,
      ["{AAAAAAAA-0000-0000-0000-000000000001}", "{BBBBBBBB-0000-0000-0000-000000000002}"],
      { request },
    );
    expect(problems[0]).toMatch(/BBBBBBBB.*no access/);
  });

  it("reports progress across batches", async () => {
    const ids = Array.from({ length: 30 }, (_, i) =>
      "{AAAAAAAA-0000-0000-0000-" + String(i).padStart(12, "0") + "}",
    );
    const { request } = serving([]);
    const seen: number[] = [];
    await findExisting(ctx, ids, { request, batchSize: 25, onProgress: (d) => seen.push(d) });
    expect(seen).toEqual([25, 30]);
  });
});

describe("planInstall", () => {
  const TEMPLATE = "{DDDDDDDD-0000-0000-0000-000000000001}";

  it("classifies items as create or update", async () => {
    const a = item("{AAAAAAAA-0000-0000-0000-000000000001}");
    const b = item("{BBBBBBBB-0000-0000-0000-000000000002}");
    const { request } = serving([
      "AAAAAAAA-0000-0000-0000-000000000001",
      TEMPLATE.replace(/[{}]/g, ""),
    ]);

    const plan = await planInstall(ctx, pkg([a, b]), { request });
    expect(plan.updating).toBe(1);
    expect(plan.creating).toBe(1);
    expect(plan.entries.find((e) => e.item.id === a.id)!.disposition).toBe("update");
  });

  it("blocks only the items whose template is missing", async () => {
    const good = item("{AAAAAAAA-0000-0000-0000-000000000001}");
    const bad = item("{BBBBBBBB-0000-0000-0000-000000000002}", {
      templateId: "{CCCCCCCC-0000-0000-0000-000000000003}",
    });
    // The good template exists; the other does not.
    const { request } = serving([TEMPLATE.replace(/[{}]/g, "")]);

    const plan = await planInstall(ctx, pkg([good, bad]), { request });
    expect(plan.blocked).toBe(1);
    expect(plan.creating).toBe(1);
    const blocked = plan.entries.find((e) => e.item.id === bad.id)!;
    expect(blocked.disposition).toBe("blocked");
    expect(blocked.reason).toMatch(/template .* is not on this environment/);
    expect(plan.missingTemplates).toEqual(["{CCCCCCCC-0000-0000-0000-000000000003}"]);
  });

  it("does not treat a template carried by the package itself as missing", async () => {
    const template = item(TEMPLATE);
    const child = item("{AAAAAAAA-0000-0000-0000-000000000001}");
    const { request } = serving([]); // nothing exists on the target at all
    const plan = await planInstall(ctx, pkg([template, child]), { request });
    expect(plan.missingTemplates).toEqual([]);
    expect(plan.blocked).toBe(0);
    expect(plan.creating).toBe(2);
  });

  it("surfaces check problems instead of silently planning a create", async () => {
    const a = item("{AAAAAAAA-0000-0000-0000-000000000001}");
    const { request } = serving([TEMPLATE.replace(/[{}]/g, "")], [{ message: "boom" }]);
    const plan = await planInstall(ctx, pkg([a]), { request });
    expect(plan.problems).toEqual(["boom"]);
  });

  it("orders entries parents-first", async () => {
    const parent = item("{AAAAAAAA-0000-0000-0000-000000000001}");
    const child = item("{BBBBBBBB-0000-0000-0000-000000000002}", { parentId: parent.id });
    const { request } = serving([TEMPLATE.replace(/[{}]/g, "")]);
    // Supplied child-first on purpose.
    const plan = await planInstall(ctx, pkg([child, parent]), { request });
    expect(plan.entries.map((e) => e.item.id)).toEqual([parent.id, child.id]);
  });

  it("handles an empty package without asking anything", async () => {
    const { request, documents } = serving([]);
    const plan = await planInstall(ctx, pkg([]), { request });
    expect(plan.entries).toEqual([]);
    expect(documents.length).toBe(0);
  });
});
