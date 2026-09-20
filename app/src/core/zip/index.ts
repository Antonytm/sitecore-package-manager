// core/zip — single-layer ZIP read/write with byte-faithful round-trip.
//
// Classic Sitecore packages are a zip whose payload `package.zip` is itself a zip
// (see wiki/articles/package-format.md). To reproduce a package byte-for-byte we cannot
// recompress: cross-implementation DEFLATE is not canonical, so re-deflating the .NET
// writer's entries would change the bytes. Instead the reader PRESERVES each entry's raw
// record (the exact local-header+payload bytes and the exact central-directory bytes),
// and the writer REPLAYS them verbatim. Result: writeZip(readZip(b)) === b.
//
// Entries whose `data` was modified (and had their `raw` provenance cleared) are rebuilt
// from structured fields and re-deflated — byte-identity is NOT promised for those, only
// for unchanged entries. See app/src/ARCHITECTURE.md.

import { inflateSync, deflateSync } from "fflate";
import { crc32 } from "../crc32";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Everything needed to re-emit one zip entry byte-for-byte. */
export interface RawZipRecord {
  versionMadeBy: number;
  versionNeeded: number;
  gpFlags: number;
  method: number; // 0 = stored, 8 = deflate
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  internalAttrs: number;
  externalAttrs: number;
  diskStart: number;
  nameBytes: Uint8Array;
  extraLocal: Uint8Array;
  extraCentral: Uint8Array;
  comment: Uint8Array;
  /** Raw (still-compressed) payload bytes. */
  compressed: Uint8Array;
  /** Verbatim local header + payload bytes (self-contained; offset-independent). */
  localChunk: Uint8Array;
  /** Verbatim central-directory record bytes (encodes the original local-header offset). */
  centralChunk: Uint8Array;
}

export interface ZipEntry {
  name: string;
  /** Decompressed content — the view the serializers work on. */
  data: Uint8Array;
  /**
   * Provenance from the source zip. Present ⇒ this entry can be replayed byte-for-byte.
   * Clear this (set to undefined) when you mutate `data`, to force a rebuild on write.
   */
  raw?: RawZipRecord;
}

/** A parsed single-layer zip: ordered entries plus the file-level framing bytes. */
export interface ZipArchive {
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  /** Bytes before the first local header (self-extracting stub etc.); normally empty. */
  prefix: Uint8Array;
  /** Raw End-Of-Central-Directory record (including any zip comment). */
  eocd: Uint8Array;
}

// ── little-endian helpers ─────────────────────────────────────────────────────

function u16(dv: DataView, o: number): number {
  return dv.getUint16(o, true);
}
function u32(dv: DataView, o: number): number {
  return dv.getUint32(o, true);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ── read ──────────────────────────────────────────────────────────────────────

function findEocd(bytes: Uint8Array, dv: DataView): number {
  // EOCD is 22 bytes + comment; scan backwards from the latest possible position.
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(dv, i) === SIG_EOCD) return i;
  }
  throw new Error("readZip: End-Of-Central-Directory signature not found");
}

/** Parse a single-layer zip, preserving raw records for byte-faithful rewrite. */
export function readZip(bytes: Uint8Array): ZipArchive {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOff = findEocd(bytes, dv);

  const total = u16(dv, eocdOff + 10);
  const cdOff = u32(dv, eocdOff + 16);

  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();

  let p = cdOff;
  let minLocalOff = Infinity;
  for (let i = 0; i < total; i++) {
    if (u32(dv, p) !== SIG_CENTRAL) {
      throw new Error(`readZip: bad central-directory signature at ${p}`);
    }
    const versionMadeBy = u16(dv, p + 4);
    const versionNeeded = u16(dv, p + 6);
    const gpFlags = u16(dv, p + 8);
    const method = u16(dv, p + 10);
    const dosTime = u16(dv, p + 12);
    const dosDate = u16(dv, p + 14);
    const recCrc = u32(dv, p + 16);
    const compressedSize = u32(dv, p + 20);
    const uncompressedSize = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const diskStart = u16(dv, p + 34);
    const internalAttrs = u16(dv, p + 36);
    const externalAttrs = u32(dv, p + 38);
    const localOff = u32(dv, p + 42);

    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const extraCentral = bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const comment = bytes.subarray(
      p + 46 + nameLen + extraLen,
      p + 46 + nameLen + extraLen + commentLen,
    );
    const centralChunk = bytes.subarray(p, p + 46 + nameLen + extraLen + commentLen);
    const name = new TextDecoder().decode(nameBytes);

    // Local header (gp bit 3 / data descriptors are not used by the Sitecore writer; we
    // assert that so a surprise package fails loudly rather than corrupting silently).
    if (u32(dv, localOff) !== SIG_LOCAL) {
      throw new Error(`readZip: bad local-header signature for ${name}`);
    }
    if (gpFlags & 0x08) {
      throw new Error(`readZip: data descriptors (gp bit 3) unsupported for ${name}`);
    }
    const lNameLen = u16(dv, localOff + 26);
    const lExtraLen = u16(dv, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const extraLocal = bytes.subarray(localOff + 30 + lNameLen, dataStart);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const localChunk = bytes.subarray(localOff, dataStart + compressedSize);

    const data =
      method === METHOD_STORE
        ? compressed.slice()
        : inflateSync(compressed);

    const raw: RawZipRecord = {
      versionMadeBy,
      versionNeeded,
      gpFlags,
      method,
      dosTime,
      dosDate,
      crc32: recCrc,
      compressedSize,
      uncompressedSize,
      internalAttrs,
      externalAttrs,
      diskStart,
      nameBytes: nameBytes.slice(),
      extraLocal: extraLocal.slice(),
      extraCentral: extraCentral.slice(),
      comment: comment.slice(),
      compressed: compressed.slice(),
      localChunk: localChunk.slice(),
      centralChunk: centralChunk.slice(),
    };
    const entry: ZipEntry = { name, data, raw };
    entries.push(entry);
    byName.set(name, entry);
    if (localOff < minLocalOff) minLocalOff = localOff;

    p += 46 + nameLen + extraLen + commentLen;
  }

  const prefix =
    entries.length === 0 ? new Uint8Array(0) : bytes.subarray(0, minLocalOff).slice();
  const eocd = bytes.subarray(eocdOff).slice();

  return { entries, byName, prefix, eocd };
}

// ── write ─────────────────────────────────────────────────────────────────────

/** Build a fresh local header + payload for an entry lacking raw provenance. */
function buildEntry(entry: ZipEntry): { local: Uint8Array; record: BuiltRecord } {
  const nameBytes = new TextEncoder().encode(entry.name);
  const uncompressed = entry.data;
  const crc = crc32(uncompressed);
  // Match the Sitecore writer's choice: deflate, but store when that is not smaller.
  let method = METHOD_DEFLATE;
  let payload: Uint8Array = deflateSync(uncompressed, { level: 6 });
  if (payload.length >= uncompressed.length) {
    method = METHOD_STORE;
    payload = uncompressed;
  }
  const header = new Uint8Array(30 + nameBytes.length);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, SIG_LOCAL, true);
  dv.setUint16(4, method === METHOD_STORE ? 10 : 20, true); // version needed
  dv.setUint16(6, 0x0800, true); // gp flags: UTF-8 names
  dv.setUint16(8, method, true);
  dv.setUint16(10, 0, true); // dos time
  dv.setUint16(12, 0x21, true); // dos date (1980-01-01)
  dv.setUint32(14, crc, true);
  dv.setUint32(18, payload.length, true);
  dv.setUint32(22, uncompressed.length, true);
  dv.setUint16(26, nameBytes.length, true);
  dv.setUint16(28, 0, true); // extra length
  header.set(nameBytes, 30);
  return {
    local: concat([header, payload]),
    record: {
      method,
      crc,
      compressedSize: payload.length,
      uncompressedSize: uncompressed.length,
      nameBytes,
      versionNeeded: method === METHOD_STORE ? 10 : 20,
      dosTime: 0,
      dosDate: 0x21,
    },
  };
}

interface BuiltRecord {
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  nameBytes: Uint8Array;
  versionNeeded: number;
  dosTime: number;
  dosDate: number;
}

function buildCentral(
  entry: ZipEntry,
  rec: BuiltRecord,
  localOffset: number,
): Uint8Array {
  const r = entry.raw;
  const head = new Uint8Array(46 + rec.nameBytes.length);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, SIG_CENTRAL, true);
  dv.setUint16(4, r?.versionMadeBy ?? 0x0033, true);
  dv.setUint16(6, rec.versionNeeded, true);
  dv.setUint16(8, 0x0800, true);
  dv.setUint16(10, rec.method, true);
  dv.setUint16(12, rec.dosTime, true);
  dv.setUint16(14, rec.dosDate, true);
  dv.setUint32(16, rec.crc, true);
  dv.setUint32(20, rec.compressedSize, true);
  dv.setUint32(24, rec.uncompressedSize, true);
  dv.setUint16(28, rec.nameBytes.length, true);
  dv.setUint16(30, 0, true); // extra
  dv.setUint16(32, 0, true); // comment
  dv.setUint16(34, 0, true); // disk start
  dv.setUint16(36, r?.internalAttrs ?? 0, true);
  dv.setUint32(38, r?.externalAttrs ?? 0, true);
  dv.setUint32(42, localOffset, true);
  head.set(rec.nameBytes, 46);
  return head;
}

/** The end-of-central-directory record stores the entry count in 16 bits. */
export const ZIP_MAX_ENTRIES = 0xffff;

function buildEocd(count: number, cdOffset: number, cdSize: number): Uint8Array {
  if (count > ZIP_MAX_ENTRIES) {
    // setUint16 would truncate mod 65536 and silently emit a corrupt archive. There is no
    // ZIP64 support in this codec, so refuse rather than produce an unreadable package.
    throw new Error(
      "writeZip: " + count + " entries exceeds the " + ZIP_MAX_ENTRIES + "-entry zip limit",
    );
  }
  const e = new Uint8Array(22);
  const dv = new DataView(e.buffer);
  dv.setUint32(0, SIG_EOCD, true);
  dv.setUint16(8, count, true);
  dv.setUint16(10, count, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdOffset, true);
  return e;
}

/**
 * Serialize a {@link ZipArchive} back to bytes.
 *
 * Fast path — when every entry still carries its `raw` provenance, the original local
 * chunks, central-directory records and EOCD are replayed verbatim ⇒ byte-identical to
 * the source. Otherwise the archive is rebuilt from structured fields (offsets recomputed,
 * provenance-less entries re-deflated); valid, but not promised byte-identical.
 */
export function writeZip(archive: ZipArchive): Uint8Array {
  // `every` on an empty array is true, which would take the fast path and emit
  // prefix + eocd — zero bytes for a from-scratch archive that simply has no entries yet.
  const allFaithful = archive.entries.length > 0 && archive.entries.every((e) => e.raw);
  if (allFaithful) {
    const locals = archive.entries.map((e) => e.raw!.localChunk);
    const centrals = archive.entries.map((e) => e.raw!.centralChunk);
    return concat([archive.prefix, ...locals, ...centrals, archive.eocd]);
  }

  // Rebuild path: recompute offsets so central records stay consistent.
  const localParts: Uint8Array[] = [archive.prefix];
  const builtRecords: BuiltRecord[] = [];
  const offsets: number[] = [];
  let offset = archive.prefix.length;
  for (const entry of archive.entries) {
    offsets.push(offset);
    if (entry.raw) {
      localParts.push(entry.raw.localChunk);
      builtRecords.push({
        method: entry.raw.method,
        crc: entry.raw.crc32,
        compressedSize: entry.raw.compressedSize,
        uncompressedSize: entry.raw.uncompressedSize,
        nameBytes: entry.raw.nameBytes,
        versionNeeded: entry.raw.versionNeeded,
        dosTime: entry.raw.dosTime,
        dosDate: entry.raw.dosDate,
      });
      offset += entry.raw.localChunk.length;
    } else {
      const { local, record } = buildEntry(entry);
      localParts.push(local);
      builtRecords.push(record);
      offset += local.length;
    }
  }

  const cdOffset = offset;
  const centralParts: Uint8Array[] = [];
  let cdSize = 0;
  for (let i = 0; i < archive.entries.length; i++) {
    const central = buildCentral(archive.entries[i], builtRecords[i], offsets[i]);
    centralParts.push(central);
    cdSize += central.length;
  }

  const eocd = buildEocd(archive.entries.length, cdOffset, cdSize);
  return concat([...localParts, ...centralParts, eocd]);
}
