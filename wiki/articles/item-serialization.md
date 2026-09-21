# Item Serialization in Packages ★

How Sitecore items are stored inside a classic package. **This is the most important article
for our app** — the SitecoreAI Marketplace app works *only* with items. Everything here is
verified verbatim against the `items-statically` / `items-dynamically` samples and
`Sitecore.Data.Items.ItemSerializer` in the decompiled kernel.

> This is the package XML item format, **not** the `.item` text format (`----item----` /
> `----field----`) used by old `App_Data` serialization / Update packages, and **not** the
> Rainbow/Unicorn YAML. See the pitfall note in [[package-installation]].

## Entry key (one entry per language + version)

Each item **version** is a separate zip entry. The key encodes the database, the full item
tree path (human-readable names), the item ID, language, and version:

```
items/<database>/<path/with/names>/{ITEM-ID}/<language>/<version>/xml
```

Real example:

```
items/master/sitecore/content/Collection/alaris/Data/{2C1361EB-9485-4764-A5A3-E5B402EEFBA3}/en/1/xml
```

A multi-language, multi-version item therefore produces several entries that differ only in
the `<language>/<version>` segment (the `Dictionary` item in the sample appears under `en`,
`en-CA`, `en-GB`, `ja-JP`). Each has a matching side-car under `properties/items/…/xml`.

## The item XML (per-version, flattened)

As stored in the package, each entry is a complete `<item>` element whose own attributes carry
that version's `language` and `version` (the in-memory serializer can also emit a nested
`<version>` form — see below). Verbatim sample (`Data` item, reflowed for readability — the
stored file is a single line, no XML declaration):

```xml
<item name="Data" key="data"
      id="{2C1361EB-9485-4764-A5A3-E5B402EEFBA3}"
      tid="{A29D272E-9D48-453C-9E9D-B47585FA7F20}"
      mid="{45CF9F42-B3AC-4412-AAB9-F8441C7E448E}"
      sortorder="1400" language="en" version="1"
      template="jss data"
      parentid="{A819E804-6BE9-418F-A5BD-2110D5B877B4}"
      created="20260317T214148Z">
  <fields>
    <field tfid="{5DD74568-4D4B-44C1-B513-0AF5F4CDA34F}" key="__created by" type="Single-Line Text">
      <content>sitecore\antontishchenko@gmail.com</content>
    </field>
    <field tfid="{25BED78C-4957-4165-998A-CA1B52F67497}" key="__created" type="Datetime">
      <content>20260317T214150Z</content>
    </field>
    <!-- … more fields … -->
  </fields>
</item>
```

### `<item>` attributes

| Attribute | Meaning | Notes |
|-----------|---------|-------|
| `name` | Item name | display/tree name |
| `key` | Lowercased name | Sitecore item key |
| `id` | Item GUID | `{8-4-4-4-12}` upper-case, braces |
| `tid` | Template ID | the item's template |
| `mid` | Branch/master ID | source branch (`{00..00}` if none) |
| `bid` | Branch ID | present only for branched items |
| `sortorder` | Int | tree sort order |
| `language` | e.g. `en`, `ja-JP` | this entry's language |
| `version` | e.g. `1` | this entry's version number |
| `template` | Template **name** | human reference (authoritative id is `tid`) |
| `parentid` | Parent GUID | tree position |
| `created` | `yyyyMMddThhmmssZ` | ISO-ish UTC, no separators |

### `<field>` attributes & content

| Attribute | Meaning |
|-----------|---------|
| `tfid` | Template **field** ID — the field definition GUID (authoritative) |
| `key` | Field name (e.g. `title`, `__created`, `__workflow state`) |
| `type` | Field type label (e.g. `Single-Line Text`, `Datetime`, `Droptree`, `Image`, `General Link`) |

Value goes inside `<content>`. Encoding rules observed:

- **Plain text / numbers / GUID references** (`Single-Line Text`, `Datetime`, `Droptree`,
  `Multilist`): raw text. Multi-value reference fields are `|`-separated GUIDs.
- **UTF-8 is preserved literally** — e.g. curly apostrophes `world's`, accented chars.
- **Markup-valued fields are entity-encoded** (the inner XML is escaped with `&lt;`/`&gt;`):
  - `Image`: `<content>&lt;image mediaid="{F8B6426B-…}" /&gt;</content>`
  - `General Link`: `<content>&lt;link class="" id="{5467A130-…}" linktype="internal" text="Schedule a Test Drive" … /&gt;</content>`
  - Layout/`__renderings` (`Layout` type) follow the same escaped-XML pattern.

Standard Sitecore fields appear with their well-known GUIDs and `__`-prefixed keys
(`__created`, `__updated`, `__created by`, `__updated by`, `__owner`, `__revision`,
`__shared revision`, `__workflow`, `__workflow state`, `__originator`, `__sortorder`, …).

### Nested `<version>` form (legacy / in-memory)

`ItemSerializer.GetItemXml` can produce a single `<item>` containing multiple
`<version language=… version=…>` children. Packages in these samples store the **flattened
per-version** form instead; on install, `LegacyItemUnpacker` splits any nested-version item
into one entry per version before handing it to `ItemInstaller`. A reader must accept **both**
shapes; a writer should emit the flattened per-version form to match Package Designer output.

## `properties/items/…/xml` side-car

Each item-version entry has a matching properties entry (UTF-8 **with BOM**, CRLF). Verbatim:

```
database=master
id={2C1361EB-9485-4764-A5A3-E5B402EEFBA3}
language=en
version=1
revision=09da373d-51df-439b-9d10-54c643eef23d
fieldproperties={FD4E2050-…}:Shared|{1B86697D-…}:Versioned|{B5E02AD9-…}:Unversioned|…
```

- `database` / `id` / `language` / `version` — identify the version (mirror the entry key).
- `revision` — matches the item's `__revision` field; used for uninstall/tracking.
- `fieldproperties` — `|`-separated `{fieldId}:Sharing` for **every** template field, where
  Sharing ∈ `Shared` (one value for all languages+versions), `Unversioned` (per language),
  `Versioned` (per language+version). This tells the installer where each field's value lives.

## Blobs & media

`ItemToEntryConverter` pulls blob/attachment and media fields out of the item and writes them
as separate `blob/` entries, replacing the field value with a GUID/`BlobIdentifier`:

- `blob/<database>/<guid>` — database blob (attachment fields).
- `blob/_file based/<md5-guid>` — media file streams, keyed by content MD5.

On install `BlobInstaller.UpdateBlobData` re-links them. *(No media sample was provided —
exact blob bytes/headers are an open gap to confirm with a media-containing package.)*

## SitecoreAI implementation notes

- **Reading**: enumerate `items/**/xml`, parse the flat `<item>` (accept nested `<version>`
  too), join with `properties/items/**` for `database`/`revision`/`fieldproperties`. Use `tfid`
  (not `key`) and `tid` (not `template`) as the authoritative identifiers when mapping to the
  target.
- **Writing**: emit one flattened per-version `<item>` entry + one `properties` side-car per
  version; preserve attribute set, the `yyyyMMddThhmmssZ` date format, `|`-separated
  references, and escaped markup for `Image`/`General Link`/`Layout`.
- On SitecoreAI/XM Cloud there is no direct DB, and items **cannot** be applied via the
  Authoring/Management API: no mutation on that schema can create an item at a chosen id, so
  every GUID reference in a package would be severed. They are applied through the content
  transfer format instead ([[content-transfer-install]], [[raif-frame-grammar]]), which carries
  the same field values keyed by `tfid`. The `fieldproperties` sharing flags decide whether a
  field is set once (Shared) or per language/version — in a `.raif` the same distinction is
  carried by the `(version, language)` pair.
- Mind blobs/media: a faithful items-only importer must also carry `blob/` entries for media
  fields, or resolve media by ID against the target.

## Reading an item out of the Authoring API ★

Two things about the live Authoring schema are not guessable from its `.d.ts` files, and
getting either wrong produces a package that builds, installs and is quietly wrong.

### `fields` is a PAGED connection

`Item.fields` carries `[UsePagination]`, and the page size is `GraphQL.DefaultPageSize`,
which `Sitecore.GraphQL.NetFxHost` defaults to **50**. An item's field closure is routinely
larger — the Standard Template alone contributes about ninety fields — so a selection that
does not pass `first:` receives a PREFIX of the item and nothing says so.

What that looked like in practice: a media item packaged eight fields, all from its own
Image section, and none of its Statistics section. `__created`, `__revision` and `__updated`
sit past the cut. They are also the only **versioned** values a media item on an unversioned
template has, so the `.raif` carried no versioned field at all for it, the target's
`ResolveItemVersions` — which derives versions purely from field values whose `version != -1`
— returned nothing, and the installed item had **no version in any language**.

Ask with `fields(first: …)`, and select `totalCount` so a short answer can be recognised
rather than shipped.

### Sharing is ONE enum, not two booleans

The package format's `fieldproperties` needs `Shared | Unversioned | Versioned` per field.
The live schema states it once, on the template field:

```
ItemTemplateField { name type versioning }      versioning: VERSIONED | UNVERSIONED | SHARED
```

`ItemField` — the node under `item { fields { nodes } }` — carries the *value*
(`name value fieldId containsStandardValue templateField`) and has **no sharing at all**.
Neither type has a `shared`/`unversioned` pair. A reader that knows only the boolean pair
finds nothing, falls through to the template catalog, finds nothing there either, and ends
up classifying every field as `Versioned`. That is correct for ordinary content, which is
why it went unnoticed, and wrong for every media item: `Unversioned/Image`
(`{F1828A2C-7E5D-4BBD-98CA-320474871548}`) keeps blob, size, extension and the rest
unversioned, and `FieldIDs.UnversionedBlob` says so in its own name.

### `isFallback` throws outside a site's content tree ★

`Item.isFallback` is unusable for templates, media and layout, and no selection can make it
work. The resolver reaches for a site context first:

```csharp
// ItemAdapter
public bool IsFallback {
  get { using (new SiteContextSwitcher(SiteContext))
        return _sitecoreItem.Database.GetItem(ID, Language).IsFallback; } }

private SiteContext SiteContext {
  get { Site site = _sitecoreItem.FindSiteForItem();
        _lazySiteContext = new SiteContext(new SiteInfo(site.Properties));   // ← NRE
        ... } }

// ItemExtensions
public static Site FindSiteForItem(this Item item) =>
  GetSiteBasePaths().FirstOrDefault(s => path.StartsWith(s.BasePath, OrdinalIgnoreCase))?.Site;
```

`FindSiteForItem` returns **null** for any path no site's base path covers, and
`site.Properties` then dereferences it. The answer is
*"Object reference not set to an instance of an object."* — a resolver error on a non-null
field, so it propagates to the nearest nullable parent and takes the **whole item** with it.

That makes the failure structural, not incidental: everything under `/sitecore/templates`,
`/sitecore/media library`, `/sitecore/layout` and `/sitecore/system` fails identically,
every time, while `/sitecore/content/<site>/…` succeeds. Exporting a template folder hits it
once per item.

The workaround is the general one — retry the failed items with the selection dropped
([[package-creation]]) — plus two things about how it is reported:

- The flag has exactly one consumer: the extra-language pass, which refuses to package a
  version that is only a fallback. The PRIMARY language never consults it, so a
  single-language export that loses the flag has lost nothing and must not say otherwise.
- Because whole regions fail identically, the caveats are grouped by *what was lost and
  where*, naming a few paths and counting the rest, rather than repeated per item.

## Sources

- Samples `items-statically-1.0.0.zip`, `items-dynamically-1.0.0.zip` (extracted), incl. the
  `Home Page Hero` item for `Image`/`General Link` encoding, 2026-06-21.
- Decompiled `Sitecore.Data.Items.ItemSerializer`, `Sitecore.Install.Items.ItemToEntryConverter`,
  `Sitecore.Install.Items.LegacyItemUnpacker`, `Sitecore.Install.BlobData.BlobInstaller`, 2026-06-21.
- Decompiled `Sitecore.GraphQL.Schema.Authoring.Items.Types.Item.GetFields` (the `ownFields` /
  `excludeStandardFields` / `[UsePagination]` signature), `…Items.Types.ItemFieldType.V2.ItemField`,
  `…ItemTemplates.Types.{ItemTemplate,ItemTemplateField}`,
  `Sitecore.GraphQL.Services.Abstractions.Model.FieldVersioning`,
  `Sitecore.Extensions.HotChocolate.Pagination.QueryableConnectionResolver`, and
  `Sitecore.GraphQL.NetFxHost.DependencyInjection.ServiceConfigurator` (`GraphQL.DefaultPageSize` = 50),
  2026-09-20.
- A generated package read back off disk: `/sitecore/media library/Project/test/1067555` on
  `{F1828A2C-…}` (`TemplateIDs.UnversionedImage`) carried 8 fields, all marked `Versioned`, and
  no Statistics section — the primary evidence for both defects, 2026-09-20.
- Decompiled `Sitecore.Data.DataProviders.CompositeDataProvider.ResolveItemVersions` — versions
  are derived from field values with `Version != -1`, which is why an item with no versioned
  value installs with no version, 2026-09-20.
- Decompiled `Sitecore.GraphQL.Services.Model.ItemAdapter.{IsFallback,SiteContext}` and
  `Sitecore.GraphQL.Services.Extensions.ItemExtensions.FindSiteForItem` — the null site that
  makes `isFallback` throw for every item outside a site's base path, 2026-09-21.
