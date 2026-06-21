# Package Creation Process

How a package `.zip` is generated from a [[package-definition-xml]]. Traced from the decompiled
`Sitecore.Kernel` (`Sitecore.Install.*`). The complementary read path is [[package-installation]].

## Pipeline overview

```
PackageProject (definition: Metadata + Sources)
      │
      ▼
PackageGenerator.GeneratePackage(solution, writer)
      ├─ InstallerMarker.Populate(writer)              → writes installer/version
      ├─ if solution.SaveProject:
      │     ProjectSource(solution).Populate(writer)   → writes installer/project (definition XML)
      ├─ EntrySorter(solution).Populate(new Uniq(writer))
      │     • iterates every Source → PackageEntry stream
      │     • Uniq drops duplicate entry keys
      │     • EntrySorter orders entries (parents before children, deps first)
      ├─ writer.Flush()
      └─ writer.Finish()
      ▼
PackageWriter (ISink<PackageEntry>)  → temp zip → package.zip → outer .zip
```

Key reference:

```csharp
public static void GeneratePackage(PackageProject solution, ISink<PackageEntry> writer)
{
    new InstallerMarker().Populate(writer);
    if (solution.SaveProject)
        new ProjectSource(solution).Populate(writer);
    new EntrySorter(solution).Populate(new Uniq(writer));
    writer.Flush();
    writer.Finish();
}
```

## Sources → entries (`Populate`)

Each source in `<Sources>` is an `ISource<PackageEntry>` that emits one `PackageEntry` per unit
of content. Its `Converter` (e.g. `ItemToEntryConverter`, `FileToEntryConverter`,
`AccountToEntryConverter`) turns a domain object into entries:

- **Static sources** (`xitems`/`xfiles`/`accounts`) emit their explicit `<Entries>` directly.
- **Dynamic sources** (`items`/`files`) **resolve at this point**: `ItemSource` walks the
  subtree under `<Root>` in `<Database>`, applies the `<Include>`/`<Exclude>` filters, and emits
  the matching items. This is why a dynamic package's contents reflect the database state *at
  build time*.

For items, `ItemToEntryConverter`:
- serializes each item version via `ItemSerializer` into the `items/…/<lang>/<ver>/xml` entry
  ([[item-serialization]]);
- extracts blob/media fields into separate `blob/…` entries, replacing the value with a GUID;
- writes the `properties/items/…` side-car (`database`, `id`, `language`, `version`,
  `revision`, `fieldproperties`).

`Uniq` then collapses duplicate keys (so listing the same item in two sources is harmless), and
`EntrySorter` orders entries so dependencies (parents, templates) come first.

## Writing the zip (`PackageWriter`)

`PackageWriter.Put(entry)` streams each entry's content into a **temporary inner zip**, and
also writes the entry's properties under the `properties/` prefix. `metadata/` files come from
the `MetadataSink` side. On `Finish()`:

1. the temp inner zip is finalized as **`package.zip`**;
2. `package.zip` is wrapped in the **outer** `.zip` (stored uncompressed when already large,
   compressed otherwise);
3. result is the downloadable package.

## SitecoreAI implementation notes

- We can implement generation without the Sitecore runtime: gather item versions from the
  source (XM/XP or an export), and reproduce the pipeline's *output* — `installer/version`,
  `installer/project`, `metadata/*`, and for each item version an `items/…/xml` +
  `properties/items/…` pair, plus `blob/…` for media. Order parents before children.
- Apply the same `Uniq` semantics (dedupe by entry key) and emit the flattened per-version item
  form ([[item-serialization]]).
- For dynamic sources, *we* run the filter resolution against the source API and then write the
  resolved entries — the built package is always a static snapshot regardless of source type.

## Sources

- Decompiled `Sitecore.Install.PackageGenerator`, `Sitecore.Install.Utils.{InstallerMarker,ProjectSource,EntrySorter,Uniq}`,
  `Sitecore.Install.Zip.PackageWriter`, `Sitecore.Install.Items.{ItemSource,ItemToEntryConverter}`,
  `Sitecore.Data.Items.ItemSerializer`, 2026-06-21.
- Cross-checked against sample package layouts (`files/extracted/`), 2026-06-21.
