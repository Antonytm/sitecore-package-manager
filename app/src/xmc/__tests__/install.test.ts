// Installing a package, driven through the transfer module's injected call seam.
//
// The interesting part is no longer "does it call five operations in order" — it is what
// ends up in the bytes. A chunk set is reassembled by Azure block-blob concatenation
// (`AzureChunkedDataProvider.JoinChunksAsync` commits blocks ordered by chunk id), so the
// assembled `.raif` is the chunks' payloads end to end. That is what these tests decode:
// join the pushed chunks back together and read the result the way the target will.

import { describe, it, expect } from "vitest";
import type { PackageModel, ItemModel } from "../../core/model";
import { decodePayload, readPayload } from "../../core/raif/codec";
import { framesToItems } from "../../core/raif/items";
import type { XmcContext } from "../client";
import { installPackage } from "../install";
import type { TransferCall } from "../transfer";

interface Recorded {
  kind: string;
  operation: string;
  params: Record<string, unknown>;
}

const wrapped = (body: unknown) => ({ data: { data: body }, status: "success" });

function harness(overrides: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  const chunks: Array<{ chunkId: number; bytes: Uint8Array; isMedia: unknown }> = [];

  const responses: Record<string, unknown> = {
    completeChunkSetTransfer: wrapped({ ContentTransferFileName: "contentTransfer.raif" }),
    getBlobState: wrapped({ BlobState: "Consumed", ConsumedName: "consumed.raif" }),
    ...overrides,
  };

  const call: TransferCall = async (kind, operation, params) => {
    calls.push({ kind, operation, params });
    const key = operation.replace("xmc.contentTransfer.", "");
    if (key === "saveChunk") {
      const p = params.params as {
        path: { chunkId: number };
        query: Record<string, unknown>;
        body: Blob;
      };
      chunks.push({
        chunkId: p.path.chunkId,
        bytes: new Uint8Array(await p.body.arrayBuffer()),
        isMedia: p.query.isMedia,
      });
    }
    if (key in responses) {
      const answer = responses[key];
      return typeof answer === "function" ? (answer as () => unknown)() : answer;
    }
    return wrapped({});
  };

  const ctx = { client: {}, contextId: "ctx-1", database: "master" } as unknown as XmcContext;
  return { ctx, calls, chunks, transfer: { call, pollMs: 0 } };
}

/**
 * The file the target assembles: every pushed chunk decoded, in chunk-id order, concatenated.
 *
 * Decoding per chunk and concatenating the PAYLOADS is exactly what `SaveChunkAsync` +
 * `JoinChunksAsync` do, which is why a split is allowed to fall mid-item or mid-blob.
 */
async function assembled(chunks: Array<{ chunkId: number; bytes: Uint8Array }>) {
  const ordered = [...chunks].sort((a, b) => a.chunkId - b.chunkId);
  const parts = await Promise.all(ordered.map((c) => decodePayload(c.bytes)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const ROOT = "{11111111-1111-1111-1111-111111111111}";
const TEMPLATE = "{22222222-2222-2222-2222-222222222222}";
const BLOB_FIELD = "{40E50ED9-BA07-4702-992E-A912738D32DC}";
const BLOB_ID = "{9FDA852B-E32F-4775-BE01-3E5115A15512}";

const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function mediaItem(): ItemModel {
  return {
    id: "{33333333-3333-3333-3333-333333333333}",
    name: "test",
    path: "/sitecore/media library/Project/test",
    templateId: TEMPLATE,
    parentId: ROOT,
    created: "20260920T000000Z",
    // The blob field's value is what ties the item to the bytes — `BlobTransferer` reads the
    // relationship out of the field, never out of the package.
    sharedFields: [{ id: BLOB_FIELD, value: "blob://9fda852b-e32f-4775-be01-3e5115a15512", sharing: "Shared" }],
    languages: [],
  };
}

function pkgWith(over: Partial<PackageModel> = {}): PackageModel {
  return {
    metadata: { name: "Test" },
    sources: [],
    items: [mediaItem()],
    ...over,
  } as PackageModel;
}

describe("installPackage", () => {
  it("writes the package's media into the payload the target will read", async () => {
    const h = harness();
    const result = await installPackage(h.ctx, pkgWith({
      blobs: [{ id: BLOB_ID, database: "master", data: image }],
    }), { transfer: h.transfer });

    expect(result.failed).toEqual([]);
    expect(result.media).toBe(1);

    const payload = readPayload(await assembled(h.chunks));
    expect(payload.blobs).toHaveLength(1);
    expect([...payload.blobs[0].data]).toEqual([...image]);
    // The items are still there, and still readable, with the blob interleaved.
    expect(framesToItems(payload.frames).map((i) => i.name)).toEqual(["test"]);
  });

  it("spells the blob id the way Sitecore's own writer does", async () => {
    // Both sides of the lookup go through `Utils.FormatBlobId` (Guid.TryParse then "N"), so
    // the match is by GUID value — but writing the package's `{BRACED}` entry name onto the
    // wire would make an authored chunk differ from a pulled one for no reason.
    const h = harness();
    await installPackage(h.ctx, pkgWith({
      blobs: [{ id: BLOB_ID, data: image }],
    }), { transfer: h.transfer });

    const payload = readPayload(await assembled(h.chunks));
    expect(payload.blobs[0].blobId).toBe("9fda852be32f4775be013e5115a15512");
  });

  it("keeps one copy when a package lists the same blob twice", async () => {
    // A repeat is what `DuplicatedBlobIds` flags on the target, and it would also ship the
    // same bytes twice.
    const h = harness();
    const result = await installPackage(h.ctx, pkgWith({
      blobs: [
        { id: BLOB_ID, data: image },
        { id: "9fda852be32f4775be013e5115a15512", data: image },
      ],
    }), { transfer: h.transfer });

    expect(result.media).toBe(1);
    expect(readPayload(await assembled(h.chunks)).blobs).toHaveLength(1);
  });

  it("splits a large payload across chunks and the pieces reassemble", async () => {
    const big = new Uint8Array(20_000);
    // Incompressible, so the split is not optimised away by deflate.
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) & 0xff;

    const h = harness();
    await installPackage(h.ctx, pkgWith({ blobs: [{ id: BLOB_ID, data: big }] }), {
      transfer: h.transfer,
      chunkBytes: 4096,
    });

    expect(h.chunks.length).toBeGreaterThan(1);
    // Chunk ids must be 0..n-1 in order: the blocks are committed sorted by id, so a gap or
    // a repeat silently reorders the file.
    expect(h.chunks.map((c) => c.chunkId)).toEqual(h.chunks.map((_, i) => i));

    const payload = readPayload(await assembled(h.chunks));
    expect([...payload.blobs[0].data]).toEqual([...big]);
  });

  it("pushes every chunk as an encrypted one, never as media", async () => {
    // The `isMedia` flag picks which inverse the service applies. These chunks are AES, so
    // claiming media would have the target inflate ciphertext.
    const h = harness();
    await installPackage(h.ctx, pkgWith({ blobs: [{ id: BLOB_ID, data: image }] }), {
      transfer: h.transfer,
      chunkBytes: 64,
    });
    expect(h.chunks.every((c) => c.isMedia === undefined)).toBe(true);
  });

  it("installs a package with no media exactly as before", async () => {
    const h = harness();
    const result = await installPackage(h.ctx, pkgWith(), { transfer: h.transfer });

    expect(result.installed).toBe(1);
    expect(result.media).toBe(0);
    expect(h.chunks).toHaveLength(1);
    expect(readPayload(await assembled(h.chunks)).blobs).toEqual([]);
  });

  it("reports the failure rather than a partial install when a chunk is refused", async () => {
    const h = harness({
      completeChunkSetTransfer: () => {
        throw new Error("refused");
      },
    });
    const result = await installPackage(h.ctx, pkgWith({
      blobs: [{ id: BLOB_ID, data: image }],
    }), { transfer: h.transfer });

    expect(result.installed).toBe(0);
    expect(result.media).toBe(0);
    expect(result.failed).toHaveLength(1);
  });
});
