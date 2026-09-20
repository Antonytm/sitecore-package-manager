// core/properties — the properties/items/.../xml side-car.  (bytes <-> key/value)
//
// Each item-version entry has a parallel side-car carrying install metadata
// (wiki/articles/item-serialization.md): UTF-8 WITH BOM, CRLF line endings, one
// `key=value` per line, e.g.
//
//   database=master
//   id={...}
//   language=en
//   version=1
//   revision=...
//   fieldproperties={id}:Shared|{id}:Versioned|...
//
// Faithful (byte-identical) codec: we keep the BOM flag, the ordered key/value pairs as
// RAW strings, and whether a trailing CRLF is present, so serialize(parse(b)) === b.

import type { Sharing } from "./model";

const BOM0 = 0xef;
const BOM1 = 0xbb;
const BOM2 = 0xbf;
const CRLF = "\r\n";

export interface RawProperties {
  bom: boolean;
  pairs: Array<{ key: string; value: string }>;
  trailingCrlf: boolean;
}

export function parseProperties(bytes: Uint8Array): RawProperties {
  const bom =
    bytes.length >= 3 && bytes[0] === BOM0 && bytes[1] === BOM1 && bytes[2] === BOM2;
  const body = bom ? bytes.subarray(3) : bytes;
  const text = new TextDecoder("utf-8").decode(body);
  const trailingCrlf = text.endsWith(CRLF);
  const trimmed = trailingCrlf ? text.slice(0, -CRLF.length) : text;
  const pairs =
    trimmed.length === 0
      ? []
      : trimmed.split(CRLF).map((line) => {
          const eq = line.indexOf("=");
          return eq === -1
            ? { key: line, value: "" }
            : { key: line.slice(0, eq), value: line.slice(eq + 1) };
        });
  return { bom, pairs, trailingCrlf };
}

export function serializeProperties(p: RawProperties): Uint8Array {
  const text =
    p.pairs.map((kv) => kv.key + "=" + kv.value).join(CRLF) +
    (p.trailingCrlf ? CRLF : "");
  const body = new TextEncoder().encode(text);
  if (!p.bom) return body;
  const out = new Uint8Array(3 + body.length);
  out[0] = BOM0;
  out[1] = BOM1;
  out[2] = BOM2;
  out.set(body, 3);
  return out;
}

/** Look up a single property value by key (raw, undecoded). */
export function getProperty(p: RawProperties, key: string): string | undefined {
  return p.pairs.find((kv) => kv.key === key)?.value;
}

/** Field sharing as recorded in `fieldproperties`. Declared in model.ts so the semantic
 * model can name it without importing this codec; re-exported here for existing callers. */
export type { Sharing } from "./model";

/** Parse `fieldproperties` ("{id}:Shared|{id}:Versioned|...") into id → sharing. */
export function parseFieldSharing(p: RawProperties): Map<string, Sharing> {
  const raw = getProperty(p, "fieldproperties") ?? "";
  const map = new Map<string, Sharing>();
  for (const token of raw.split("|")) {
    if (!token) continue;
    const colon = token.lastIndexOf(":");
    if (colon === -1) continue;
    map.set(token.slice(0, colon), token.slice(colon + 1) as Sharing);
  }
  return map;
}
