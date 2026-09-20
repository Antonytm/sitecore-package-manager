// core/raif/items — ItemModel <-> the frame pairs a .raif payload carries.
//
// Structure, measured across 300 real items rather than inferred:
//
//   frame 0        { 102: { 4: { 2: 1, 3: ticks } } }      chunk-set marker, once
//   then per item, a PAIR of frames:
//     descriptor   { 100: { 3: {...} }, 1: forwardLength, 2: itemId }
//     values       { 1: fieldValue } * N
//
//   descriptor 100.3    1 itemId   2 name   3 parentId   4 templateId
//                       5 masterId (OPTIONAL — present on 261 of 300)   6 created ticks
//   field value         1 fieldId  2 value  3 version    4 language
//
// Two rules that are easy to get wrong and impossible to notice afterwards:
//
//   - `descriptor.1` is a FORWARD POINTER: the byte length of the following values frame
//     *including* its own 4-byte length prefix. A reader seeks with it, so a wrong value
//     desynchronises the whole payload rather than failing loudly.
//   - Sharing is encoded in the (version, language) pair, not a flag:
//         version -1, language ""    -> Shared
//         version -1, language "en"  -> Unversioned
//         version  N, language "en"  -> Versioned
//     All three appear in the samples (801 / 150 / 2300).

import type { FieldModel, Guid, ItemModel, Sharing } from "../model";
import type { Frame } from "./codec";
import { bytesToGuid, guidToBytes, ZERO_GUID } from "./guid";
import {
  asBytes,
  asNumber,
  asText,
  field,
  fields,
  readMessage,
  Writer,
  type RawField,
} from "./protobuf";

const MARKER = 102;
const DESCRIPTOR = 100;
/** The format's "not versioned" sentinel: a 64-bit -1. */
const NO_VERSION = 0xffffffffffffffffn;

/* -------------------------------------------------------------------- ticks */

/** .NET ticks are 100ns units since 0001-01-01; Unix epoch is this many seconds in. */
const EPOCH_SECONDS = 62135596800n;

export function ticksToDate(ticks: bigint): Date {
  return new Date(Number(ticks / 10000n - EPOCH_SECONDS * 1000n));
}

export function dateToTicks(date: Date): bigint {
  return (BigInt(date.getTime()) + EPOCH_SECONDS * 1000n) * 10000n;
}

/** The `yyyyMMddTHHmmssZ` form the package format and `__Created` use. */
export function ticksToSitecoreDate(ticks: bigint): string {
  const iso = ticksToDate(ticks).toISOString();
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + "T" +
    iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + "Z";
}

export function sitecoreDateToTicks(value: string | undefined): bigint {
  const m = value?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return dateToTicks(new Date());
  const [, y, mo, d, h, mi, s] = m;
  return dateToTicks(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)));
}

/* ------------------------------------------------------------------ reading */

function guidAt(f: RawField | undefined): Guid | undefined {
  const bytes = asBytes(f);
  if (!bytes) return undefined;
  // A GUID is a nested message of two fixed64 halves that concatenate to the 16 .NET bytes.
  const halves = readMessage(bytes);
  const lo = asBytes(field(halves, 1));
  const hi = asBytes(field(halves, 2));
  if (!lo || !hi) return undefined;
  const all = new Uint8Array(16);
  all.set(lo, 0);
  all.set(hi, 8);
  return bytesToGuid(all);
}

function guidField(w: Writer, no: number, guid: Guid): void {
  const bytes = guidToBytes(guid);
  w.message(no, (inner) => {
    inner.fixed64(1, bytes.subarray(0, 8));
    inner.fixed64(2, bytes.subarray(8, 16));
  });
}

export interface RaifDescriptor {
  id: Guid;
  name: string;
  parentId: Guid;
  templateId: Guid;
  masterId?: Guid;
  createdTicks: bigint;
}

export interface RaifFieldValue {
  id: Guid;
  value: string;
  version: bigint;
  language: string;
}

export function readDescriptor(frame: Frame): RaifDescriptor | undefined {
  const outer = asBytes(field(frame, DESCRIPTOR));
  if (!outer) return undefined;
  const body = asBytes(field(readMessage(outer), 3));
  if (!body) return undefined;
  const d = readMessage(body);

  const id = guidAt(field(d, 1));
  const parentId = guidAt(field(d, 3));
  const templateId = guidAt(field(d, 4));
  if (!id || !parentId || !templateId) return undefined;

  return {
    id,
    name: asText(field(d, 2)) ?? "",
    parentId,
    templateId,
    masterId: guidAt(field(d, 5)),
    createdTicks: asNumber(field(d, 6)) ?? 0n,
  };
}

export function readFieldValues(frame: Frame): RaifFieldValue[] {
  const out: RaifFieldValue[] = [];
  for (const f of fields(frame, 1)) {
    const bytes = asBytes(f);
    if (!bytes) continue;
    const v = readMessage(bytes);
    const id = guidAt(field(v, 1));
    if (!id) continue;
    out.push({
      id,
      value: asText(field(v, 2)) ?? "",
      version: asNumber(field(v, 3)) ?? NO_VERSION,
      language: asText(field(v, 4)) ?? "",
    });
  }
  return out;
}

export function sharingOf(v: RaifFieldValue): Sharing {
  if (v.version !== NO_VERSION) return "Versioned";
  return v.language === "" ? "Shared" : "Unversioned";
}

/** Rebuild `ItemModel`s from a decoded payload. Ignores the marker frame. */
export function framesToItems(frames: Frame[]): ItemModel[] {
  const items: ItemModel[] = [];
  for (let i = 0; i < frames.length; i++) {
    const descriptor = readDescriptor(frames[i]);
    if (!descriptor) continue; // marker frame, or a values frame already consumed
    const values = i + 1 < frames.length ? readFieldValues(frames[i + 1]) : [];
    i++;

    const item: ItemModel = {
      id: descriptor.id,
      name: descriptor.name,
      // The format stores no path; callers that need one resolve it from parentId.
      path: "",
      templateId: descriptor.templateId,
      parentId: descriptor.parentId,
      masterId: descriptor.masterId,
      created: ticksToSitecoreDate(descriptor.createdTicks),
      sharedFields: [],
      languages: [],
    };

    const languageOf = (code: string) => {
      let lang = item.languages.find((l) => l.language === code);
      if (!lang) {
        lang = { language: code, unversionedFields: [], versions: [] };
        item.languages.push(lang);
      }
      return lang;
    };

    for (const v of values) {
      const model: FieldModel = { id: v.id, value: v.value, sharing: sharingOf(v) };
      if (model.sharing === "Shared") {
        item.sharedFields.push(model);
      } else if (model.sharing === "Unversioned") {
        languageOf(v.language).unversionedFields.push(model);
      } else {
        const lang = languageOf(v.language);
        const number = Number(v.version);
        let version = lang.versions.find((x) => x.version === number);
        if (!version) {
          version = { version: number, fields: [] };
          lang.versions.push(version);
        }
        version.fields.push(model);
      }
    }

    items.push(item);
  }
  return items;
}

/* ------------------------------------------------------------------ writing */

/** The chunk-set marker frame that opens a chunk set. */
export function markerFrame(now = new Date()): Frame {
  const w = new Writer();
  w.message(MARKER, (m) =>
    m.message(4, (inner) => {
      inner.varint(2, 1);
      inner.varint(3, dateToTicks(now));
    }),
  );
  return readMessage(w.finish());
}

function valuesFrame(item: ItemModel): Frame {
  const w = new Writer();
  const emit = (f: FieldModel, version: bigint, language: string) => {
    w.message(1, (v) => {
      guidField(v, 1, f.id);
      v.text(2, f.value);
      v.varint(3, version);
      v.text(4, language);
    });
  };

  // Shared, then unversioned, then versioned — the dominant order in real payloads.
  for (const f of item.sharedFields) emit(f, NO_VERSION, "");
  for (const lang of item.languages) {
    for (const f of lang.unversionedFields) emit(f, NO_VERSION, lang.language);
  }
  for (const lang of item.languages) {
    for (const version of lang.versions) {
      for (const f of version.fields) emit(f, BigInt(version.version), lang.language);
    }
  }
  return readMessage(w.finish());
}

function descriptorFrame(item: ItemModel, forwardLength: number): Frame {
  const w = new Writer();
  w.message(DESCRIPTOR, (outer) =>
    outer.message(3, (d) => {
      guidField(d, 1, item.id);
      d.text(2, item.name);
      guidField(d, 3, item.parentId);
      guidField(d, 4, item.templateId);
      // Only written when the item actually has one — 39 of 300 real items omit it.
      if (item.masterId && item.masterId !== ZERO_GUID) guidField(d, 5, item.masterId);
      d.varint(6, sitecoreDateToTicks(item.created));
    }),
  );
  w.varint(1, forwardLength);
  guidField(w, 2, item.id);
  return readMessage(w.finish());
}

/** `ItemModel[]` -> frames, marker first. */
export function itemsToFrames(items: ItemModel[], now = new Date()): Frame[] {
  const out: Frame[] = [markerFrame(now)];
  for (const item of items) {
    const values = valuesFrame(item);
    // The forward pointer counts the values frame *plus* its own 4-byte length prefix, so
    // it has to be measured after encoding and before the descriptor is built.
    const length = frameLength(values) + 4;
    out.push(descriptorFrame(item, length), values);
  }
  return out;
}

/** Encoded byte length of a frame body (without its length prefix). */
export function frameLength(frame: Frame): number {
  let n = 0;
  for (const f of frame) {
    const w = new Writer();
    if (f.wire === 0) w.varint(f.no, f.value as bigint);
    else if (f.wire === 1) w.fixed64(f.no, f.value as Uint8Array);
    else if (f.wire === 5) w.fixed32(f.no, f.value as Uint8Array);
    else w.bytes(f.no, f.value as Uint8Array);
    n += w.finish().length;
  }
  return n;
}
