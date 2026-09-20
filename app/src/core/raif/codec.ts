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
import { readMessage, writeMessage, type RawField } from "./protobuf";

/**
 * `SCT` + a version byte. Byte 4 is a flag, and byte 5 onwards is ciphertext.
 *
 * The flag is not a constant — across real chunks it is 1 on the chunk that opens a chunk
 * set and 0 on a continuation. It lines up exactly with the payload: a flag-1 chunk starts
 * with the 17-byte marker frame (field 102), a flag-0 chunk starts straight into item data
 * (field 100). Treating the fifth byte as part of a fixed header rejects every continuation
 * chunk, which is how this was found.
 */
export const MAGIC = Uint8Array.from([0x53, 0x43, 0x54, 0x01]);
export const HEADER_LENGTH = MAGIC.length + 1;

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

/* ---------------------------------------------------------------- container */

function hasMagic(bytes: Uint8Array): boolean {
  return MAGIC.every((b, i) => bytes[i] === b);
}

/** True when this chunk opens a chunk set (and so carries the marker frame). */
export function opensChunkSet(chunk: Uint8Array): boolean {
  if (!hasMagic(chunk)) throw new Error("raif: missing SCT header");
  return chunk[MAGIC.length] === 1;
}

/** Decrypt and inflate a chunk, returning the raw payload bytes. */
export async function decodePayload(chunk: Uint8Array): Promise<Uint8Array> {
  if (!hasMagic(chunk)) throw new Error("raif: missing SCT header");
  const ciphertext = chunk.subarray(HEADER_LENGTH);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    // Sitecore's own reader rejects this case the same way; a truncated chunk is far more
    // likely than a real 0-byte payload.
    throw new Error("raif: ciphertext is not a non-zero multiple of 16 bytes");
  }
  const key = await aesKey("decrypt");
  const plain = await subtle().decrypt(
    { name: "AES-CBC", iv: IV as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return inflateSync(new Uint8Array(plain));
}

/** Deflate and encrypt a payload into a chunk. `first` sets the chunk-set flag. */
export async function encodePayload(payload: Uint8Array, first = true): Promise<Uint8Array> {
  const compressed = deflateSync(payload, { level: 6 });
  const key = await aesKey("encrypt");
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-CBC", iv: IV as BufferSource },
      key,
      compressed as BufferSource,
    ),
  );
  const out = new Uint8Array(HEADER_LENGTH + ciphertext.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = first ? 1 : 0;
  out.set(ciphertext, HEADER_LENGTH);
  return out;
}

export async function decodeChunk(chunk: Uint8Array): Promise<Frame[]> {
  return readFrames(await decodePayload(chunk));
}

export async function encodeChunk(frames: Frame[], first = true): Promise<Uint8Array> {
  return encodePayload(writeFrames(frames), first);
}
