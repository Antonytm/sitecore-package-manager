# Package Installation Process

How a classic package `.zip` is read and applied. Traced from the decompiled `Sitecore.Kernel`
(`Sitecore.Install.*`). The complementary write path is [[package-creation]].

> **Pitfall — two different "installs".** Classic packages (this article,
> `Sitecore.Install.Installer`) are *not* the same as **Update** packages
> (`Sitecore.Update` / `UpdateHelper.Install` / `DiffInstaller`, used by `Sitecore.Ship`/TDS).
> Public web write-ups frequently describe the Update path and the `----item----` text format —
> that is **out of scope**. Our target is the classic `.zip` Package Designer format
> ([[package-format]]).

## Pipeline overview

```
package .zip
   │
   ▼
PackageReader (ISource<PackageEntry>)
   • opens outer zip, extracts nested package.zip to a temp file, enumerates entries
   ▼
Installer.InstallPackage(path, register, source, context)
   ├─ ISink sink = CreateInstallerSink(context)        // SinkDispatcher by prefix
   ├─ new EntrySorter(source).Populate(sink)           // ordered apply
   ├─ sink.Flush(); sink.Finish()
   ├─ if register: RegisterPackage(context)            // /sitecore/system/Packages/Installation history
   └─ run context.PostActions (post-steps)
```

`CreateInstallerSink` routes entries to a handler per prefix (verbatim — these are the **only
four** sinks it registers):

```csharp
SinkDispatcher d = new SinkDispatcher(context);
d.AddSink(Constants.MetadataPrefix, new MetadataSink(context));      // "metadata"
d.AddSink(Constants.BlobDataPrefix, new BlobInstaller(context));     // "blob"
d.AddSink(Constants.ItemsPrefix,    new LegacyItemUnpacker(new ItemInstaller(context))); // "items"
d.AddSink(Constants.FilesPrefix,    new FileInstaller(context));     // "files"
return d;
```

> **Security is wired separately.** `CreateInstallerSink` does **not** register a security sink,
> and `Sitecore.Install.Constants` has no security prefix. `security/` entries are handled by
> `AccountInstaller` (instantiated elsewhere in the install flow, e.g. the wizard's security
> step), which itself checks the leading `security` path segment. See [[security-accounts]].

## Item installation (our focus)

`Sitecore.Install.Items.ItemInstaller`:

1. **`Put(entry)`** — `LegacyItemUnpacker` first splits any nested-`<version>` item into
   per-version items ([[item-serialization]]); `ItemInstaller` queues each and records its ID
   in `_IDsToBeInstalled`.
2. **`Flush()`** — processes the queue in a loop, **postponing items whose template/parent
   isn't installed yet** and retrying until all dependencies resolve (handles arbitrary order).
3. Per version, **`VersionInstaller.PasteVersion(versionXml, target, mode, context)`**:
   - `ParseItemVersion` reads attributes + `<field tfid=…>` values into an item;
   - `BlobInstaller.UpdateBlobData` re-links blob/media fields;
   - `UpdateFieldSharing` applies the `fieldproperties` sharing;
   - `InstallVersion` commits via `BeginEdit`/`EndEdit(updateStatistics:false, silent:true)`,
     sets name/template/branch, and **clamps future created/updated dates to now**.

### Install modes

Behavior comes from the entry's `BehaviourOptions` (seeded in the definition,
[[package-definition-xml]]) or the wizard:

| `InstallMode` (item) | Effect |
|----------------------|--------|
| `Overwrite` | Replace the item; existing versions removed; children re-evaluated. Same ID → move/update in place; different ID at path → delete + recreate. |
| `Merge` | Keep the item, combine versions per `MergeMode` below. |
| `SideBySide` | Create a new item with a new ID alongside the existing one. |
| `Skip` | Do nothing. |

| `MergeMode` (versions, used with `Merge`) | Effect |
|-------------------------------------------|--------|
| `Append` | Add the package's versions, keep existing. |
| `Merge` | Overlay fields onto matching existing versions. |
| `Clear` | Remove all existing versions, then add the package's. |

## Files, security, blobs, metadata

- **`MetadataSink`** loads `metadata/` into context (name/version/etc.) for the install record.
- **`BlobInstaller`** collects `blob/` entries and commits them after items (`FlushData`):
  database blobs → `BlobStorage`; `_file based/<md5>` → media streams.
- **`FileInstaller`** queues file ops and commits them (copy/move/mkdir) under the web root,
  executed in an isolated AppDomain. Directory entries carry `type=directory`.
- **`AccountInstaller`** creates users/roles — see [[security-accounts]].

## Post-install

- `RegisterPackage` writes an item under `/sitecore/system/Packages/Installation history`
  (enables uninstall via stored `revision`s).
- `context.PostActions` run any `PostStep` declared in metadata.

## SitecoreAI implementation notes

- On SitecoreAI/XM Cloud there is **no on-prem DB/file system**, so we cannot call
  `ItemInstaller` directly. Our installer re-implements the item path: read `items/**` +
  `properties/items/**`, resolve dependency order (parents/templates first, mirroring the
  `Flush` postpone loop), and apply via the Authoring/Management API (create/update item, set
  template, per-language/per-version fields, honoring `fieldproperties` sharing).
- Support the three item modes (`Overwrite`/`Merge`/`SideBySide`) + version modes
  (`Append`/`Merge`/`Clear`) to match user expectations from the legacy wizard.
- Carry `blob/` media so media fields resolve. `files/`, `security/`, and post-steps are out of
  scope for an items-only SitecoreAI app (no file system; different security/extensibility model).

## Sources

- Decompiled `Sitecore.Install.Installer`, `Sitecore.Install.Zip.PackageReader`,
  `Sitecore.Install.Framework.SinkDispatcher`, `Sitecore.Install.Items.{ItemInstaller,LegacyItemUnpacker,VersionInstaller}`,
  `Sitecore.Install.Files.FileInstaller`, `Sitecore.Install.BlobData.BlobInstaller`,
  `Sitecore.Install.Metadata.MetadataSink`, 2026-06-21.
