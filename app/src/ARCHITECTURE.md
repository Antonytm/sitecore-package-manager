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
| `features/`   | React **UI** (Install wizard, Package Designer)   | `xmc/`, `core/`      |
| `app/`        | Next.js routes; wires features into the extension | anything             |

**Dependency direction is one-way: `features → xmc → core`, never backwards.** Not
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
   through untouched — that's what `UnsupportedSource.raw` is for (files/account sources).
   Don't re-pretty-print or reorder XML attributes; preserve original encoding/formatting,
   or the byte-identical round-trip fails.

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
(`core/crc32`). No `fast-xml-parser` — the item/definition XML is hand-parsed so attribute
order and the specific entity escaping survive untouched.

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
