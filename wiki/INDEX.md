# Wiki Index

One line per article: `- [[slug]] — one-line summary`. Grouped by topic; add/rename groups as the wiki grows. Maintained by `/wiki-compile` — keep entries in sync with `articles/`.

## Meta

- [[about-this-wiki]] — what this wiki is, how it works, and how to feed it

## Project

- [[project-overview]] — goal: a Sitecore Marketplace app to install/create legacy-format packages, replacing the sunset Package Manager & Installation Wizard

## Package format (reverse-engineered)

- [[package-format]] — the classic package `.zip` layout: two-layer zip, `installer/`, `metadata/`, `items/`, `properties/`, `blob/`, `security/`
- [[item-serialization]] — ★ how items are stored: per-version `<item>` XML, fields, encoding, properties side-cars, blobs (our app's core)
- [[package-definition-xml]] — the `installer/project` definition schema; static (`xitems`/`xfiles`/`accounts`) vs dynamic (`items`/`files`) sources
- [[package-creation]] — generation pipeline: definition → sources → entries → `package.zip` → outer zip
- [[package-installation]] — read + install pipeline, sinks, item install/merge modes, post-steps (and the Update-format pitfall)
- [[security-accounts]] — users & roles in the definition and package (secondary for SitecoreAI)

## Content transfer (reverse-engineered)

- [[content-transfer-install]] — how our app installs a package on SitecoreAI: why the Authoring API cannot do it, the push pipeline, and the two-phase consume-then-migrate model the target actually uses
- [[raif-frame-grammar]] — ★ what a `.raif` payload says: the `DataMarker` hierarchy, item descriptors, field values, GUID halves, and sharing as the `(version, language)` pair
- [[raif-chunk-container]] — the `.raif` envelope: `SCT` header, the chunk-set flag byte, AES-128-CBC with a compiled-in key, raw DEFLATE, and `uint32-LE` frame framing
- [[content-transfer-api]] — the `xmc.contentTransfer.*` operations, the pull/push lifecycles, and the undocumented rules (`sitecoreContextId`, double-wrapped responses, `blob://`, `BlobState`)

## Legacy UI / UX (blueprint)

- [[package-designer-ui]] — screen-by-screen UX of the classic Package Designer (create): ribbon, sources panel, metadata, static/dynamic item & file wizards, security accounts, installation options, generate zip
- [[installation-wizard-ui]] — screen-by-screen UX of the classic Installation Wizard (install): select/upload, readme, verify, the ★ item-collision/merge dialog (Apply / Apply to all / Abort), progress, result

## Application

- [[sitecore-marketplace-app]] — how this repo is set up as a Marketplace app: Next.js 15 + Marketplace SDK (client + xmc), Standalone extension, and how items flow via XMC
