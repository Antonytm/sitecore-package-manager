# Package Definition XML

The package **definition** (a serialized `Sitecore.Install.PackageProject`) is the document you
author in Package Designer. It is stored inside the package as `installer/project` (when
`<SaveProject>True`), and is also what you'd save/load to recreate a package. Verified against
all six sample definitions in `files/samples/definitions/` and the decompiled
`Sitecore.Install.Serialization.IOUtils`.

## Top-level shape

```xml
<project>
  <Metadata>
    <metadata>
      <PackageName>Package Name</PackageName>
      <Author>Author</Author>
      <Version>1.0.0</Version>
      <Revision /> <License />
      <Comment>Comments</Comment>
      <Attributes>Custom attribute 1=Custom attribute 1 value|Custom attribute 2=...|</Attributes>
      <Readme>Readme is here</Readme>
      <Publisher>Publisher</Publisher>
      <PostStep>post step</PostStep>
      <PackageID />
    </metadata>
  </Metadata>
  <SaveProject>True</SaveProject>
  <Sources> … one or more source elements … </Sources>
  <Converter><TrivialConverter><Transforms /></TrivialConverter></Converter>
  <Include /> <Exclude /> <Name />
</project>
```

The `<metadata>` fields map 1:1 to the `metadata/sc_*.txt` files ([[package-format]]).
`<Attributes>` is the `name=value|` packing of the custom-attribute files. `<SaveProject>True`
means the definition is embedded into the built package.

## Sources: static vs dynamic

`<Sources>` holds any mix of five element types. The distinction that matters:

- **Static** (`xitems`, `xfiles`, `accounts`) — an **explicit enumerated list** of entries.
  A snapshot: exactly these items/files/accounts, nothing resolved at build time.
- **Dynamic** (`items`, `files`) — a **root + filters**; the actual set is **resolved against
  the live database/filesystem at package-generation time** ([[package-creation]]).

Each source has its own `<Name>` (a user label) and a `<Converter>`. Multiple sources are
allowed, and **duplicate entries are de-duplicated** at generation (a `Uniq` sink) — the
`items-statically` sample deliberately includes an `intentional-item-duplicate` block to show
this.

### `xitems` — static items

```xml
<xitems>
  <Entries>
    <x-item>/master/sitecore/content/Collection/{513A5371-…}/invariant/0</x-item>
    <x-item>/master/sitecore/content/Collection/alaris/{A819E804-…}/invariant/0</x-item>
  </Entries>
  <SkipVersions>False</SkipVersions>
  <Converter><ItemToEntryConverter><Transforms /></ItemToEntryConverter></Converter>
  <Include /> <Exclude /> <Name>static-items-one-by-one</Name>
</xitems>
```

The `x-item` **item reference** format is:

```
/<database>/<path…>/{ITEM-ID}/<language>/<version>
```

- `invariant/0` means **all languages, all versions** (the common case from Package Designer).
- A specific reference (e.g. `/master/…/{ID}/en/1`) would scope to that language+version.
- `<SkipVersions>` — when true, take only the latest version.
- **Static is not auto-recursive**: to include a subtree you enumerate every descendant
  (the sample's `statics-items-recursive` block lists all children explicitly).

### `items` — dynamic items

```xml
<items>
  <Database>master</Database>
  <Root>{513A5371-AA83-4DB2-A559-E5687586B400}</Root>
  <SkipVersions>False</SkipVersions>
  <Converter>
    <ItemToEntryConverter><Transforms>
      <InstallerConfigurationTransform><Options><BehaviourOptions>
        <ItemMode>Undefined</ItemMode>
        <ItemMergeMode>Undefined</ItemMergeMode>
      </BehaviourOptions></Options></InstallerConfigurationTransform>
    </Transforms></ItemToEntryConverter>
  </Converter>
  <Include>
    <ItemNameFilter><Pattern /><FilterSearchType>Simple</FilterSearchType></ItemNameFilter>
    <ItemDateFilter><FilterType>CreatedFilter</FilterType><NotOlderThan>200</NotOlderThan></ItemDateFilter>
    <ItemDateFilter><FilterType>ModifiedFilter</FilterType><NotOlderThan>200</NotOlderThan></ItemDateFilter>
    <ItemPublishFilter><PublishDate /><CheckWorkflow>False</CheckWorkflow></ItemPublishFilter>
    <ItemTemplateFilter><Templates>{A6C086AD-…}|{37A75481-…}|…</Templates></ItemTemplateFilter>
    <ItemUserFilter><FilterType>Created</FilterType><Accounts>sitecore\user@…</Accounts></ItemUserFilter>
    <ItemUserFilter><FilterType>Modified</FilterType><Accounts>sitecore\user@…</Accounts></ItemUserFilter>
    <ItemLanguageFilter><Languages>en|ja-JP|en-GB|en-CA</Languages></ItemLanguageFilter>
  </Include>
  <Exclude /> <Name>items-dynamically</Name>
</items>
```

- `<Root>` = subtree root item ID in `<Database>`; descendants are walked at build time.
- `<Include>` filters (all observed): name pattern, created/modified date (`NotOlderThan` =
  days), publish state, template (`|`-GUIDs), created/modified user, language (`|`-codes).
  `<Exclude>` uses the same filter vocabulary.
- `BehaviourOptions` (`ItemMode` / `ItemMergeMode`) seed the install behavior — see the modes
  table in [[package-installation]]. `Undefined` defers to the wizard's install-time choice.

### `xfiles` / `files` — static / dynamic files

`xfiles` enumerates `<x-item>/path</x-item>` entries (e.g. `/bin/AjaxMin.dll`) under a
`FileToEntryConverter` with a `<Root>`. `files` is the dynamic form: a `<Root>` folder plus
`<Include>` filters (`FileNameFilter` with `AcceptDirectories`, `FileDateFilter`). Secondary
for us — see [[package-format]] / [[package-installation]].

### `accounts` — security accounts (always static)

```xml
<accounts>
  <Entries>
    <x-item>roles:sitecore\Author</x-item>
    <x-item>users:sitecore\antontishchenko@gmail.com</x-item>
  </Entries>
  <Converter><AccountToEntryConverter><Transforms /></AccountToEntryConverter></Converter>
  <Include /> <Exclude /> <Name>security-accounts</Name>
</accounts>
```

Entry form is `roles:<domain>\<name>` or `users:<domain>\<name>`. See [[security-accounts]].

## SitecoreAI implementation notes

- Our authoring UI produces a definition; for an items-only app we mainly emit `xitems`
  (explicit selection) and/or `items` (subtree + filters). We can ignore `xfiles`/`files` and,
  optionally, `accounts`.
- When **reading** a third-party package, parse `installer/project` to recover intent
  (what was selected, install behavior), but the authoritative content is the serialized
  entries themselves ([[item-serialization]]) — the definition may be absent if
  `<SaveProject>` was false.
- Re-emit `<TrivialConverter>` and the per-source converters as-is for compatibility even if we
  don't apply transforms ourselves.

## Sources

- `files/samples/definitions/{empty-package,items-statically,items-dynamically,files-dynamically,security-accounts}.xml`, 2026-06-21.
- Decompiled `Sitecore.Install.PackageProject`, source types `Sitecore.Install.Items.*Source`,
  `Sitecore.Install.Files.*Source`, `Sitecore.Install.Security.*`, `Sitecore.Install.Serialization.IOUtils`, 2026-06-21.
