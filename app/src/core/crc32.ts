// core/crc32 — standard zip CRC-32 (IEEE 802.3 polynomial 0xEDB88320).
//
// Implemented locally to honour the core/ rule "no Node built-ins" (no `zlib`/`crypto`).
// Pure: operates on Uint8Array only. Used when re-emitting freshly built zip entries.

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of `bytes`, returned as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
