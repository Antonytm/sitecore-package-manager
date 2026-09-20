# RAIF Chunk Container (`.raif`)

The outer envelope of a Sitecore **content-transfer** chunk — the binary format XM Cloud moves
items in, and the only format that can write an item at a chosen GUID on SitecoreAI. This
article covers the bytes around the payload; the payload's own grammar is
[[raif-frame-grammar]], the HTTP surface is [[content-transfer-api]], and using the two together
to install a package is [[content-transfer-install]].

Everything here is measured against three real chunks pulled from a live XM Cloud environment
(`files/samples/raif/`) and cross-checked against the decompiled
`Sitecore.ContentTransfer.Data.Core.Services.StreamService` and
`Sitecore.Data.ItemsTransfer.Reading.ProtoStreamReader`.

## Layout

```
byte 0   1   2   3   4          5 .. end
     'S' 'C' 'T' 01  <flag>     AES-128-CBC( raw-DEFLATE( payload ) ), PKCS#7
     53  43  54  01                                   ← ciphertext, whole 16-byte blocks

payload = repeated { uint32-LE length, protobuf frame }
```

Three layers, unwrapped in this order: strip 5 bytes, decrypt, inflate. What comes out is a flat
sequence of length-prefixed protobuf frames.

### Bytes 0–3 — magic and version

`53 43 54` is ASCII `SCT` (**S**itecore **C**ontent **T**ransfer). Byte 3 is `01` in every chunk
we have. It behaves like a format version, but since no second value has ever been observed that
reading is an assumption, not a measurement.

### Byte 4 — the chunk-set flag ★

**Byte 4 is a flag, not part of a fixed header.** It is `1` on the chunk that opens a chunk set
and `0` on a continuation, and it lines up exactly with the payload:

| Flag | Payload starts with | Meaning |
|------|---------------------|---------|
| `1` | the header frame (field `102`) | opens a chunk set |
| `0` | straight into item data (field `100`) | continuation |

This is the single most expensive thing to get wrong, and it is invisible with one sample.
Treating all five bytes as a constant header parses the opener perfectly and **rejects every
continuation chunk**. Our two-chunk export is the only reason it was found:
`_sitecore_content-0.raif` carries `flag=1` and a header frame, `_sitecore_content-1.raif`
carries `flag=0` and none.

### Bytes 5+ — the ciphertext

**AES-128-CBC, PKCS#7 padding**, with a fixed key and IV:

```
key  BA 40 D3 A1 BD A8 8F 09 89 E7 3E 06 4C DB AA 75
iv   D8 C5 EE 43 72 7F E3 C6 58 A7 7D 09 5B 8D 7E D1
```

Both are **compiled into** `Sitecore.ContentTransfer.Data.Core.Services.StreamService` as literal
byte arrays (`_key` / `_iv`, used by `EncryptAsync` / `DecryptAsync`). They are therefore
identical on every Sitecore environment, and that single fact is what makes a chunk **authorable**
rather than merely readable — see [[content-transfer-install]].

> **This is obfuscation, not confidentiality.** A fixed key and a fixed IV shipped in a public
> assembly encrypt nothing meaningfully; the same plaintext always produces the same ciphertext.
> Treat a `.raif` as readable by anyone who has it, and do not put anything in one you would not
> put in a `.zip`.

The ciphertext must be a non-zero whole number of 16-byte blocks. Sitecore's own reader validates
this (`ValidateCiphertextLength`) and so does ours — a truncated chunk is far likelier than a
genuinely empty payload.

### Compression — raw DEFLATE

The plaintext is **raw DEFLATE with no zlib or gzip wrapper** (`System.IO.Compression.DeflateStream`
on Sitecore's side; window bits `-15` for anything that speaks zlib). There is no length field,
no checksum and no framing around it: inflate until the stream ends.

## Framing

The inflated payload is a flat run of frames, each one a **little-endian `uint32` byte count**
followed by that many bytes of protobuf:

```
[ 04 00 00 00 ][ 11 bytes… ]  [ 2A 01 00 00 ][ 298 bytes… ]  …
  └ length ┘    └ frame ┘
```

This is not our invention — it is protobuf-net's `PrefixStyle.Fixed32`. `ProtoStreamReader.Read<T>`
is literally `Serializer.DeserializeWithLengthPrefix<T>(stream, PrefixStyle.Fixed32)`.

There is no frame count and no terminator. The payload ends when the bytes end, so trailing bytes
after the last complete frame mean a corrupt chunk, not an empty tail.

## Chunk boundaries

Chunks are not split arbitrarily. `Sitecore.ContentTransfer.Data.Pull.Services.ChunkStorage`
partitions a chunk set by two constants:

| Constant | Value | Applies to |
|---|---|---|
| `_itemsPerChunk` | **300** | non-media items |
| `_chunkSizeLimit` | **104,857,600** (100 MB) | media items, by cumulative `Size` field |

Items are grouped by `Item.Paths.IsMediaItem` first, so **media and non-media never share a
chunk**; the resulting chunks are flagged `IsMedia` accordingly ([[content-transfer-api]]).
This is exactly why our 330-item export came back as 300 + 30: one full chunk and a remainder,
both non-media.

A chunk set is also created **per merge strategy** — `PullService.SaveChunkSets` groups the
requested `DataTree`s by `MergeStrategy` and mints one chunk set for each group.

## Writing a chunk

Encoding is the same three layers inverted: build the frames, prefix each with its `uint32-LE`
length, deflate, encrypt, prepend `53 43 54 01` and the flag.

**Deflate output is not canonical across implementations**, so a chunk we encode will not be
byte-identical to Sitecore's even from identical input — the compressed bytes differ while the
data does not. That is the same limitation the classic package codec has ([[package-creation]]),
and it shapes how the format is tested: our acceptance oracle decodes a real chunk, re-encodes
it, and asserts the **decrypted, inflated payload** matches. The container is never compared.

That one assertion pins the header, the AES parameters, the framing, the varint encoding and
every protobuf field number at once — if any were wrong, the payload would differ or the second
decode would throw.

## SitecoreAI implementation notes

- `app/src/core/raif/codec.ts` is this article in code: `MAGIC`, `HEADER_LENGTH`, `opensChunkSet`,
  `readFrames`/`writeFrames`, `decodeChunk`/`encodeChunk`.
- It stays inside our `core/` purity rules because **AES-CBC comes from Web Crypto**
  (`crypto.subtle`) and **raw DEFLATE from `fflate`**, which the zip codec already depends on. No
  new dependency, no Node built-ins, no I/O.
- `encodeChunk(frames, first)` takes the flag explicitly. We currently write single-chunk
  transfers, so it is always `1` — but a multi-chunk push must set `0` on every continuation.
- **The hardcoded key is a silent-failure risk.** If Sitecore ever rotates it, our chunks would be
  written with the old key and rejected with no useful diagnosis. The mitigation is to decode a
  freshly-pulled chunk before trusting the encoder ([[content-transfer-install]]).

## Sources

- Real chunks pulled from a live XM Cloud environment: `files/samples/raif/{_sitecore_content-0,_sitecore_content-1,_sitecore_content_test-0}.raif` plus `_notes.json` and `decode.py` (primary ground truth — the flag byte, the frame counts and the 300/30 split are all read off these bytes), 2026-09-20.
- Decompiled `Sitecore.ContentTransfer.Data.Core.Services.StreamService` (key, IV, `EncryptAsync`/`DecryptAsync`/`CompressAsync`, `ValidateCiphertextLength`), `Sitecore.Data.ItemsTransfer.Reading.ProtoStreamReader` (`PrefixStyle.Fixed32` framing), `Sitecore.ContentTransfer.Data.Pull.Services.{ChunkStorage,PullService}` (`_itemsPerChunk`, `_chunkSizeLimit`, per-strategy chunk sets), 2026-09-20.
- Our implementation and its round-trip oracle: `app/src/core/raif/codec.ts`, `app/src/core/raif/__tests__/codec.test.ts`, 2026-09-20.
