# Architecture

One npm package, three layers, one shared domain model. The two product capabilities
(**Install** and **Create**) are inverse paths over the same model:

```
ZIP  ──parse──►  PackageModel / ItemModel  ──apply──►  XMC Authoring API   (Install)
ZIP  ◄serialize─ PackageModel / ItemModel  ◄─fetch───  XMC Authoring API   (Create)
```

## Layers

| Folder        | Role                                              | May import           |
| ------------- | ------------------------------------------------- | -------------------- |
| `core/`       | Pure package **format** (ZIP ↔ model, item XML)   | nothing (no SDK/React) |
| `xmc/`        | Adapter: model ↔ **XM Cloud Authoring API**       | `core/`              |
| `storage/`    | Adapter: definition XML ↔ **browser local storage** | `core/`            |
| `features/`   | React **UI** (Install wizard, Package Designer)   | `xmc/`, `storage/`, `core/` |
| `app/`        | Next.js routes; wires features into the extension | anything             |

### Designer state

The Package Designer's state lives in `features/create/store/`, split in two:

- **`designer.ts`** — the document (definition, selection, project name, dirty flag). Built
  with `zustand/vanilla` and importing neither `react` nor the Marketplace SDK, so the whole
  reducer surface is tested under vitest's node environment with no jsdom and no extra
  devDependencies. Its React binding is a separate file, `hooks.ts`, which keeps that
  property honest.
- **`session.ts`** — the live SDK client and `XmcContext`, the banner messages, and the
  ephemeral UI (open dialog, active tab per source, tree expansion per tree id). None of it
  is persisted.

`autosave.ts` bridges the document store to `storage/`. It takes an injectable `Storage`
for the same reason `storage/` does, and neither of its entry points may run at module
load — these modules are evaluated during Next's prerender, where `localStorage` would
throw on the server.

Zustand's `persist` middleware is deliberately unused: the draft is stored as the
serialized definition **XML**, matching what a built package embeds, not as a JSON
projection of store state.

`storage/` is a sibling of `xmc/`, not part of `core/`: local storage is I/O, and rule 3
below forbids I/O in `core/`. It replaces the legacy designer's server-side `Data/packages`
project files, and stores the **serialized definition XML** rather than a JSON projection so
that what is saved is exactly what a built package would embed. Its accessors take an
injectable `Storage` so they are testable in the node test environment.

**Dependency direction is one-way: `features → xmc | storage → core`, never backwards.** Not
lint-enforced — kept by discipline and review (see rules below). That gives us the
discipline of separate packages with none of the monorepo overhead. If a real second
consumer ever appears (e.g. a headless CLI), promoting a folder to its own package is
mechanical because the graph is clean.

## Rules for `core/`

`core/` must be **pure + browser-safe**. Two rules, both with teeth:

1. **No React.** No components, hooks, or `react`/`react-dom` imports.
2. **No Node built-ins.** Everything runs client-side in the iframe, so no `Buffer`,
   `fs`, `path`, or Node `crypto`. Use `Uint8Array`, `TextEncoder`/`TextDecoder`, and
   Web Crypto instead. (This is the one that sneaks in during zip/binary/XML work — the
   instinct is `Buffer`.)
3. **No I/O.** No `fetch`, no SDK, no network. All reads/writes against XM Cloud live in
   `xmc/`. `core/` only transforms bytes ↔ model in memory; if it ever needs to "go get
   something," the design is wrong.
4. **Preserve what you don't understand.** For byte-compat, carry unsupported parts
   through untouched. The designer will not *author* a file or security-account source —
   SitecoreAI has no server file system, and identity lives in the Cloud Portal rather than
   the content databases — but `core/` still parses and re-serializes both, and the UI
   shows them read-only (`isReadOnlyKind` in `features/create/sources.ts`).
   Don't re-pretty-print or reorder XML attributes; preserve original encoding/formatting,
   or the byte-identical round-trip fails.

### Resolving a source

A dynamic source stores a query — a root plus `<Include>`/`<Exclude>` filters — and only
means something against live content. Deciding whether one item satisfies a filter is pure
logic, so it lives in **`core/filters.ts`**; walking the tree and fetching enough metadata
to decide is I/O, so that lives in **`xmc/resolve.ts`**. Splitting them along the existing
`core`/`xmc` line is also what makes the filter semantics testable at all — vitest runs in
a node environment, so anything reachable only through a component or a live SDK call
cannot be covered.

Two things the resolver has to be honest about, both recorded in its header:

- Five of the eight filters test item metadata the picker queries never request. The
  richer selection is **negotiated** against the endpoint and can fail two ways: a field
  the *schema* rejects throws, but a *Sitecore field name* it does not know simply answers
  with nothing. So the probe checks returned values, not just the absence of an error, and
  reports the filters it could not apply rather than pretending they passed.
- The picker documents in `browse.ts` are never part of that negotiation. The content tree
  must keep working even when every richer selection is refused.

### Building a package

Generation is `resolve` (which items) + `export` (what is inside them) + `writePackage`
(bytes). The split matters because only the last part can be proven offline:

- **`core/items/build.ts` + `core/package.ts`** turn an `ItemModel[]` into the two-layer
  zip. This is verified by `core/__tests__/rebuild.test.ts`, which reads each real sample
  package, discards its bytes, rebuilds from the model and asserts that **every inner
  entry's decompressed content is byte-identical**. Zip *framing* cannot match —
  cross-implementation DEFLATE is not canonical — but entry content can, and that single
  oracle pins attribute order, escaping, field order, BOM/CRLF and entry naming at once.
- **`xmc/export.ts`** fetches the fields, languages and versions. Nothing about the
  Authoring schema here is documented, so `xmc/introspect.ts` **asks the schema** — walking
  from the query root to the item type and on to its field type — and `xmc/fetchcaps.ts`
  builds each selection from the names that came back, wired in through GraphQL **aliases**
  (`id: templateFieldId`) so every parser downstream reads one stable shape. The first cut
  guessed those names instead and a real tenant refused all three load-bearing capabilities
  at once, which is what wrong names look like rather than a limited schema. When
  introspection is unavailable the conventional spellings are assumed and the report says
  so; when a capability is still missing the report carries a listing of what the schema
  *does* offer, so a refusal is actionable instead of a dead end.

Three rules this direction does not share with Preview:

1. **Preview may degrade; generation may not.** A filter Preview cannot evaluate makes its
   list wider and says so. A field generation cannot read makes the *package* wrong — and
   wrong in a way that installs cleanly. So `fetchcaps.ts` marks the load-bearing
   capabilities `hardStop` and `exportSource` throws `ExportBlocked` naming them.
2. **Only fields the item OWNS are written.** Sitecore's serializer omits values inherited
   from `__Standard values`; 63 of the 93 sample item versions carry a resolved `sortorder`
   attribute with no `__sortorder` field for exactly that reason. Writing resolved values
   would detach every packaged item from its standard values on the target, silently, which
   is why `containsStandardValue` is a hard stop rather than a warning.
3. **Requests are batched by alias.** Preview costs one request per *parent*; export costs
   one per item, through a postMessage hop. Items are aliased ~25 per document, which is
   also why `authoringGraphqlPartial` exists — the throw-on-any-error contract would let one
   unreadable item destroy a whole batch.

`fieldproperties` is the one thing the model cannot recompute: it lists the item's full
inherited template closure (129 tokens for an item with 25 fields). A package that was read
keeps the original string verbatim; one generated from live content gets a well-formed
subset covering the fields actually emitted, which tells the installer not to touch the
sharing of fields it was never told about.

### Installing a package

Installing is **not** the mirror of generating. Generating fetches items through the
Authoring API; installing cannot write them back through it, because
`CreateItemInput` is `{name, templateId, parent, language, database, fields}` — there is no
item-id field, on any of the 69 mutations the tenant exposes. Every internal link, layout
datasource and droptree value in a package is a GUID, so creating items under fresh ids
would install cleanly and be wrong. That is the same class of silent failure the export side
hard-stops on, so the Authoring route is closed for install.

The route that works is the content-transfer API (`xmc.contentTransfer.*`), which moves
items between environments and therefore preserves identity:

```
.zip ──readPackage──► PackageModel ──core/raif──► chunks ──► saveChunk → completeChunkSet
                                                              → consumeFile
```

`core/raif/` is the chunk codec, and it stays inside the `core/` rules: AES-CBC comes from
Web Crypto (rule 2 permits it — the same rule that made MD5, and therefore `blob/_file
based/`, impossible on the Create side), raw DEFLATE from `fflate`, which the zip codec
already depends on. No new dependency, no Node built-ins, no I/O.

```
[ 'S' 'C' 'T' 01 <flag> ]  AES-128-CBC( raw-deflate( payload ) )  PKCS#7
payload = repeated { uint32-LE length, protobuf frame }
marker frame, then per item a PAIR: descriptor frame, values frame
```

Four rules were measured against real chunks rather than inferred, and three of them fail
*silently* if guessed wrong:

1. **Byte 4 is a flag, not header.** It is 1 on the chunk that opens a chunk set and 0 on a
   continuation; a flag-1 chunk starts with the marker frame, a flag-0 chunk starts straight
   into item data. Treating it as a fixed header rejects every continuation chunk.
2. **The descriptor's field 1 is a forward pointer** — the byte length of the following
   values frame *including* its own 4-byte prefix. A reader seeks with it, so a wrong value
   desynchronises the payload instead of failing. Our encoder's rule is asserted against
   Sitecore's own pointers on all 300 items of a real export.
3. **Sharing is the (version, language) pair**, not a flag: `(-1, "")` Shared,
   `(-1, "en")` Unversioned, `(N, "en")` Versioned. All three occur in the samples.
4. **GUIDs are two fixed64 halves** concatenating to .NET's mixed-endian 16 bytes, so the
   first three groups are byte-swapped. Getting this backwards yields a plausible-looking
   GUID that points at nothing.

The acceptance oracle mirrors `rebuild.test.ts`: decode a real chunk, re-encode it, and
assert the decrypted, inflated **payload** matches. Deflate framing cannot match across
implementations, so the container is not compared — the payload is.

The key and IV are compiled into `Sitecore.ContentTransfer.Data.Core.Services.StreamService`
and are identical on every environment, which is what makes a chunk authorable rather than
merely readable. If Sitecore ever rotates them, installs would break silently, so the
installer should decode a freshly-pulled chunk before trusting the encoder.

The format is documented in full in the wiki — `wiki/articles/raif-chunk-container.md` (the
envelope), `raif-frame-grammar.md` (the protobuf grammar), `content-transfer-api.md` (the API)
and `content-transfer-install.md` (how the target applies a chunk, in two phases). Read those
before changing anything in `core/raif/`.

## Key seam: `core/model.ts`

`PackageModel` / `ItemModel` is the value passed between all layers. Both convert
directions are `core` (ZIP ↔ model) composed with `xmc` (model ↔ API) — keeping those
halves separate is what makes each testable in isolation.

Collision handling (`CollisionOption` = Overwrite / Merge(+submode) / Skip) is modeled
**once** here and reused by both the designer's "Installation options" and the installer's
collision dialog — they're twins (see `wiki/articles/`).

## Byte-identity & provenance

The invariant `writePackage(readPackage(bytes)) === bytes` (full outer `.zip`) is achieved
by **raw entry preservation, not recompression.** Cross-implementation DEFLATE is not
canonical — re-deflating the .NET writer's entries with a JS library would change the bytes
(and the timestamps, CRC ordering, etc. would never match). So:

- `core/zip` is a purpose-built codec: `readZip` keeps each entry's exact local-header+payload
  and central-directory bytes (a `RawZipRecord`); `writeZip` **replays them verbatim**.
- `readPackage` stashes that raw archive on `model.provenance` (an opaque field; xmc/UI
  ignore it). `writePackage` replays it ⇒ byte-identical.
- Entry serializers (`items`, `properties`, `metadata`) are independently byte-faithful
  (`serialize(parse(x)) === x`) and used to build the **semantic** `PackageModel` on read.
- **Limit:** byte-identity holds only for *unmodified* round-trips. Genuinely editing an
  entry (the Create flow) forces a re-deflate, which is not byte-reproducible — that path is
  built from the model and validated by behaviour, not by byte-equality.

Libs: `fflate` (raw inflate/deflate only — not its zip container); CRC-32 is local
(`core/crc32`); `zustand` for designer state, in `features/` only. No `fast-xml-parser` —
the item/definition XML is hand-parsed so attribute order and the specific entity escaping
survive untouched.

## Build order

1. **`core/`** first — no dependencies; tested directly against `files/` sample packages
   (`npm test`; suites self-skip when `files/` is absent). Invariant above is green for all
   item/empty samples. **Done:** zip codec, item/properties/metadata/definition codecs,
   `readPackage`/`writePackage`.
2. **`xmc/`** — stub with `core` model fixtures before live XMC is available.
3. **`features/`** — built last against the UX blueprint articles.

Everything is client-side (SDK = postMessage in the iframe; the zip codec runs in the
browser). If large packages make the UI janky, push `core` parsing into a Web Worker — the
pure boundary makes that a drop-in.
