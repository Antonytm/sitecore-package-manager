// core/raif/guid — the braced GUID strings our model uses <-> the 16 bytes .NET writes.
//
// A .NET `Guid.ToByteArray()` is NOT the textual order: the first three groups are stored
// little-endian and the last eight bytes verbatim. Inside a .raif frame a GUID arrives as a
// nested message of two fixed64 fields, which concatenate to exactly those 16 bytes:
//
//   {63A7026A-15DC-469C-BBBB-66F256ED0080}
//    \__Data1__/ \D2_/ \D3_/ \______Data4______/
//   f1 = 6A 02 A7 63  DC 15  9C 46      (Data1, Data2, Data3 — byte-swapped)
//   f2 = BB BB 66 F2 56 ED 00 80        (Data4 — as written)
//
// Getting this backwards yields a GUID that looks plausible and points at nothing, so the
// halves are asserted against a real tenant value in the tests.

import type { Guid } from "../model";

const HEX = /^[0-9a-fA-F]{32}$/;

/** Strip braces/dashes and validate. Accepts `{A-B-C}`, `A-B-C` or bare hex. */
function normalize(guid: string): string {
  const hex = guid.replace(/[{}-]/g, "");
  if (!HEX.test(hex)) throw new Error("raif: not a GUID: " + guid);
  return hex.toLowerCase();
}

/** `{GUID}` -> the 16 bytes .NET stores, in .NET's mixed-endian order. */
export function guidToBytes(guid: string): Uint8Array {
  const hex = normalize(guid);
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  const out = new Uint8Array(16);
  // Data1 (4 bytes) and Data2/Data3 (2 bytes each) are byte-swapped; Data4 is verbatim.
  out[0] = b[3]; out[1] = b[2]; out[2] = b[1]; out[3] = b[0];
  out[4] = b[5]; out[5] = b[4];
  out[6] = b[7]; out[7] = b[6];
  out.set(b.subarray(8), 8);
  return out;
}

/** The inverse: 16 .NET-ordered bytes -> `{UPPERCASE-GUID}`. */
export function bytesToGuid(bytes: Uint8Array): Guid {
  if (bytes.length !== 16) throw new Error("raif: a GUID is 16 bytes, got " + bytes.length);

  const b = new Uint8Array(16);
  b[0] = bytes[3]; b[1] = bytes[2]; b[2] = bytes[1]; b[3] = bytes[0];
  b[4] = bytes[5]; b[5] = bytes[4];
  b[6] = bytes[7]; b[7] = bytes[6];
  b.set(bytes.subarray(8), 8);

  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return (
    "{" +
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) +
    "-" + hex.slice(16, 20) + "-" + hex.slice(20) +
    "}"
  ).toUpperCase();
}

/** The zero GUID, which the format uses where our model uses `undefined`. */
export const ZERO_GUID: Guid = "{00000000-0000-0000-0000-000000000000}";

export function isZeroGuid(guid: string | undefined): boolean {
  return guid === undefined || normalize(guid) === "0".repeat(32);
}
