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

## To research (linked but not yet written)

- [[sitecore-marketplace-app]] — Marketplace app SDK, hosting, auth, and the SitecoreAI Authoring/Management API for applying items
