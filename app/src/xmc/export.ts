// xmc/export — read items from XM Cloud into the domain model.  (API ──► model)
//
// The "Marketplace calls → ZIP" direction (the read half; core/writePackage does the
// zip half). Resolves a source definition — static enumeration or a dynamic root+filters
// query — into ItemModel[]. See wiki/articles/package-creation.md.

import type {
  ItemModel,
  SourceDefinition,
  StaticItemSource,
  DynamicItemSource,
} from "../core/model";
import type { XmcContext } from "./client";

/** Fetch the items named by a static source (explicit IDs). */
export async function exportStatic(
  _ctx: XmcContext,
  _source: StaticItemSource,
): Promise<ItemModel[]> {
  throw new Error("exportStatic: not implemented");
}

/** Resolve a dynamic source (root + filters) to its current items. */
export async function exportDynamic(
  _ctx: XmcContext,
  _source: DynamicItemSource,
): Promise<ItemModel[]> {
  throw new Error("exportDynamic: not implemented");
}

/** Resolve any item source to ItemModel[]; non-item sources yield nothing (out of scope). */
export async function exportSource(
  ctx: XmcContext,
  source: SourceDefinition,
): Promise<ItemModel[]> {
  switch (source.kind) {
    case "items-static":
      return exportStatic(ctx, source);
    case "items-dynamic":
      return exportDynamic(ctx, source);
    default:
      return [];
  }
}
