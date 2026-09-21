# RAIF Frame Grammar ★

What a decoded `.raif` payload actually says: the protobuf messages that carry items, fields and
media blobs between Sitecore environments. This is the half of the format that maps onto our
`ItemModel`, and the half that must be exactly right — three of its rules fail *silently* when
guessed wrong.

The envelope around these frames is [[raif-chunk-container]]. The same items in the classic
package format are [[item-serialization]].

Verified two ways: measured across **331 real items** in three chunks pulled from a live XM Cloud
environment (`files/samples/raif/`), and read off the protobuf contracts in the decompiled
`Sitecore.Data.ItemsTransfer.Proto.*`, which supply the real type and field names.

## The marker hierarchy

Every frame is one `DataMarker`. It is a protobuf-net inheritance root, and the subtype is
carried as a field number:

```csharp
[ProtoContract]
[ProtoInclude(100, typeof(ItemDataMarker))]     // an item
[ProtoInclude(101, typeof(BlobDataMarker))]     // a media blob
[ProtoInclude(102, typeof(HeaderDataMarker))]   // the chunk-set header
class DataMarker {
    [ProtoMember(1)] long Length;   // ← see "The Length rule"
    [ProtoMember(2)] Guid Id;
}
```

So the **leading field number of a frame tells you what the frame is** — `100`, `101` or `102`.
Our three samples contain `102` once per opening chunk, `100` per item, and **no `101` at all**.

`DataMarker.Id` duplicates the item id that is also inside the nested item definition. That is
deliberate: it lets validators sweep the frame stream for duplicate ids **without deserializing
the nested message**. `BlobDataMarker` and `HeaderDataMarker` set it to `Guid.Empty`.

### `Length` ★

`Length` is **not** the frame's own size. It is the number of bytes that follow the frame before
the next marker, and the reader uses it to *seek*:

```csharp
// ProtoStreamReader.GetMarkers()
DataMarker m = Read<DataMarker>(currentPosition);
m.DataPosition  = CurrentPosition;              // just past this frame
CurrentPosition = m.DataPosition + m.Length;    // skip the data, don't parse it
```

The value is **per subtype**, which is the trap:

| Marker | `Length` |
|---|---|
| `HeaderDataMarker` | `0` — literal, nothing follows |
| `ItemDataMarker` | the following **values frame including its own 4-byte length prefix** |
| `BlobDataMarker` | the raw blob byte count, **no** prefix (the blob is not a frame) |

A wrong `Length` does not throw. It desynchronises the reader, which then interprets arbitrary
bytes as a marker — so a chunk with one bad pointer fails far from its cause, or silently drops
items. Our encoder's rule is asserted against Sitecore's own pointers on all 300 items of a real
export.

## Payload shape

```
frame 0    HeaderDataMarker     ← only in a chunk whose flag byte is 1
then per item, a PAIR of frames:
  frame n      ItemDataMarker   descriptor: who the item is
  frame n+1    values           every field value, in ONE frame
  (+ inline blob bytes, when the item has media)
```

The whole field list is **one frame holding a repeated message**, not one frame per field. This is
why the payload alternates strictly from index 1, and why frame counts are `1 + 2×items`: our
300-item chunk has 601 frames, the 30-item continuation has 60.

## The header frame (`102`)

```
102 → { 4 → ProtoTransferOptions }
```

```csharp
class ProtoTransferOptions {
    [ProtoMember(1)] MergeStrategy MergeStrategy;  // 0 OverrideExistingItem, 1 KeepExistingItem,
                                                   // 2 LatestWin, 3 OverrideExistingTree
    [ProtoMember(2)] TransferType  TransferType;   // 0 ReadOnly, 1 Transferable
    [ProtoMember(3)] long          TimeStamp;      // DateTime.UtcNow.Ticks at export
    [ProtoMember(4)] string        Description;
}
```

On the wire our samples show `{2: 1, 3: <ticks>}` — `Transferable`, stamped at export. Fields 1
and 4 are absent, and for field 1 that absence *is* the value: protobuf omits defaults, so a
missing `MergeStrategy` means **`OverrideExistingItem`**.

> **The merge strategy travels inside the chunk.** It is not only transfer configuration — the
> target reads it back out of the header and builds its apply strategy from it
> ([[content-transfer-install]]). `TransferType.ReadOnly` is dead code in this build: the
> constructor throws `NotSupportedException("Will be implemented in the next releases")` for
> anything but `Transferable`.

## The item descriptor frame (`100`)

```
100 → { 3 → ProtoItemDefinition }
  1  → forward pointer (DataMarker.Length)
  2  → item id (DataMarker.Id)
```

```csharp
class ProtoItemDefinition {
    [ProtoMember(1)] Guid   Id;
    [ProtoMember(2)] string Name;
    [ProtoMember(3)] Guid   ParentId;
    [ProtoMember(4)] Guid   TemplateId;
    [ProtoMember(5)] Guid   MasterId;    // optional — present on 261 of 300 real items
    [ProtoMember(6)] long   TimeStamp;
}
```

`MasterId` is the branch/master id; it is simply omitted when the item has none, so a reader must
treat absence as "no branch" rather than as a zero GUID.

`TimeStamp` is **neither the created date nor `__Revision`** — `ItemExtensions.ToTransferredItem`
sets it to `DateTime.UtcNow.Ticks` at *export* time. It is a serialization stamp. (The created
date is carried separately and defaults to `DateTime.MinValue`.)

**There is no path.** Unlike the classic package format, which encodes the full path in the entry
name ([[item-serialization]]), a `.raif` item knows only its `ParentId`. A consumer that needs a
path resolves it by walking parents.

## The values frame

Repeated field `1`, one per field value:

```csharp
class ProtoFieldDefinition {
    [ProtoMember(1)] Guid   Id;        // the field's own GUID (tfid in package XML)
    [ProtoMember(2)] string Value;
    [ProtoMember(3)] long   Version;
    [ProtoMember(4)] string Language;
}
```

### Sharing is the `(Version, Language)` pair ★

There is **no sharing flag**. Sharing is encoded entirely in the combination:

| `Version` | `Language` | Means |
|---|---|---|
| `-1` | `""` | **Shared** — one value for the whole item |
| `-1` | `"en"` | **Unversioned** — per language, but not per version |
| `N` | `"en"` | **Versioned** — the normal case |

All three occur in real data. The 300-item chunk contains **801 shared, 150 unversioned and 2300
versioned** values.

`-1` is a *signed* 64-bit value, so on the wire it is the **ten-byte all-ones varint**
(`FF FF FF FF FF FF FF FF FF 01`, decoding to `18446744073709551615`). An encoder that writes it
as a single byte produces a chunk that parses and is wrong — every shared field silently becomes
version 1.

This maps directly onto the package format's `fieldproperties` sharing
([[item-serialization]]), which is how a package's sharing survives the conversion.

## GUIDs — two `fixed64` halves ★

A GUID is always a nested message of two `fixed64` fields whose bytes concatenate to .NET's
16-byte `Guid.ToByteArray()` form. That form is **not** the textual order: the first three groups
are little-endian, the last eight bytes verbatim.

```
{63A7026A-15DC-469C-BBBB-66F256ED0080}
 \__Data1__/ \D2_/ \D3_/ \______Data4______/

f1 = 6A 02 A7 63  DC 15  9C 46      ← Data1, Data2, Data3, byte-swapped
f2 = BB BB 66 F2 56 ED 00 80        ← Data4, as written
```

Getting the swap backwards yields a GUID that looks perfectly plausible and points at nothing —
which, in a format whose entire value is identity preservation, is the worst possible failure.
The halves above are taken verbatim off the wire and asserted in our tests against the id the
Authoring API reports for the same item.

## Timestamps

`.NET` ticks: 100-nanosecond units since `0001-01-01`. The Unix epoch is **62,135,596,800**
seconds in. A real value from the samples is `639254560168136729`; if the offset is wrong the
date lands in year 1 or year 4000, which is the cheapest possible sanity check.

## The blob frame (`101`) ★

`Writing.BlobWriter` emits a marker frame followed by the blob's bytes **raw and inline** — not
length-prefixed, not protobuf:

```
[ uint32-LE len ][ BlobDataMarker { Id = Guid.Empty, BlobId = "<media guid>", Length = n } ]
[ n raw bytes ]                                    ← the blob itself, unframed
```

```csharp
class BlobDataMarker : DataMarker {
    [ProtoMember(3)] string BlobId;    // a STRING, not a Guid message — see below
}
```

`BlobId` is field **3** and its wire type is a **length-delimited string**, not the two-`fixed64`
GUID message every other id in this format uses. A reader that assumes "id ⇒ GUID halves" decodes
it as garbage. It is the media blob GUID in text form — `new MediaData(mediaItem).MediaId` — the
same value stored in the item's blob field, which is how a field references its bytes.

`ItemWriter` writes an item's marker and values, then each of that item's blobs immediately after,
in the same stream — so **blobs are inline in the same chunk payload, directly behind their owning
item**. The reader never parses them inline: it skips `Length` bytes (above), records
`BlobInfo { BlobId, Position, Length }`, and later hands out a bounded `SubStream` window when the
blob is actually needed.

**File-based media is skipped entirely**: `ToTransferredItem` only emits a blob when
`field.IsBlobField && field.HasBlobStream` and the media item is not `FileBased`.

> **A media chunk is NOT enveloped like an item chunk.** This was the open question here, and the
> answer is no: media is **deflate-only, never encrypted**, and its flag byte carries an extra
> bit. Both are covered in [[raif-chunk-container]]. Reading a media payload therefore needs the
> container branch *and* the skip rule above — getting either wrong desynchronises on the first
> image.

### The skip rule is not optional

`Length` on a blob marker is the raw byte count with **no prefix of its own** — the one subtype
where it is not a frame size. A reader that treats the bytes after a `101` marker as another
length-prefixed frame reads four bytes of image data as a frame length and desynchronises
immediately, usually reporting a frame that "runs past the payload" several megabytes later.

Our three non-media samples contain **zero** `101` frames, which is why this went unverified for
so long: every test passed and the rule had never once been exercised.

## Rules that fail silently

Collected, because each one produces a chunk that parses cleanly and is wrong:

1. **The forward pointer** — a wrong `Length` desynchronises the reader instead of throwing.
2. **Sharing** — `-1` written as a one-byte varint turns every shared field into version 1.
3. **GUID halves** — reversed, every id is plausible and points at nothing.
4. **`MasterId`** — written as a zero GUID instead of omitted, the item claims a branch it has not
   got.

## SitecoreAI implementation notes

- `app/src/core/raif/items.ts` is this grammar in code; `guid.ts` is the byte-order primitive and
  `protobuf.ts` a hand-rolled reader/writer covering the four wire types that actually occur.
- Decoding is deliberately **untyped and lossless** — a frame is a flat list of
  `{no, wire, value}`. Nothing in the codec knows what a field *means*, which is what lets the
  round-trip oracle re-encode a real chunk without understanding it.
- `ItemModel.path` is left empty on decode, because the format has no path to give.
- Field order within an item is our choice, so a re-encoded item is **structurally** equivalent to
  Sitecore's, not byte-identical.
- `readPayload` in `codec.ts` implements the skip rule and returns `{ frames, blobs }`;
  `readFrames` is the strict reader and still throws on a media payload, deliberately, so a
  caller cannot use the wrong one by accident.
- **We read blob frames but do not write them.** The Create path now pulls media bytes out of a
  content-transfer chunk (`app/src/xmc/media.ts`) and packages them as `blob/<db>/<guid>`
  entries. The Install path still does not emit `101` frames, so media in a package we install
  travels nowhere — stated to the user rather than hidden ([[content-transfer-install]]).

## Sources

- Real chunks from a live XM Cloud environment, `files/samples/raif/` — 331 items across three chunks (primary ground truth: the 801/150/2300 sharing split, `MasterId` on 261 of 300, frame counts 601/60/3, and the absence of field `101` are all counted from these bytes), 2026-09-20.
- A live media pull of `/sitecore/media library/Project/test`, which is what settled that a media chunk is enveloped differently rather than identically, 2026-09-20.
- Decompiled `Sitecore.Data.ItemsTransfer.Proto.{DataMarker,ItemDataMarker,BlobDataMarker,HeaderDataMarker,ProtoItemDefinition,ProtoFieldDefinition,ProtoTransferOptions}`, `Reading.{ProtoStreamReader,ItemDataSource,BlobInfo,BlobProcessingStack,SubStream}`, `Writing.{ItemWriter,BlobWriter,HeaderWriter}`, `Sitecore.Data.Transfer.ItemExtensions`, 2026-09-20.
- Our implementation: `app/src/core/raif/{items,guid,protobuf}.ts` and `app/src/core/raif/__tests__/items.test.ts`, 2026-09-20.
