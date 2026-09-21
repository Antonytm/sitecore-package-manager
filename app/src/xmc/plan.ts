// xmc/plan — the read-only "what will change" pass.
//
// Installing here is irreversible: there is no uninstall, no installation history and no
// rollback, and a chunk is consumed as one unit. So the plan step is the only compensating
// control in the design, and it runs the *same* existence pass the installer needs rather
// than a second, subtly different one.
//
// Everything here is reads. Nothing in this module writes.

import type { Guid, ItemModel, PackageModel } from "../core/model";
import { parentsFirst } from "../core/package";
import { authoringGraphqlPartial, type PartialResult } from "./authoring";
import { toBracedGuid } from "./browse";
import type { XmcContext } from "./client";

/** What will happen to one packaged item. */
export type Disposition = "create" | "update" | "blocked";

export interface PlannedItem {
  item: ItemModel;
  disposition: Disposition;
  /** The existing item's path, when it is already on the target. */
  existingPath?: string;
  /** Why it cannot be installed, when blocked. */
  reason?: string;
}

export interface InstallPlan {
  entries: PlannedItem[];
  creating: number;
  updating: number;
  blocked: number;
  /** Media blobs the package carries, which install alongside the items. */
  media: number;
  /** Templates referenced by the package that are neither in it nor on the target. */
  missingTemplates: Guid[];
  /** Problems that are not attributable to a single item. */
  problems: string[];
}

export type PlanRequest = <T>(document: string) => Promise<PartialResult<T>>;

export interface PlanOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  batchSize?: number;
  /** Injected for tests; defaults to the authoring transport. */
  request?: PlanRequest;
}

const DEFAULT_BATCH = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `a0: item(where: { itemId: "…" }) { itemId path }` — one alias per id. */
function existenceDocument(ids: Guid[]): string {
  const selections = ids
    .map((id, i) => {
      const bare = id.replace(/[{}]/g, "");
      return `  a${i}: item(where: { itemId: "${bare}", database: "master" }) { itemId path }`;
    })
    .join("\n");
  return "query InstallPlan {\n" + selections + "\n}";
}

interface FoundItem {
  itemId?: string;
  path?: string;
}

/**
 * Which of these ids already exist on the target, as id -> path.
 *
 * Batched and partial: one inaccessible item must not blind us to the other 24, which is
 * exactly why `authoringGraphqlPartial` exists.
 */
export async function findExisting(
  ctx: XmcContext,
  ids: Guid[],
  options: PlanOptions = {},
): Promise<{ found: Map<Guid, string>; problems: string[] }> {
  const request: PlanRequest =
    options.request ?? ((document) => authoringGraphqlPartial(ctx, document));

  const found = new Map<Guid, string>();
  const problems: string[] = [];
  const batches = chunk(ids, options.batchSize ?? DEFAULT_BATCH);

  let done = 0;
  for (const batch of batches) {
    options.signal?.throwIfAborted();
    const result = await request<Record<string, FoundItem | null>>(existenceDocument(batch));

    for (const error of result.errors) {
      // Attribute the failure to its alias when the server says which one broke.
      const alias = error.path?.[0];
      const index = alias === undefined ? NaN : Number(String(alias).replace("a", ""));
      const id = Number.isFinite(index) ? batch[index] : undefined;
      problems.push((id ? id + ": " : "") + (error.message ?? "unknown error"));
    }

    for (let i = 0; i < batch.length; i++) {
      const node = result.data?.["a" + i];
      if (node?.itemId) found.set(batch[i], node.path ?? "");
    }

    done += batch.length;
    options.onProgress?.(Math.min(done, ids.length), ids.length);
  }

  return { found, problems };
}

/** Build the plan for a package without changing anything. */
export async function planInstall(
  ctx: XmcContext,
  pkg: PackageModel,
  options: PlanOptions = {},
): Promise<InstallPlan> {
  const items = parentsFirst(pkg.items);
  const inPackage = new Set(items.map((i) => toBracedGuid(i.id)));

  // Templates the package relies on but does not carry. A missing one is a per-item block,
  // not a global failure — the rest of the package is still installable.
  const referenced = new Set<Guid>();
  for (const item of items) {
    const template = toBracedGuid(item.templateId);
    if (!inPackage.has(template)) referenced.add(template);
  }

  const ids = [...items.map((i) => toBracedGuid(i.id)), ...referenced];
  const { found, problems } = await findExisting(ctx, ids, options);

  const missingTemplates = [...referenced].filter((id) => !found.has(id));
  const missing = new Set(missingTemplates);

  const entries: PlannedItem[] = items.map((item) => {
    const id = toBracedGuid(item.id);
    const template = toBracedGuid(item.templateId);
    if (missing.has(template)) {
      return {
        item,
        disposition: "blocked",
        reason: "its template " + template + " is not on this environment",
      };
    }
    const existingPath = found.get(id);
    return existingPath === undefined
      ? { item, disposition: "create" }
      : { item, disposition: "update", existingPath };
  });

  return {
    entries,
    creating: entries.filter((e) => e.disposition === "create").length,
    updating: entries.filter((e) => e.disposition === "update").length,
    blocked: entries.filter((e) => e.disposition === "blocked").length,
    media: pkg.blobs?.length ?? 0,
    missingTemplates,
    problems,
  };
}
