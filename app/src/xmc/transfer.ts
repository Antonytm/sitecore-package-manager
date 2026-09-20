// xmc/transfer — the XM Cloud content-transfer API.  (chunks <──► environment)
//
// This is the install path's transport, and the reason the installer does not go through the
// Authoring API at all: `createItem` has no item-id input, so nothing there can write an item
// at the GUID a package specifies. Content transfer moves items *between environments*, so it
// preserves identity by construction. See core/raif for the chunk format.
//
// Two shapes worth stating once, because both were found the hard way:
//
//   - Every operation needs `sitecoreContextId`. Without it the gateway answers 404
//     "No sitecore context", which looks like a missing endpoint rather than a missing header.
//   - Responses are DOUBLE-wrapped: the SDK's own envelope wraps the service's, so the useful
//     body is at `result.data.data`. Reading `result.data` yields an object that looks
//     plausible and has none of the fields.
//
// Every call goes through one injectable seam so the whole module is testable under vitest's
// node environment with no SDK and no network, matching browse.ts / export.ts.

import type { XmcContext } from "./client";

/** Scope of a subtree to transfer, as the service names them. */
export type TreeScope = "SingleItem" | "ItemAndDescendants";

/** How the target reconciles an item that already exists. */
export type MergeStrategy =
  | "OverrideExistingItem"
  | "KeepExistingItem"
  | "LatestWin"
  | "OverrideExistingTree";

export interface DataTree {
  itemPath: string;
  scope: TreeScope;
  mergeStrategy: MergeStrategy;
}

export interface ChunkSetMeta {
  chunkSetId: string;
  chunkCount: number;
  totalItemCount: number;
}

export interface TransferStatus {
  state: string;
  chunkSets: ChunkSetMeta[];
}

/** The one seam: `kind` picks the SDK verb, `operation` the registered name. */
export type TransferCall = (
  kind: "query" | "mutate",
  operation: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface TransferOptions {
  signal?: AbortSignal;
  call?: TransferCall;
  /** Poll cadence while a transfer runs. */
  pollMs?: number;
  /** Give up after this many polls rather than hanging forever. */
  maxPolls?: number;
}

export class TransferError extends Error {
  constructor(
    message: string,
    readonly operation: string,
  ) {
    super(message);
    this.name = "TransferError";
  }
}

const DEFAULT_POLL_MS = 1500;
const DEFAULT_MAX_POLLS = 60;

function callerFor(ctx: XmcContext, options: TransferOptions): TransferCall {
  if (options.call) return options.call;
  const client = ctx.client as unknown as {
    query(op: string, p: unknown): Promise<unknown>;
    mutate(op: string, p: unknown): Promise<unknown>;
  };
  return (kind, operation, params) =>
    kind === "query" ? client.query(operation, params) : client.mutate(operation, params);
}

/** Peel the SDK envelope off the service envelope. */
function unwrap(result: unknown): unknown {
  let level = result;
  for (let i = 0; i < 3; i++) {
    if (!level || typeof level !== "object") return level;
    const record = level as Record<string, unknown>;
    if (record.error) {
      const e = record.error as Record<string, unknown>;
      throw new TransferError(
        String(e.title ?? e.detail ?? "request failed") +
          (e.status ? " (" + String(e.status) + ")" : ""),
        "content transfer",
      );
    }
    if (!("data" in record)) return level;
    level = record.data;
  }
  return level;
}

function queryOf(ctx: XmcContext): Record<string, unknown> {
  // Omit rather than send undefined — the gateway treats a present-but-empty value as absent
  // and answers 404 "No sitecore context", which is indistinguishable from a bad URL.
  return ctx.contextId ? { sitecoreContextId: ctx.contextId } : {};
}

/** A fresh transfer id. The service requires one; it does not mint them. */
export function newTransferId(): string {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------- export */

export async function createTransfer(
  ctx: XmcContext,
  transferId: string,
  dataTrees: DataTree[],
  options: TransferOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  await callerFor(ctx, options)("mutate", "xmc.contentTransfer.createContentTransfer", {
    params: {
      body: { transferId, configuration: { dataTrees } },
      query: queryOf(ctx),
    },
  });
}

export async function getStatus(
  ctx: XmcContext,
  transferId: string,
  options: TransferOptions = {},
): Promise<TransferStatus> {
  options.signal?.throwIfAborted();
  const raw = unwrap(
    await callerFor(ctx, options)("query", "xmc.contentTransfer.getContentTransferStatus", {
      params: { path: { transferId }, query: queryOf(ctx) },
    }),
  ) as
    | {
        State?: string;
        ChunkSetsMetadata?: Array<{
          ChunkSetId?: string;
          ChunkCount?: number;
          TotalItemCount?: number;
        }>;
      }
    | undefined;

  return {
    state: raw?.State ?? "Unknown",
    chunkSets: (raw?.ChunkSetsMetadata ?? []).map((c) => ({
      chunkSetId: String(c.ChunkSetId ?? ""),
      chunkCount: Number(c.ChunkCount ?? 0),
      totalItemCount: Number(c.TotalItemCount ?? 0),
    })),
  };
}

/** Poll until the transfer leaves its running state. */
export async function awaitTransfer(
  ctx: XmcContext,
  transferId: string,
  options: TransferOptions = {},
): Promise<TransferStatus> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;

  for (let i = 0; i < maxPolls; i++) {
    const status = await getStatus(ctx, transferId, options);
    if (status.state === "Completed") return status;
    if (status.state === "Failed" || status.state === "Error") {
      throw new TransferError("transfer reported " + status.state, "getContentTransferStatus");
    }
    // Abort is checked between polls only: the SDK posts through the parent frame and takes
    // no signal, so an in-flight request has to land.
    options.signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new TransferError("transfer did not complete after " + maxPolls + " polls", "awaitTransfer");
}

export async function getChunk(
  ctx: XmcContext,
  transferId: string,
  chunkSetId: string,
  chunkId: number,
  options: TransferOptions = {},
): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const raw = unwrap(
    await callerFor(ctx, options)("query", "xmc.contentTransfer.getChunk", {
      params: {
        path: { transferId, chunksetId: chunkSetId, chunkId },
        query: queryOf(ctx),
      },
    }),
  );
  return toBytes(raw, "getChunk");
}

async function toBytes(raw: unknown, operation: string): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof Blob !== "undefined" && raw instanceof Blob) {
    return new Uint8Array(await raw.arrayBuffer());
  }
  throw new TransferError("expected binary chunk data, got " + typeof raw, operation);
}

/* ------------------------------------------------------------------- import */

export async function saveChunk(
  ctx: XmcContext,
  transferId: string,
  chunkSetId: string,
  chunkId: number,
  bytes: Uint8Array,
  options: TransferOptions & { isMedia?: boolean } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  // The operation is declared as taking a Blob; sending a bare Uint8Array goes out as JSON
  // and the service stores something that will never decrypt.
  const body: unknown =
    typeof Blob !== "undefined" ? new Blob([bytes as BlobPart], { type: "application/octet-stream" }) : bytes;
  await callerFor(ctx, options)("mutate", "xmc.contentTransfer.saveChunk", {
    params: {
      path: { transferId, chunksetId: chunkSetId, chunkId },
      query: { ...queryOf(ctx), ...(options.isMedia ? { isMedia: true } : {}) },
      body,
    },
  });
}

/** Seals a chunk set and returns the `.raif` file name the target has assembled. */
export async function completeChunkSet(
  ctx: XmcContext,
  transferId: string,
  chunkSetId: string,
  options: TransferOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const raw = unwrap(
    await callerFor(ctx, options)("mutate", "xmc.contentTransfer.completeChunkSetTransfer", {
      params: { path: { transferId, chunksetId: chunkSetId }, query: queryOf(ctx) },
    }),
  ) as { ContentTransferFileName?: string } | undefined;

  const name = raw?.ContentTransferFileName;
  if (!name) {
    throw new TransferError("no ContentTransferFileName was returned", "completeChunkSetTransfer");
  }
  return name;
}

/**
 * Applies an assembled `.raif` to a database. This is the step that writes items.
 *
 * The file name must carry a scheme. A bare name is rejected with *"Allowed schema is not
 * specified"*, and — because `consumeFile` answers 202 either way — that rejection is
 * invisible unless `getBlobState` is polled afterwards. Chunks pushed with `saveChunk` live
 * in blob storage, so `blob://` is the right scheme; `file://` is for a name already on disk.
 */
export async function consumeFile(
  ctx: XmcContext,
  fileName: string,
  options: TransferOptions & { database?: string; scheme?: "blob" | "file" } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const scheme = options.scheme ?? "blob";
  const qualified = /^[a-z]+:\/\//.test(fileName) ? fileName : scheme + "://" + fileName;
  await callerFor(ctx, options)("query", "xmc.contentTransfer.consumeFile", {
    params: {
      query: {
        ...queryOf(ctx),
        databaseName: options.database ?? ctx.database ?? "master",
        fileName: qualified,
      },
    },
  });
}

export interface BlobState {
  /** `Uploaded` before a consume, and something terminal after it. */
  status: string;
  /** Set when the consume failed; this is where a malformed payload finally surfaces. */
  error?: string;
  /** Set once the file has actually been consumed. */
  consumedName?: string;
}

/**
 * States that mean "still working", as opposed to a terminal answer.
 *
 * `Initializing` belongs here and its absence was a real bug: the install reported success
 * while the consume had not started, so a rejected payload would have looked like a clean
 * install. Anything not listed is treated as terminal, which is the safe direction — an
 * unrecognised state stops the wait rather than spinning.
 */
const PENDING = new Set([
  "uploaded",
  "initializing",
  "inprogress",
  "in progress",
  "pending",
  "unknown",
  "consuming",
]);

/**
 * The status of a consumed `.raif`.
 *
 * `consumeFile` answers 202 Accepted and does the work afterwards, so a successful consume
 * call proves only that the file was queued. This is where a rejected payload actually
 * surfaces.
 */
export async function getBlobState(
  ctx: XmcContext,
  fileName: string,
  options: TransferOptions = {},
): Promise<BlobState> {
  options.signal?.throwIfAborted();
  const raw = unwrap(
    await callerFor(ctx, options)("query", "xmc.contentTransfer.getBlobState", {
      params: { query: { ...queryOf(ctx), fileName } },
    }),
  ) as { BlobState?: string; Error?: string | null; ConsumedName?: string | null } | undefined;

  // The service answers `BlobState`, not the `status` the SDK's own types advertise.
  return {
    status: raw?.BlobState ?? "Unknown",
    error: raw?.Error ?? undefined,
    consumedName: raw?.ConsumedName ?? undefined,
  };
}

/** Poll until the consume settles, so an install reports what really happened. */
export async function awaitConsume(
  ctx: XmcContext,
  fileName: string,
  options: TransferOptions = {},
): Promise<BlobState> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  let last: BlobState = { status: "Unknown" };

  for (let i = 0; i < maxPolls; i++) {
    last = await getBlobState(ctx, fileName, options);
    if (last.error) return last;
    if (last.consumedName) return last;
    if (!PENDING.has(last.status.toLowerCase())) return last;
    options.signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return last;
}

export async function deleteTransfer(
  ctx: XmcContext,
  transferId: string,
  options: TransferOptions = {},
): Promise<void> {
  // Deliberately no abort check: this runs in a finally, and skipping cleanup because the
  // user cancelled is how transfers leak.
  await callerFor(ctx, options)("mutate", "xmc.contentTransfer.deleteContentTransfer", {
    params: { path: { transferId }, query: queryOf(ctx) },
  });
}

/* ----------------------------------------------------------------- compound */

/**
 * Export a subtree and return its raw chunks.
 *
 * Used two ways: to study the format, and as the installer's pre-flight check — decoding a
 * freshly-pulled chunk proves this environment's key still matches the one our encoder uses,
 * before we write anything.
 */
export async function exportSubtree(
  ctx: XmcContext,
  itemPath: string,
  options: TransferOptions & { scope?: TreeScope } = {},
): Promise<Uint8Array[]> {
  const transferId = newTransferId();
  try {
    await createTransfer(
      ctx,
      transferId,
      [
        {
          itemPath,
          scope: options.scope ?? "SingleItem",
          mergeStrategy: "OverrideExistingItem",
        },
      ],
      options,
    );
    const status = await awaitTransfer(ctx, transferId, options);
    const out: Uint8Array[] = [];
    for (const set of status.chunkSets) {
      for (let i = 0; i < set.chunkCount; i++) {
        out.push(await getChunk(ctx, transferId, set.chunkSetId, i, options));
      }
    }
    return out;
  } finally {
    await deleteTransfer(ctx, transferId, options).catch(() => {});
  }
}
