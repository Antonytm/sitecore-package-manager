// xmc/install — apply a parsed package to XM Cloud.  (model ──► API)
//
// The "ZIP → Marketplace API calls" direction:
//
//   PackageModel ──core/raif──► chunks ──► saveChunk → completeChunkSet → consumeFile
//
// Not the Authoring API: `CreateItemInput` has no item-id field (verified against a live
// tenant across all 69 mutations), so nothing there can write an item at the GUID a package
// specifies, and a package is a graph of GUID references. Content transfer moves items
// between environments and so preserves identity by construction.
// See core/raif for the chunk format and wiki/articles/package-installation.md for the
// behaviour this replaces.

import type { ItemModel, PackageModel } from "../core/model";
import { parentsFirst } from "../core/package";
import { encodeChunk } from "../core/raif/codec";
import { itemsToFrames } from "../core/raif/items";
import type { XmcContext } from "./client";
import type { CollisionPrompt } from "./collisions";
import {
  awaitConsume,
  completeChunkSet,
  consumeFile,
  createTransfer,
  deleteTransfer,
  newTransferId,
  saveChunk,
  TransferError,
  type MergeStrategy,
  type TransferOptions,
} from "./transfer";

export interface InstallOptions {
  /** Called when a source's option is "Ask User". */
  onCollision?: CollisionPrompt;
  /** Progress callback (per item). */
  onProgress?: (done: number, total: number, item: ItemModel) => void;
  /** Cancels between steps; an in-flight request still has to land. */
  signal?: AbortSignal;
  /** How the target reconciles items that already exist. */
  mergeStrategy?: MergeStrategy;
  /** Target database; defaults to the context's. */
  database?: string;
  /** Injected transport seam, as everywhere else in this layer. */
  transfer?: TransferOptions;
  /** Diagnostics for each step, in order. */
  onStep?: (step: string, detail?: string) => void;
}

export interface InstallResult {
  installed: number;
  skipped: number;
  failed: Array<{ item: ItemModel; error: string }>;
  /** The `.raif` the target assembled, useful for support and for retrying a consume. */
  fileName?: string;
}

/**
 * Apply every item in the package to the target environment.
 *
 * Collision handling is currently the transfer's own `mergeStrategy`; the per-item
 * Overwrite/Merge/Skip prompt is layered on in the wizard phase.
 */
export async function installPackage(
  ctx: XmcContext,
  pkg: PackageModel,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const step = opts.onStep ?? (() => {});
  const transfer: TransferOptions = { ...opts.transfer, signal: opts.signal };

  const items = parentsFirst(pkg.items);
  if (items.length === 0) return { installed: 0, skipped: 0, failed: [] };

  const transferId = newTransferId();
  const chunkSetId = newTransferId();

  try {
    // The push side may or may not need the transfer to exist first — the service documents
    // createContentTransfer as a *source* operation. Try it, but do not fail the install if
    // it is refused: the only step that must succeed is saveChunk.
    try {
      await createTransfer(ctx, transferId, [], transfer);
      step("createTransfer", transferId);
    } catch (e) {
      step("createTransfer skipped", String(e).slice(0, 200));
    }

    opts.signal?.throwIfAborted();

    const frames = itemsToFrames(items);
    const chunk = await encodeChunk(frames);
    step("encoded", items.length + " items, " + chunk.length + " bytes");

    await saveChunk(ctx, transferId, chunkSetId, 0, chunk, transfer);
    step("saveChunk", chunkSetId);

    const fileName = await completeChunkSet(ctx, transferId, chunkSetId, transfer);
    step("completeChunkSet", fileName);

    await consumeFile(ctx, fileName, { ...transfer, database: opts.database ?? ctx.database });
    step("consumeFile", fileName);

    // consumeFile answers 202 Accepted, so success there proves only that the file was
    // queued. The consume is where a malformed payload is actually rejected.
    const state = await awaitConsume(ctx, fileName, transfer);
    step("consume state", state.status + (state.error ? " — " + state.error : ""));
    if (state.error) {
      throw new TransferError("the target rejected the package: " + state.error, "consumeFile");
    }
    if (!state.consumedName && state.status.toLowerCase() === "uploaded") {
      throw new TransferError(
        "the package was uploaded but never consumed (state stayed " + state.status + ")",
        "consumeFile",
      );
    }

    for (let i = 0; i < items.length; i++) opts.onProgress?.(i + 1, items.length, items[i]);

    return { installed: items.length, skipped: 0, failed: [], fileName };
  } catch (e) {
    const message = e instanceof TransferError ? e.message : String(e);
    step("failed", message.slice(0, 300));
    // The chunk is applied as one unit, so a failure means nothing landed from it — report
    // every item as failed rather than implying a partial success we cannot verify.
    return {
      installed: 0,
      skipped: 0,
      failed: items.map((item) => ({ item, error: message })),
    };
  } finally {
    await deleteTransfer(ctx, transferId, transfer).catch(() => {});
  }
}
