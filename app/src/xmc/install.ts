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
//
// Media goes in the same payload as the items, and the target does the rest by itself:
//
//   * `ItemDataSourceExtensions.LoadSourceInfo` scans every marker in the assembled `.raif`
//     before a single item is written, so a blob marker is found wherever it sits.
//   * `BlobTransferer.TryGetBlobs` collects the blob ids from each item's own blob FIELDS,
//     and `Transfer` copies each stream out of the transfer source into the target's blob
//     store. Nothing here has to name an item-to-blob relationship: the field value is it.
//   * The two ids meet through `Utils.FormatBlobId` (`Guid.TryParse` then `ToString("N")`),
//     so `blob://9fda852b-…` in a field and `9fda852be32f…` in a marker are the same blob.
//
// One consequence worth knowing: `BlobTransferer.Transfer` bails out of its whole loop the
// first time a stream comes back null, so a package missing one blob quietly costs the
// blobs after it too. The Create path already reports media it could not read; this side
// ships what the package holds and does not invent a placeholder.

import type { BlobModel, ItemModel, PackageModel } from "../core/model";
import { parentsFirst } from "../core/package";
import { encodePayload, writePayload, type RaifBlob } from "../core/raif/codec";
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

/**
 * How much payload one `saveChunk` carries.
 *
 * A chunk set is reassembled by Azure block-blob concatenation —
 * `AzureChunkedDataProvider.SaveChunkAsync` stages each decoded chunk as a block and
 * `JoinChunksAsync` commits them ordered by chunk id — so the assembled `.raif` is exactly
 * the chunks' payloads end to end. That means the split point is arbitrary: it may fall
 * inside an item, inside a blob's bytes, anywhere. Only the order matters.
 *
 * Splitting exists solely to keep a single request small. Media makes that real — a package
 * with items alone is a few kilobytes, one with a handful of images is tens of megabytes,
 * and that goes out through the SDK's postMessage bridge to the portal before it ever
 * becomes an HTTP request.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Spell a blob id the way `Sitecore.Data.ItemsTransfer.TransferredBlob` does.
 *
 * Both sides of the lookup pass through `Utils.FormatBlobId`, which is `Guid.TryParse` then
 * `ToString("N")`, so any GUID-parsable spelling would match. Writing the same 32 lowercase
 * hex characters Sitecore's own writer emits keeps an authored chunk comparable with a
 * pulled one, and it keeps the package's `{BRACED}` entry name out of the wire format.
 *
 * A value that is not a GUID is passed through untouched: `FormatBlobId` does the same, so a
 * package carrying some other identifier still matches itself.
 */
function blobIdOnTheWire(id: string): string {
  const hex = id.replace(/[{}()-]/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : id;
}

/**
 * The blobs a package carries, ready to write into a payload.
 *
 * Deduplicated because the reader indexes blobs into a dictionary keyed by the formatted id
 * and Sitecore's own validation treats a repeat as a defect (`DuplicatedBlobIds`). Two
 * entries for one id would also mean shipping the same bytes twice.
 */
function toRaifBlobs(blobs: BlobModel[] | undefined): RaifBlob[] {
  const out = new Map<string, RaifBlob>();
  for (const blob of blobs ?? []) {
    const blobId = blobIdOnTheWire(blob.id);
    if (!out.has(blobId)) out.set(blobId, { blobId, data: blob.data });
  }
  return [...out.values()];
}

/** Split a payload into chunk-sized slices, preserving order. */
function sliceChunks(payload: Uint8Array, size: number): Uint8Array[] {
  if (payload.length <= size) return [payload];
  const out: Uint8Array[] = [];
  for (let at = 0; at < payload.length; at += size) {
    out.push(payload.subarray(at, Math.min(at + size, payload.length)));
  }
  return out;
}

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
  /** Payload bytes per `saveChunk`. Defaults to `CHUNK_BYTES`; tests use a small value. */
  chunkBytes?: number;
}

export interface InstallResult {
  installed: number;
  skipped: number;
  failed: Array<{ item: ItemModel; error: string }>;
  /** Media blobs written into the payload alongside the items. */
  media: number;
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
  if (items.length === 0) return { installed: 0, skipped: 0, failed: [], media: 0 };

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
    const blobs = toRaifBlobs(pkg.blobs);
    const payload = writePayload(frames, blobs);
    const slices = sliceChunks(payload, opts.chunkBytes ?? CHUNK_BYTES);
    step(
      "payload",
      items.length + " items, " + blobs.length + " blob(s), " + payload.length + " bytes in " +
        slices.length + " chunk(s)",
    );

    for (let i = 0; i < slices.length; i++) {
      opts.signal?.throwIfAborted();
      // Only the first chunk sets the chunk-set bit, matching how a pulled set is flagged.
      // `isMedia` stays false throughout: these chunks are encrypted, and the flag chooses
      // which inverse the service applies. Media travels here as part of the ordinary
      // payload rather than as its own unencrypted chunk — the assembled file is the same
      // bytes either way, and one encoding path is one path to get wrong.
      const chunk = await encodePayload(slices[i], { first: i === 0 });
      await saveChunk(ctx, transferId, chunkSetId, i, chunk, transfer);
      step("saveChunk", chunkSetId + " #" + i + " (" + chunk.length + " bytes)");
    }

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

    return { installed: items.length, skipped: 0, failed: [], media: blobs.length, fileName };
  } catch (e) {
    const message = e instanceof TransferError ? e.message : String(e);
    step("failed", message.slice(0, 300));
    // The chunk set is applied as one unit — an incomplete set is never committed, so a
    // failure means nothing landed from it. Report every item as failed rather than
    // implying a partial success we cannot verify.
    return {
      installed: 0,
      skipped: 0,
      media: 0,
      failed: items.map((item) => ({ item, error: message })),
    };
  } finally {
    await deleteTransfer(ctx, transferId, transfer).catch(() => {});
  }
}
