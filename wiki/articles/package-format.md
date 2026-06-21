# Sitecore Package Format (classic `.zip`)

The on-disk structure of a classic Sitecore package — the kind produced by the **Package
Designer** / installed by the **Installation Wizard** in Sitecore XM/XP. This is the format
our app must read and write with byte-level fidelity. Everything here is verified against the
sample packages in `files/samples/packages/` and the decompiled `Sitecore.Kernel`.

> **Not the Update format.** Do not confuse this with Sitecore *Update* packages (`.update`,
> `Sitecore.Ship` / `UpdateHelper`, the `----item----` text serialization, `addedfiles/`).
> That is a *different* format and is **out of scope**. See the pitfall note in
> [[package-installation]].

## Two-layer ZIP

A package is a ZIP whose **only** top-level entry is another ZIP named `package.zip`:

```
my-package-1.0.0.zip          ← outer wrapper (what you download/upload)
└── package.zip               ← the real payload (nested zip)
```

The writer stores `package.zip` compressed for small packages and **uncompressed** when it is
already large (e.g. the 69 MB `files-statically` sample: outer ≈ inner ≈ 70 MB). The reader
extracts the nested `package.zip` to a temp file and reads entries from it
([[package-installation]] → `PackageReader`).

## Inner entry tree

Inside `package.zip`, entries are grouped by a set of fixed prefixes:

```
package.zip
├── installer/
│   ├── version              ← format marker, e.g. "41.00.000000.000000"
│   └── project              ← the package definition XML (see [[package-definition-xml]])
├── metadata/                ← human-facing metadata, one file per field
│   ├── sc_name.txt  sc_version.txt  sc_author.txt  sc_publisher.txt
│   ├── sc_comment.txt  sc_license.txt  sc_readme.txt  sc_poststep.txt
│   ├── sc_revision.txt  sc_packageid.txt
│   └── <Custom attribute name>          ← one file per custom attribute
├── items/                   ← serialized items (see [[item-serialization]])  ★ our focus
│   └── <db>/<path…>/{ID}/<lang>/<ver>/xml
├── properties/              ← side-car metadata mirroring items/ and files/
│   ├── items/<same path>/xml
│   └── files/<same path>
├── files/                   ← raw disk files (see below)
│   └── <relative/website/path>
├── blob/                    ← binary blobs & media streams (see [[item-serialization]])
│   ├── <db>/<guid>
│   └── _file based/<md5-guid>
└── security/                ← users & roles (see [[security-accounts]])
    ├── users/<domain>/<name>
    └── roles/<domain>/<name>
```

A given package contains only the prefixes it needs — the `empty-package` sample has just
`installer/` + `metadata/`; an items-only package has no `files/`, `blob/`, or `security/`.

## `installer/version`

Single line, e.g. `41.00.000000.000000`. A format/installer marker written first by
`InstallerMarker`. Present in every sample. Treat the leading `41` as the package schema
generation; emit the same value when writing.

## `installer/project`

The full package **definition** (the serialized `PackageProject`), present when the project's
`<SaveProject>` is `True`. This is the same XML you author in Package Designer — see
[[package-definition-xml]] for the schema and the static-vs-dynamic source distinction.

## `metadata/`

One **plain-text file per metadata field** (UTF-8). Empty fields still produce an empty file.
Verified contents from the `empty-package` sample:

| File | Example content | From definition field |
|------|-----------------|------------------------|
| `sc_name.txt` | `Package Name` | `PackageName` |
| `sc_version.txt` | `1.0.0` | `Version` |
| `sc_author.txt` | `Author` | `Author` |
| `sc_publisher.txt` | `Publisher` | `Publisher` |
| `sc_comment.txt` | `Comments` | `Comment` |
| `sc_readme.txt` | `Readme is here` | `Readme` |
| `sc_poststep.txt` | `post step` | `PostStep` |
| `sc_license.txt` | *(empty)* | `License` |
| `sc_revision.txt` | *(empty)* | `Revision` |
| `sc_packageid.txt` | *(empty)* | `PackageID` |

**Custom attributes** become extra files in `metadata/` whose **filename is the attribute name**
and whose content is the value (e.g. file `Custom attribute 1` → `Custom attribute 1 value`).
In the definition these are packed into `<Attributes>` as `name=value|name=value|`.

## `properties/` side-cars

Every `items/` and `files/` entry has a parallel entry under `properties/` carrying install
metadata. Text files are **UTF-8 with BOM and CRLF** line endings (relevant for byte-exact
output):

- `properties/items/…/xml` — `database`, `id`, `language`, `version`, `revision`,
  `fieldproperties` (see [[item-serialization]]).
- `properties/files/<path>` — `type=file`; directory entries (zip folder entries ending in
  `/`) carry `type=directory`.

## `files/`

Selected website files stored at their **website-root-relative path** (e.g.
`files/App_Config/ConnectionStrings.config`). Directories appear as zip folder entries. On
install they are copied under the web root by `FileInstaller`. Lower priority for us — see
[[package-installation]].

## SitecoreAI implementation notes

- Our app is **items-only**, so the prefixes that matter are `items/`, `properties/items/`,
  and `blob/`; plus `installer/` + `metadata/` for a valid wrapper. We can emit packages with
  no `files/`/`security/` (the `items-*` samples prove that is valid).
- To **read**: unwrap outer → `package.zip` → enumerate `items/**/xml` + matching
  `properties/items/**`. To **write**: reproduce the two-layer zip, `installer/version`,
  `metadata/` files, and the `items/` + `properties/items/` pair per item version.
- Keep BOM/CRLF in `properties/*` and the exact `installer/version` string to stay byte-compatible.

## Sources

- Samples: `files/samples/packages/{empty-package,items-statically,items-dynamically,files-dynamically,files-statically,security-accounts}-1.0.0.zip` (extracted to `files/extracted/`), 2026-06-21.
- Decompiled `Sitecore.Kernel`: `Sitecore.Install.*`, `Sitecore.Install.Zip.PackageWriter/PackageReader`, `Sitecore.Install.Metadata`, `Sitecore.Install.Installer`, 2026-06-21.
