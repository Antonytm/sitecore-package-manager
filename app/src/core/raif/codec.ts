// core/raif/codec — the .raif chunk container.
//
//   [ 'S' 'C' 'T' 01 01 ]  AES-128-CBC( raw-deflate( payload ) )   PKCS#7
//   payload = repeated { uint32-LE length, protobuf frame }
//
// Measured against real chunks pulled from a live XM Cloud environment, not inferred. The
// key and IV are compiled into Sitecore.ContentTransfer.Data.Core.Services.StreamService and
// are therefore the same on every environment — which is the whole reason a chunk can be
// authored here rather than only read.
//
// Two notes on why this is allowed to live in `core/`:
//   - AES-CBC is Web Crypto (`crypto.subtle`), which ARCHITECTURE.md explicitly permits.
//     That is the same rule that made MD5 impossible for blobs on the Create side; here it
//     cuts the other way.
//   - Raw DEFLATE comes from fflate, already a dependency for the zip codec.
//
// Both mean this module stays pure: no Node built-ins, no I/O, no new dependency.

import { deflateSync, inflateSync } from "fflate";
import { field, readMessage, writeMessage, Writer, type RawField } from "./protobuf";

/**
 * `SCT` + a version byte, then a FLAG byte, then the body.
 *
 * The flag is a bit field, not a constant:
 *
 *   bit 0 (1)  this chunk OPENS a chunk set, so it carries the header frame (field 102).
 *              A continuation chunk has it clear and starts straight into item data.
 *   bit 1 (2)  this is a MEDIA chunk, and media chunks are NOT ENCRYPTED.
 *
 * Both were found the same way — by a chunk that would not open. Treating byte 4 as part of
 * a fixed header rejects every continuation chunk; treating every chunk as ciphertext
 * rejects every media chunk, because `(length - 5) % 16` is then rarely zero and the bytes
 * are not AES output at all.
 *
 * The media rule is not a guess. `ContentTransferController.GetChunkAsync` branches:
 *
 *     if (!chunk.IsMedia) await _streamService.EncryptAsync(memoryStream, chunkStream);
 *     else                await _streamService.CompressAsync(memoryStream, chunkStream);
 *
 * `CompressAsync` is raw deflate with no AES step, so a media chunk's body inflates
 * directly. (The `SCT` prefix itself appears in no Sitecore assembly — the byte sequence is
 * absent from every DLL we hold — so it is added in transit by the Marketplace gateway
 * rather than by the content-transfer service.)
 */
export const MAGIC = Uint8Array.from([0x53, 0x43, 0x54, 0x01]);
export const HEADER_LENGTH = MAGIC.length + 1;

/** This chunk opens a chunk set and carries the header frame. */
export const FLAG_OPENS_CHUNK_SET = 1;
/** This chunk carries media, and is therefore deflate-only — never encrypted. */
export const FLAG_MEDIA = 2;

const KEY = Uint8Array.from([186, 64, 211, 161, 189, 168, 143, 9, 137, 231, 62, 6, 76, 219, 170, 117]);
const IV = Uint8Array.from([216, 197, 238, 67, 114, 127, 227, 198, 88, 167, 125, 9, 91, 141, 126, 209]);

/** One length-prefixed protobuf frame, already parsed into fields. */
export type Frame = RawField[];

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("raif: Web Crypto is unavailable in this environment");
  return c.subtle;
}

async function aesKey(usage: KeyUsage): Promise<CryptoKey> {
  return subtle().importKey("raw", KEY as BufferSource, { name: "AES-CBC" }, false, [usage]);
}

/* ------------------------------------------------------------------ payload */

/** Split a decrypted, inflated payload into frames. */
export function readFrames(payload: Uint8Array): Frame[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: Frame[] = [];
  let at = 0;
  while (at + 4 <= payload.length) {
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > payload.length) throw new Error("raif: frame runs past the payload");
    out.push(readMessage(payload.subarray(at, at + length)));
    at += length;
  }
  if (at !== payload.length) throw new Error("raif: trailing bytes after the last frame");
  return out;
}

/** A media blob lifted out of a payload: its Sitecore blob id and its bytes. */
export interface RaifBlob {
  /** `BlobDataMarker.BlobId` — a STRING field, not a GUID message. */
  blobId: string;
  data: Uint8Array;
}

export interface RaifPayload {
  frames: Frame[];
  blobs: RaifBlob[];
}

/** `BlobDataMarker` arrives under this ProtoInclude number. */
const BLOB_MARKER = 101;

/**
 * Split a payload that may contain media, which `readFrames` cannot do.
 *
 * A blob does not arrive as a frame. `BlobWriter` writes its marker frame and then copies
 * the bytes straight into the stream:
 *
 *     Serializer.SerializeWithLengthPrefix<BlobDataMarker>(InnerStream, marker, Fixed32);
 *     ...
 *     InnerStream.CopyTo(stream);
 *     _blob.Blob.CopyTo(stream);          // raw, unprefixed, not protobuf
 *
 * So after a `101` marker there are exactly `Length` bytes that must be SKIPPED, not
 * parsed. Feeding them to `readFrames` reads the image's own bytes as a frame length and
 * desynchronises immediately.
 */
export function readPayload(payload: Uint8Array): RaifPayload {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const frames: Frame[] = [];
  const blobs: RaifBlob[] = [];
  let at = 0;

  while (at + 4 <= payload.length) {
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > payload.length) throw new Error("raif: frame runs past the payload");
    const frame = readMessage(payload.subarray(at, at + length));
    at += length;
    frames.push(frame);

    const marker = frame.find((f) => f.no === BLOB_MARKER);
    if (!marker || !(marker.value instanceof Uint8Array)) continue;

    // protobuf-net puts the BASE type's members at the top level and wraps only the derived
    // type's own members in the ProtoInclude field — the same shape `readDescriptor` relies
    // on for item markers. So `DataMarker.Length` is field 1 of the FRAME, while
    // `BlobDataMarker.BlobId` is field 3 inside the `101` wrapper. Reading Length from
    // inside the wrapper yields 0, which skips nothing and desynchronises on the next frame.
    const declared = Number(field(frame, 1)?.value ?? 0n);
    const idField = field(readMessage(marker.value), 3)?.value;
    if (at + declared > payload.length) {
      throw new Error("raif: blob runs past the payload");
    }
    blobs.push({
      blobId: idField instanceof Uint8Array ? new TextDecoder().decode(idField) : "",
      data: payload.subarray(at, at + declared),
    });
    at += declared;
  }

  if (at !== payload.length) throw new Error("raif: trailing bytes after the last frame");
  return { frames, blobs };
}

/** The inverse: frames back to a length-prefixed payload. */
export function writeFrames(frames: Frame[]): Uint8Array {
  const bodies = frames.map(writeMessage);
  const total = bodies.reduce((n, b) => n + 4 + b.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const body of bodies) {
    view.setUint32(at, body.length, true);
    at += 4;
    out.set(body, at);
    at += body.length;
  }
  return out;
}

/**
 * The marker frame that introduces a blob's bytes.
 *
 * Mirrors `BlobWriter`'s own construction:
 *
 *     new BlobDataMarker { Id = Guid.Empty, BlobId = blob.Id, Length = blob.Blob.Length }
 *
 * `Id` is left out rather than written as an empty GUID — protobuf-net skips a member whose
 * value is the type default, so omitting it is what a real marker looks like, and the reader
 * yields `Guid.Empty` either way.
 *
 * Field order follows `descriptorFrame` in core/raif/items: the ProtoInclude wrapper first,
 * then the base type's own members. protobuf is order-independent, but matching what
 * protobuf-net emits keeps an authored chunk byte-comparable with a pulled one.
 */
export function blobFrame(blob: RaifBlob): Frame {
  const w = new Writer();
  w.message(BLOB_MARKER, (m) => m.text(3, blob.blobId));
  w.varint(1, blob.data.length);
  return readMessage(w.finish());
}

/**
 * Frames and blobs back to a payload — the inverse of `readPayload`.
 *
 * Blobs are emitted after every frame rather than interleaved. The reader scans the whole
 * source and indexes each marker before a single item is written
 * (`ItemDataSourceExtensions.LoadSourceInfo`), so a blob is found wherever it sits; only the
 * header marker is position-sensitive, and that belongs to the caller's frame list.
 *
 * Note that this is not a byte-exact round trip of `readPayload`: a payload whose blobs were
 * interleaved between items comes back with them grouped at the end. Equivalent to the
 * reader, but not identical bytes.
 */
export function writePayload(frames: Frame[], blobs: RaifBlob[] = []): Uint8Array {
  const parts: Uint8Array[] = [writeFrames(frames)];
  for (const blob of blobs) {
    // The marker is length-prefixed like any frame; the bytes that follow are raw and
    // unprefixed, which is why `readFrames` cannot read a payload that contains one.
    parts.push(writeFrames([blobFrame(blob)]), blob.data);
  }

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/* ---------------------------------------------------------------- container */

function hasMagic(bytes: Uint8Array): boolean {
  return MAGIC.every((b, i) => bytes[i] === b);
}

/** The raw flag byte. */
export function chunkFlags(chunk: Uint8Array): number {
  if (!hasMagic(chunk)) throw new Error("raif: missing SCT header");
  return chunk[MAGIC.length];
}

/** True when this chunk opens a chunk set (and so carries the marker frame). */
export function opensChunkSet(chunk: Uint8Array): boolean {
  // Tested as a BIT, not for equality with 1: a media chunk that opens a set is 3.
  return (chunkFlags(chunk) & FLAG_OPENS_CHUNK_SET) !== 0;
}

/** True when this chunk carries media, and so is deflate-only rather than encrypted. */
export function isMediaChunk(chunk: Uint8Array): boolean {
  return (chunkFlags(chunk) & FLAG_MEDIA) !== 0;
}

/** Decrypt (unless this is media) and inflate a chunk, returning the raw payload bytes. */
export async function decodePayload(chunk: Uint8Array): Promise<Uint8Array> {
  const body = chunk.subarray(HEADER_LENGTH);

  // Media is compressed only. Running it through AES first is what produced
  // "ciphertext is not a non-zero multiple of 16 bytes" on a perfectly good 5 MB chunk.
  if (isMediaChunk(chunk)) return inflateSync(body);

  if (body.length === 0 || body.length % 16 !== 0) {
    // Sitecore's own reader rejects this case the same way; a truncated chunk is far more
    // likely than a real 0-byte payload.
    throw new Error("raif: ciphertext is not a non-zero multiple of 16 bytes");
  }
  const key = await aesKey("decrypt");
  const plain = await subtle().decrypt(
    { name: "AES-CBC", iv: IV as BufferSource },
    key,
    body as BufferSource,
  );
  return inflateSync(new Uint8Array(plain));
}

export interface EncodeOptions {
  /** Sets the chunk-set flag. Default true. */
  first?: boolean;
  /** Marks the chunk as media, which also means it is NOT encrypted. Default false. */
  media?: boolean;
}

/** Deflate — and encrypt, unless this is media — a payload into a chunk. */
export async function encodePayload(
  payload: Uint8Array,
  options: boolean | EncodeOptions = {},
): Promise<Uint8Array> {
  // The boolean form is the original signature, kept because `first` is what almost every
  // caller varies.
  const { first = true, media = false } =
    typeof options === "boolean" ? { first: options, media: false } : options;

  const compressed = deflateSync(payload, { level: 6 });
  let body = compressed;
  if (!media) {
    const key = await aesKey("encrypt");
    body = new Uint8Array(
      await subtle().encrypt(
        { name: "AES-CBC", iv: IV as BufferSource },
        key,
        compressed as BufferSource,
      ),
    );
  }

  const out = new Uint8Array(HEADER_LENGTH + body.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = (first ? FLAG_OPENS_CHUNK_SET : 0) | (media ? FLAG_MEDIA : 0);
  out.set(body, HEADER_LENGTH);
  return out;
}

export async function decodeChunk(chunk: Uint8Array): Promise<Frame[]> {
  return readFrames(await decodePayload(chunk));
}

export async function encodeChunk(frames: Frame[], first = true): Promise<Uint8Array> {
  return encodePayload(writeFrames(frames), first);
}
