// xmc/media — fetch the BYTES behind a media item.  (API ──► BlobModel)
//
// The Create path reads items through the Authoring API, and that is still the right
// route for everything except a file. Authoring cannot supply binary content at all:
//
//   * `ItemField.value` on a blob field is the blob's GUID, not its bytes.
//   * The `mediaItem` query exists (`Sitecore.GraphQL.Schema.Authoring.Media`) but its
//     richest answer is `url(options: MediaUrlOptions)` — a hash-protected URL on the CM
//     host, which this iframe is cross-origin to and holds no credentials for. Title,
//     MimeType, Extension and Size are there; the file is not.
//   * No `xmc.*` operation downloads media. `uploadMedia` and `uploadSiteThumbnail` are
//     both write-only.
//
// So the only route to the file is a content-transfer PULL, which is a read against the
// same tenant through an authorised SDK operation. It does not change how installing
// works — `xmc/install.ts` is untouched by this.
//
// A media chunk differs from an item chunk in one way that matters here, and it is not a
// guess: `ContentTransferController.GetChunkAsync` branches on `chunk.IsMedia`, calling
// `CompressAsync` instead of `EncryptAsync`. Media is deflate-only. `core/raif/codec`
// carries that rule; this module only has to ask for the right items and match the answers
// up.

import type { BlobModel, Guid } from "../core/model";
import { decodePayload, isMediaChunk, readPayload } from "../core/raif/codec";
import { toBracedGuid } from "./browse";
import type { XmcContext } from "./client";
import { exportPaths } from "./transfer";
import type { TransferOptions } from "./transfer";

/** A media item whose bytes the package needs, and the blob id its field points at. */
export interface MediaRequest {
  /** Item path, used to ask the transfer service for it. */
  path: string;
  /** The blob field's value — the id the package stores the bytes under. */
  blobId: Guid;
}

export interface FetchedMedia {
  blobs: BlobModel[];
  /** Paths whose bytes did not come back, so the caller can still warn about them. */
  missing: string[];
  problems: string[];
}

export interface MediaOptions extends TransferOptions {
  database?: string;
  /** Injected in tests; defaults to a real content-transfer pull. */
  pull?: (paths: string[]) => Promise<Uint8Array[]>;
}

/**
 * Reduce a blob reference to something comparable.
 *
 * Neither side's spelling is canonical, and they disagree in three separate ways. Measured
 * against a live tenant, the SAME image arrives as:
 *
 *   item blob field   blob://9fda852b-e32f-4775-be01-3e5115a15512   scheme + hyphens
 *   BlobDataMarker    9fda852be32f4775be013e5115a15512              Sitecore's "N" format
 *
 * So reduce both to the 32 hex characters and nothing else. Comparing any richer form
 * matches nothing, and every media item then reports missing with no hint why.
 */
function normalise(id: string): string {
  // The scheme has to go FIRST. `blob` is four hex-legal characters, so reducing to hex
  // before stripping it silently prepends a `b` and nothing ever matches.
  return id
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[^0-9a-f]/gi, "")
    .toLowerCase();
}

/**
 * Pull the media items and return their bytes, keyed by blob id.
 *
 * One transfer for all of them: each pull is a create, a poll loop and a delete, so doing
 * it per item would multiply the slowest part of generation by the media count.
 *
 * Failure here is never fatal. A package without a file is worse than one with it, but far
 * better than no package — so anything that does not come back is reported as missing and
 * the caller carries on, exactly as it did before media was fetched at all.
 */
export async function fetchMedia(
  ctx: XmcContext,
  requests: MediaRequest[],
  options: MediaOptions = {},
): Promise<FetchedMedia> {
  if (requests.length === 0) return { blobs: [], missing: [], problems: [] };

  const problems: string[] = [];
  const wanted = new Map<string, MediaRequest>();
  for (const request of requests) {
    if (request.blobId) wanted.set(normalise(request.blobId), request);
  }

  let chunks: Uint8Array[];
  try {
    const pull = options.pull ?? ((paths: string[]) => exportPaths(ctx, paths, options));
    chunks = await pull(requests.map((r) => r.path));
  } catch (e: unknown) {
    problems.push(
      "media could not be read: " + (e instanceof Error ? e.message : String(e)),
    );
    return { blobs: [], missing: requests.map((r) => r.path), problems };
  }

  const found = new Map<string, Uint8Array>();
  for (const chunk of chunks) {
    options.signal?.throwIfAborted();
    try {
      const { blobs } = readPayload(await decodePayload(chunk));
      // A blob id arriving twice means the same file was pulled twice, not two files —
      // keep the first and do not grow the package with a duplicate.
      for (const blob of blobs) {
        const key = normalise(blob.blobId);
        if (!found.has(key)) found.set(key, blob.data);
      }
    } catch (e: unknown) {
      // One unreadable chunk must not cost the media that did decode.
      problems.push(
        "a media chunk could not be read: " + (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  const blobs: BlobModel[] = [];
  const missing: string[] = [];
  for (const [key, request] of wanted) {
    const data = found.get(key);
    if (!data) {
      missing.push(request.path);
      continue;
    }
    // Braced GUID, not the raw field value: `writePackage` names the entry
    // `blob/<db>/<id>`, and a `blob://…` URI there would produce a malformed path. No
    // sample package we hold contains a blob entry, so the exact spelling Sitecore expects
    // is unverified — this follows `toBracedGuid`, the convention used everywhere else in
    // this codebase, and is the one thing here that a real media package would settle.
    blobs.push({
      id: toBracedGuid(normalise(request.blobId)),
      database: options.database ?? "master",
      data,
    });
  }

  // A silent nothing is the worst outcome here: the pull succeeds, the chunks parse, and
  // every media item reports missing with no hint why. Distinguish "nothing arrived" from
  // "things arrived under ids we did not recognise" — they have completely different causes.
  if (blobs.length === 0) {
    const media = chunks.filter((c) => {
      try {
        return isMediaChunk(c);
      } catch {
        return false;
      }
    }).length;
    problems.push(
      "no media bytes matched: pulled " + chunks.length + " chunk(s), " + media +
        " media, carrying " + found.size + " blob(s) [" + [...found.keys()].join(", ") +
        "]; wanted [" + [...wanted.keys()].join(", ") + "].",
    );
  }

  return { blobs, missing, problems };
}
