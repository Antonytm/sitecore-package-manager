// Fetching the bytes behind a media item.
//
// The Authoring API cannot supply binary at all, so these bytes come from a content-transfer
// pull. What matters here is that the pull is matched back to the right blob id, that one
// bad chunk cannot cost the good ones, and that a total failure degrades to "missing"
// rather than failing generation.

import { describe, it, expect } from "vitest";
import { encodePayload, writeFrames } from "../../core/raif/codec";
import type { Frame } from "../../core/raif/codec";
import { Writer } from "../../core/raif/protobuf";
import { fetchMedia } from "../media";
import type { XmcContext } from "../client";

const ctx = {} as XmcContext;

/** A payload of one blob marker frame plus its raw, unprefixed bytes. */
function mediaPayload(entries: { blobId: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    // protobuf-net shape: the BASE type's Length/Id sit at the top level, and only the
    // derived type's own BlobId is wrapped in the ProtoInclude field.
    const marker: Frame = [
      { no: 1, wire: 0, value: BigInt(entry.data.length) },
      { no: 2, wire: 2, value: new Writer().finish() },
      { no: 101, wire: 2, value: new Writer().text(3, entry.blobId).finish() },
    ];
    parts.push(writeFrames([marker]));
    parts.push(entry.data);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const mediaChunk = (entries: { blobId: string; data: Uint8Array }[]) =>
  encodePayload(mediaPayload(entries), { first: true, media: true });

const BLOB = "{A1111111-1111-1111-1111-111111111111}";
const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("fetchMedia", () => {
  it("matches a blob back to the item that asked for it", async () => {
    const chunk = await mediaChunk([{ blobId: BLOB, data: bytes }]);
    const out = await fetchMedia(ctx, [{ path: "/media/test", blobId: BLOB }], {
      pull: async () => [chunk],
    });
    expect(out.missing).toEqual([]);
    expect(out.blobs).toHaveLength(1);
    expect(out.blobs[0].id).toBe(BLOB);
    expect([...out.blobs[0].data]).toEqual([...bytes]);
  });

  it.each([
    "a1111111-1111-1111-1111-111111111111",
    "{A1111111-1111-1111-1111-111111111111}",
  ])("matches the wire id %s against the item's reference", async (wireId) => {
    const chunk = await mediaChunk([{ blobId: wireId, data: bytes }]);
    const out = await fetchMedia(ctx, [{ path: "/media/test", blobId: BLOB }], {
      pull: async () => [chunk],
    });
    expect(out.blobs).toHaveLength(1);
    // The package names the entry with a braced GUID whatever spelling either side used —
    // `blob/<db>/blob://…` would not be a usable path.
    expect(out.blobs[0].id).toBe(BLOB);
  });

  it("matches the marker's unhyphenated N-format id against the field's URI", async () => {
    // The exact pair measured on a live tenant. Three differences at once: a `blob://`
    // scheme, hyphens on one side only, and case. Anything less than reducing both to bare
    // hex matches nothing.
    const chunk = await mediaChunk([
      { blobId: "9fda852be32f4775be013e5115a15512", data: bytes },
    ]);
    const out = await fetchMedia(
      ctx,
      [{ path: "/media/test", blobId: "blob://9fda852b-e32f-4775-be01-3e5115a15512" }],
      { pull: async () => [chunk] },
    );
    expect(out.missing).toEqual([]);
    expect(out.blobs).toHaveLength(1);
    expect(out.blobs[0].id).toBe("{9FDA852B-E32F-4775-BE01-3E5115A15512}");
  });

  it("strips the blob:// scheme the Authoring API puts on a blob field", async () => {
    // Measured: the field value arrives as `blob://9fda852b-…`, while the marker carries a
    // bare GUID. Comparing them raw matches nothing and every media item reads as missing.
    const chunk = await mediaChunk([
      { blobId: "9fda852b-e32f-4775-be01-3e5115a15512", data: bytes },
    ]);
    const out = await fetchMedia(
      ctx,
      [{ path: "/media/test", blobId: "blob://9fda852b-e32f-4775-be01-3e5115a15512" }],
      { pull: async () => [chunk] },
    );
    expect(out.missing).toEqual([]);
    expect(out.blobs).toHaveLength(1);
    expect(out.blobs[0].id).toBe("{9FDA852B-E32F-4775-BE01-3E5115A15512}");
  });

  it("reports media that did not come back rather than inventing an empty file", async () => {
    const out = await fetchMedia(
      ctx,
      [{ path: "/media/present", blobId: BLOB }, { path: "/media/absent", blobId: "{B2222222-2222-2222-2222-222222222222}" }],
      { pull: async () => [await mediaChunk([{ blobId: BLOB, data: bytes }])] },
    );
    expect(out.blobs).toHaveLength(1);
    expect(out.missing).toEqual(["/media/absent"]);
  });

  it("keeps the media from the chunks that did decode", async () => {
    const good = await mediaChunk([{ blobId: BLOB, data: bytes }]);
    const broken = Uint8Array.from([0x53, 0x43, 0x54, 0x01, 0x03, 9, 9, 9]);
    const out = await fetchMedia(ctx, [{ path: "/media/test", blobId: BLOB }], {
      pull: async () => [broken, good],
    });
    expect(out.blobs).toHaveLength(1);
    expect(out.problems.join(" ")).toMatch(/media chunk could not be read/);
  });

  it("degrades to missing when the pull itself fails", async () => {
    // Generation must still produce a package. A media item with no file is worse than one
    // with it and far better than no package at all.
    const out = await fetchMedia(ctx, [{ path: "/media/test", blobId: BLOB }], {
      pull: async () => {
        throw new Error("transfer refused");
      },
    });
    expect(out.blobs).toEqual([]);
    expect(out.missing).toEqual(["/media/test"]);
    expect(out.problems.join(" ")).toMatch(/transfer refused/);
  });

  it("makes no request when nothing carries media", async () => {
    let pulled = false;
    const out = await fetchMedia(ctx, [], {
      pull: async () => {
        pulled = true;
        return [];
      },
    });
    expect(pulled).toBe(false);
    expect(out.blobs).toEqual([]);
  });

  it("keeps one copy when the same blob arrives twice", async () => {
    const chunk = await mediaChunk([
      { blobId: BLOB, data: bytes },
      { blobId: BLOB, data: Uint8Array.from([9, 9]) },
    ]);
    const out = await fetchMedia(ctx, [{ path: "/media/test", blobId: BLOB }], {
      pull: async () => [chunk],
    });
    expect(out.blobs).toHaveLength(1);
    expect([...out.blobs[0].data]).toEqual([...bytes]);
  });
});
