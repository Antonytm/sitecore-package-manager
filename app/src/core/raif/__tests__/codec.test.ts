// The acceptance oracle for the .raif container, and the reason Phases 0-2 need no tenant:
//
//   decode a REAL chunk -> re-encode it -> decode again -> the payload bytes must match.
//
// Deflate output cannot be byte-identical across implementations (the same limitation the
// zip codec has on the Create side), so the assertion is on the decrypted, inflated payload
// rather than the container. That single check pins the header, the AES parameters, the
// frame framing, the varint encoding and every protobuf field number at once: if any of them
// were wrong, the re-encoded payload would differ or the second decode would throw.
//
// Chunks live under <repo>/files, which is git-ignored, so this suite self-skips when they
// are absent — the same posture as the package-sample suites.

import { describe, it, expect } from "vitest";
import { basename } from "node:path";
import {
  decodeChunk,
  decodePayload,
  encodeChunk,
  encodePayload,
  readFrames,
  readPayload,
  writeFrames,
  writePayload,
  blobFrame,
  chunkFlags,
  isMediaChunk,
  opensChunkSet,
  MAGIC,
  HEADER_LENGTH,
} from "../codec";
import { readMessage, writeMessage, Writer, VARINT, LENGTH, FIXED64 } from "../protobuf";
import { hasRaifChunks, readBytes, sampleChunks, bytesEqual, firstDiff } from "../../__tests__/samples";

describe("the .raif container", () => {
  it("round-trips a payload through deflate + AES", async () => {
    const payload = new TextEncoder().encode("the quick brown fox ".repeat(40));
    const chunk = await encodePayload(payload);
    expect([...chunk.subarray(0, MAGIC.length)]).toEqual([...MAGIC]);
    // Ciphertext must be a whole number of AES blocks or Sitecore's reader rejects it.
    expect((chunk.length - HEADER_LENGTH) % 16).toBe(0);
    expect(bytesEqual(await decodePayload(chunk), payload)).toBe(true);
  });

  it("carries the chunk-set flag through an encode/decode cycle", async () => {
    // Byte 4 is a flag, not part of a fixed header: 1 opens a chunk set, 0 continues one.
    const payload = new TextEncoder().encode("x");
    expect(opensChunkSet(await encodePayload(payload, true))).toBe(true);
    expect(opensChunkSet(await encodePayload(payload, false))).toBe(false);
  });

  it("round-trips a media chunk, which is deflate-only", async () => {
    // ContentTransferController.GetChunkAsync calls CompressAsync instead of EncryptAsync
    // when chunk.IsMedia. Running a media chunk through AES is what produced "ciphertext is
    // not a non-zero multiple of 16 bytes" on a perfectly good 5 MB pull.
    const payload = new TextEncoder().encode("media bytes, not ciphertext");
    const chunk = await encodePayload(payload, { first: true, media: true });
    expect(isMediaChunk(chunk)).toBe(true);
    expect(bytesEqual(await decodePayload(chunk), payload)).toBe(true);
  });

  it("treats the flag byte as a bit field", async () => {
    const payload = new TextEncoder().encode("x");
    // 3 = opens a chunk set AND media. Testing the flag for equality with 1 reports such a
    // chunk as a continuation, which is how the media case was first missed.
    const both = await encodePayload(payload, { first: true, media: true });
    expect(chunkFlags(both)).toBe(3);
    expect(opensChunkSet(both)).toBe(true);
    expect(isMediaChunk(both)).toBe(true);

    const continuation = await encodePayload(payload, { first: false, media: true });
    expect(chunkFlags(continuation)).toBe(2);
    expect(opensChunkSet(continuation)).toBe(false);
  });

  it("does not encrypt a media chunk", async () => {
    const payload = new TextEncoder().encode("x");
    const item = await encodePayload(payload);
    const media = await encodePayload(payload, { media: true });
    // The encrypted form is padded to a block boundary; the deflate-only form is not.
    expect((item.length - 5) % 16).toBe(0);
    expect(media.length).not.toBe(item.length);
    expect(isMediaChunk(item)).toBe(false);
  });

  it("rejects a chunk without the SCT header", async () => {
    const chunk = await encodePayload(new TextEncoder().encode("x"));
    chunk[0] = 0x58;
    await expect(decodePayload(chunk)).rejects.toThrow(/SCT header/);
  });

  it("rejects ciphertext that is not a whole number of blocks", async () => {
    const chunk = await encodePayload(new TextEncoder().encode("x"));
    await expect(decodePayload(chunk.subarray(0, chunk.length - 1))).rejects.toThrow(/multiple of 16/);
  });
});

describe("frame framing", () => {
  it("round-trips several frames", () => {
    const frames = [
      readMessage(new Writer().varint(1, 7).finish()),
      readMessage(new Writer().text(2, "hello").finish()),
      [],
    ];
    expect(readFrames(writeFrames(frames))).toEqual(frames);
  });

  it("refuses a frame whose length runs past the payload", () => {
    const payload = new Uint8Array([9, 0, 0, 0, 1, 2]); // claims 9 bytes, supplies 2
    expect(() => readFrames(payload)).toThrow(/past the payload/);
  });

  it("refuses trailing bytes after the last frame", () => {
    const good = writeFrames([readMessage(new Writer().varint(1, 1).finish())]);
    const padded = new Uint8Array(good.length + 2);
    padded.set(good, 0);
    expect(() => readFrames(padded)).toThrow(/trailing bytes/);
  });
});

describe("payloads that carry blobs", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5, 6, 7]);

  it("round-trips frames and blobs through a payload", () => {
    const frames = [readMessage(new Writer().varint(1, 7).finish())];
    const blobs = [{ blobId: "9fda852be32f4775be013e5115a15512", data: png }];

    const read = readPayload(writePayload(frames, blobs));
    expect(read.frames).toHaveLength(2); // the item frame plus the blob's marker
    expect(read.blobs).toHaveLength(1);
    expect(read.blobs[0].blobId).toBe("9fda852be32f4775be013e5115a15512");
    expect([...read.blobs[0].data]).toEqual([...png]);
  });

  it("keeps several blobs apart, including bytes that look like a frame length", () => {
    // A blob is raw and unprefixed, so its own bytes are read as a frame header the moment
    // the skip length is wrong. These start with a plausible little-endian length.
    const first = Uint8Array.from([0x20, 0, 0, 0, 1, 2, 3, 4]);
    const second = Uint8Array.from([0xff, 0xff, 0xff, 0x7f, 9]);
    const read = readPayload(
      writePayload([], [
        { blobId: "a".repeat(32), data: first },
        { blobId: "b".repeat(32), data: second },
      ]),
    );
    expect(read.blobs.map((b) => b.blobId)).toEqual(["a".repeat(32), "b".repeat(32)]);
    expect([...read.blobs[0].data]).toEqual([...first]);
    expect([...read.blobs[1].data]).toEqual([...second]);
  });

  it("writes the length at the frame's top level, not inside the 101 wrapper", () => {
    // protobuf-net puts the BASE type's members at the top level and only BlobId inside the
    // ProtoInclude field. Reading Length from inside the wrapper yields 0, which skips
    // nothing and desynchronises on the next marker.
    const frame = blobFrame({ blobId: "c".repeat(32), data: png });
    expect(frame.find((f) => f.no === 1)?.value).toBe(BigInt(png.length));
    const wrapper = frame.find((f) => f.no === 101)?.value as Uint8Array;
    expect(readMessage(wrapper).map((f) => f.no)).toEqual([3]);
  });

  it("survives a real encode/decode cycle with the blob intact", async () => {
    const payload = writePayload(
      [readMessage(new Writer().text(2, "an item").finish())],
      [{ blobId: "d".repeat(32), data: png }],
    );
    const read = readPayload(await decodePayload(await encodePayload(payload)));
    expect([...read.blobs[0].data]).toEqual([...png]);
  });

  it("emits nothing extra when there are no blobs", () => {
    const frames = [readMessage(new Writer().varint(1, 1).finish())];
    expect([...writePayload(frames)]).toEqual([...writeFrames(frames)]);
  });
});

describe.skipIf(!hasRaifChunks)("against real chunks from a live environment", () => {
  const chunks = sampleChunks();

  it("finds the samples", () => {
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("sees a continuation chunk among them, and it has no marker frame", async () => {
    // The two-chunk export is the only reason we know byte 4 is a flag. If every sample
    // opened a chunk set, a fixed 5-byte header would look correct and fail in production.
    const flags = chunks.map((p) => opensChunkSet(readBytes(p)));
    expect(flags).toContain(false);

    const continuation = chunks.find((p) => !opensChunkSet(readBytes(p)))!;
    const frames = await decodeChunk(readBytes(continuation));
    expect(frames[0].some((f) => f.no === 102)).toBe(false);

    const opener = chunks.find((p) => opensChunkSet(readBytes(p)))!;
    const openerFrames = await decodeChunk(readBytes(opener));
    expect(openerFrames[0].some((f) => f.no === 102)).toBe(true);
  });

  for (const path of chunks) {
    const name = basename(path);

    it(`decodes ${name}`, async () => {
      const frames = await decodeChunk(readBytes(path));
      expect(frames.length).toBeGreaterThan(0);
      // Every frame must be well-formed protobuf: no unknown wire types, nothing truncated.
      for (const frame of frames) {
        for (const f of frame) {
          expect([VARINT, FIXED64, LENGTH, 5]).toContain(f.wire);
          expect(f.no).toBeGreaterThan(0);
        }
      }
    });

    it(`re-encodes ${name} to a byte-identical payload`, async () => {
      const original = readBytes(path);
      const payload = await decodePayload(original);
      const frames = readFrames(payload);

      const rebuilt = writeFrames(frames);
      const at = firstDiff(payload, rebuilt);
      expect(
        at,
        at < 0
          ? ""
          : `payload differs at byte ${at}: ${payload[at]?.toString(16)} vs ${rebuilt[at]?.toString(16)}`,
      ).toBe(-1);

      // And the whole container survives a real encode/decode cycle.
      const again = await decodePayload(await encodeChunk(frames));
      expect(bytesEqual(again, payload)).toBe(true);
    });
  }
});

describe("protobuf primitives", () => {
  it("re-emits decoded fields verbatim", () => {
    const bytes = new Writer()
      .varint(1, 300)
      .text(2, "test")
      .fixed64(3, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
      .message(4, (w) => w.varint(1, 1))
      .finish();
    expect(bytesEqual(writeMessage(readMessage(bytes)), bytes)).toBe(true);
  });

  it("encodes -1 as the ten-byte all-ones varint, as the format's shared marker does", () => {
    // Shared/unversioned fields carry version = -1; a naive encoder would emit one byte.
    const bytes = new Writer().varint(3, -1n).finish();
    expect(bytes.length).toBe(11); // 1 tag + 10 payload
    expect(readMessage(bytes)[0].value).toBe(18446744073709551615n);
  });

  it("round-trips a multi-byte varint", () => {
    const bytes = new Writer().varint(1, 639254560168136729n).finish();
    expect(readMessage(bytes)[0].value).toBe(639254560168136729n);
  });
});
