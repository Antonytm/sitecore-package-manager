// core/model.ts
//
// The shared DOMAIN MODEL — the seam both flows pivot on.
//
//   ZIP  ──parse──►  PackageModel / ItemModel  ──apply──►  XMC Authoring API  (Install)
//   ZIP  ◄serialize─ PackageModel / ItemModel  ◄─fetch───  XMC Authoring API  (Create)
//
// This module is PURE: no React, no Marketplace SDK, no network. It only describes
// the legacy package format in memory. The shapes mirror the reverse-engineered wiki:
// see wiki/articles/item-serialization.md and wiki/articles/package-definition-xml.md.

/** GUID in Sitecore's braced form, e.g. "{110D559F-DEA5-42EA-9C1C-8A5DF7E70EF9}". */
export type Guid = string;

// ── Collision handling ──────────────────────────────────────────────────────
// One model for BOTH the designer's per-source "Installation options" and the
// installer's collision dialog — they're twins. See wiki/articles/installation-wizard-ui.md
// (Screen 9) and package-designer-ui.md (Screen 9).

/** What to do when an incoming item collides with an existing item of the same ID. */
export type InstallMode = "Overwrite" | "Merge" | "Skip";

/** Sub-mode used only when {@link InstallMode} is "Merge". */
export type MergeMode = "Clear" | "Append" | "Merge";

export interface CollisionOption {
  install: InstallMode;
  /** Required iff `install === "Merge"`. */
  merge?: MergeMode;
}

// ── Items ───────────────────────────────────────────────────────────────────

/** A single field value. Sitecore fields are keyed by GUID; `name` is informational. */
export interface FieldModel {
  id: Guid;
  name?: string;
  value: string;
  /** Set when the field stores a blob (media); references an entry in the package's blob store. */
  blobId?: Guid;
}

/** One numbered version of an item, within one language. */
export interface ItemVersionModel {
  version: number; // 1-based
  fields: FieldModel[]; // versioned fields
}

/** All content for one language of an item. */
export interface ItemLanguageModel {
  language: string; // e.g. "en"
  /** Unversioned fields: shared across versions of this language. */
  unversionedFields: FieldModel[];
  versions: ItemVersionModel[];
}

/** A Sitecore item as stored in a package (items/** + properties side-cars + blobs). */
export interface ItemModel {
  id: Guid;
  name: string;
  path: string; // /sitecore/content/...
  templateId: Guid;
  parentId: Guid;
  masterId?: Guid;
  branchId?: Guid;
  /** Shared fields: shared across all languages and versions. */
  sharedFields: FieldModel[];
  languages: ItemLanguageModel[];
}

// ── Package ─────────────────────────────────────────────────────────────────

/** Metadata block (installer/metadata + designer Metadata screen). */
export interface PackageMetadata {
  name: string; // required — "Package Name"
  author?: string;
  version?: string;
  publisher?: string;
  readme?: string; // sc_readme.txt
  license?: string;
  postStep?: string; // type name run after install
  comment?: string;
  attributes?: Record<string, string>;
}

/**
 * Source DEFINITIONS (the installer/project schema). These describe HOW items were
 * selected; the Create flow resolves them against XMC, the Install flow ignores them
 * (it just applies the resolved {@link ItemModel}s). Files/accounts sources are out of
 * scope for SitecoreAI (see wiki/articles/sitecore-marketplace-app.md) — modeled as a
 * stub kind so the parser can round-trip them without us acting on them.
 */
export type SourceDefinition =
  | StaticItemSource
  | DynamicItemSource
  | UnsupportedSource;

export interface StaticItemSource {
  kind: "items-static";
  name: string;
  database: string;
  /** Explicitly enumerated item IDs captured at design time. */
  entries: Guid[];
  installMode: CollisionOption;
}

export interface DynamicItemSource {
  kind: "items-dynamic";
  name: string;
  database: string;
  root: Guid; // search-root item
  filters: DynamicItemFilters;
  installMode: CollisionOption;
}

/** Filters for a dynamic item source (re-resolved on regenerate). See package-designer-ui Screen 5. */
export interface DynamicItemFilters {
  itemName?: string;
  templateId?: Guid;
  language?: string;
  // …created/modified/published ranges, creator, editor, publish-status — to fill in.
  [extra: string]: unknown;
}

/** Files / security-account sources — preserved verbatim but not acted on (out of scope). */
export interface UnsupportedSource {
  kind: "files-static" | "files-dynamic" | "accounts";
  name: string;
  /** Raw definition fragment, kept so write() can round-trip it untouched. */
  raw?: unknown;
}

/** The whole package in memory — the value passed between core, xmc, and the UI. */
export interface PackageModel {
  metadata: PackageMetadata;
  /** Resolved items to install / freshly exported items. */
  items: ItemModel[];
  /** Source definitions, used by the Create (designer) side. */
  sources: SourceDefinition[];
}
