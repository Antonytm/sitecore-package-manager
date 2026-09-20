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
// The installer's RESOLVED decision — what actually happens to one colliding item.
// The designer's design-time twin is `BehaviourOptions` below, which additionally
// allows "Undefined" (= the designer's "Ask User", deferring to install time).
// See wiki/articles/installation-wizard-ui.md (Screen 9).

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

/** Where a field's value lives, as `fieldproperties` records it. A property of the
 * TEMPLATE, not the item: the string is byte-identical across every language and version
 * of every item using that template. */
export type Sharing = "Shared" | "Unversioned" | "Versioned";

/** A single field value. Sitecore fields are keyed by GUID; `name` is informational. */
export interface FieldModel {
  id: Guid;
  name?: string;
  /** Field type label as the item XML carries it (`Datetime`, `Droptree`, `Image`, ...). */
  type?: string;
  /** Decoded value. The writer re-escapes it; `""` means the field is not serialized. */
  value: string;
  /** Which bucket this field belongs to. Drives the V -> U -> S emission order. */
  sharing?: Sharing;
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

/** A Sitecore item as stored in a package (serialized items + properties side-cars + blobs). */
export interface ItemModel {
  id: Guid;
  name: string;
  path: string; // /sitecore/content/...
  templateId: Guid;
  parentId: Guid;
  masterId?: Guid;
  branchId?: Guid;
  /** Database the item came from — the second segment of every entry key. */
  database?: string;
  /** Sitecore's item key: always the name lower-cased. */
  key?: string;
  sortorder?: string;
  /** Template NAME, a human reference; `templateId` is authoritative. */
  templateName?: string;
  /** `yyyyMMddTHHmmssZ`. */
  created?: string;
  /**
   * The `fieldproperties` token list exactly as read, preserved so a round-trip is
   * byte-exact. It lists the item's FULL inherited template closure (129 tokens for an
   * item with 25 fields), which cannot be rebuilt from `sharing` alone — so when this is
   * absent the writer composes a well-formed subset from the fields it emits.
   */
  fieldProperties?: string;
  /** Shared fields: shared across all languages and versions. */
  sharedFields: FieldModel[];
  languages: ItemLanguageModel[];
}

/** A binary stream pulled out of an item and stored under `blob/`. */
export interface BlobModel {
  id: Guid;
  /** Database for the `blob/<db>/<guid>` form. */
  database?: string;
  data: Uint8Array;
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
  /**
   * Custom attributes. Packed in the definition as `name=value|name=value|` and stored
   * as one file per attribute under the package's metadata prefix. Key insertion order is
   * the serialized order (JS preserves it for string keys), so round-tripping is stable.
   */
  attributes?: Record<string, string>;
  /** Pass-through only — Sitecore writes these, the designer leaves them empty. */
  revision?: string;
  packageId?: string;
}

// ── Package definition (the `installer/project` document) ───────────────────
// The authoring-side model: what the Package Designer edits and saves. Faithful to
// the five source element types in wiki/articles/package-definition-xml.md, verified
// against the real definitions in files/samples/definitions/.

/**
 * Design-time install behaviour, seeded into the package per source.
 * "Undefined" is the designer's **Ask User** default — it defers to the install-time
 * dialog, which then produces a {@link CollisionOption}.
 */
export type ItemMode =
  | "Undefined"
  | "Overwrite"
  | "Merge"
  | "Skip"
  | "SideBySide";

/** Version-merge sub-mode, meaningful when {@link ItemMode} is "Merge". */
export type ItemMergeMode = "Undefined" | "Clear" | "Append" | "Merge";

/** `<BehaviourOptions>` — the per-source collision seed. */
export interface BehaviourOptions {
  itemMode: ItemMode;
  itemMergeMode: ItemMergeMode;
}

/** The neutral default: defer everything to the installer ("Ask User"). */
export const ASK_USER: BehaviourOptions = {
  itemMode: "Undefined",
  itemMergeMode: "Undefined",
};

/**
 * A parsed `<x-item>` item reference: `/<database>/<path>/{ID}/<language>/<version>`.
 * `language: "invariant"` with `version: 0` means *all languages, all versions* — what
 * the designer emits for a normally-picked item.
 */
export interface ItemRef {
  database: string;
  /** Item path WITHOUT the leading database segment and WITHOUT the trailing braced ID. */
  path: string;
  id: Guid;
  language: string;
  version: number;
}

/** A parsed account entry, e.g. `roles:sitecore\Author`. */
export interface AccountRef {
  type: "roles" | "users";
  domain: string;
  name: string;
}

/**
 * A date filter. The designer offers "Within the past N days" OR an explicit range;
 * they map onto `NotOlderThan` and `ActionDateFrom`/`ActionDateTo` respectively.
 */
export type DateFilter =
  | { mode: "within"; days: number }
  | { mode: "range"; from?: string; to?: string };

/** The nine designer filters for an item source (`<Include>` / `<Exclude>`). */
export interface ItemFilters {
  name?: { pattern: string; searchType: "Simple" | "Regex" | "Wildcards" };
  created?: DateFilter;
  modified?: DateFilter;
  publish?: { publishDate?: string; checkWorkflow: boolean };
  templates?: Guid[];
  createdBy?: string[];
  modifiedBy?: string[];
  languages?: string[];
}

/** The smaller filter set for a file source — no template/language/account filters. */
export interface FileFilters {
  name?: { pattern: string; acceptDirectories: boolean };
  created?: DateFilter;
  modified?: DateFilter;
}

interface SourceBase {
  /** Stable client-side key for React lists and selection. NOT serialized. */
  uid: string;
  /** The user-facing `<Name>` label. */
  name: string;
  behaviour: BehaviourOptions;
}

/** `<xitems>` — an explicit, design-time snapshot of items. Not auto-recursive. */
export interface StaticItemSource extends SourceBase {
  kind: "items-static";
  entries: ItemRef[];
  /** When true, take only the latest version of each item. */
  skipVersions: boolean;
}

/** `<items>` — a root + filters, re-resolved at generation time. */
export interface DynamicItemSource extends SourceBase {
  kind: "items-dynamic";
  database: string;
  root: Guid;
  skipVersions: boolean;
  include: ItemFilters;
  exclude: ItemFilters;
}

/** `<xfiles>` — an explicit list of file and folder paths. */
export interface StaticFileSource extends SourceBase {
  kind: "files-static";
  entries: string[];
  /** `FileToEntryConverter/Root` — the path entries are made relative to. */
  converterRoot: string;
}

/** `<files>` — a root folder + filters, re-resolved at generation time. */
export interface DynamicFileSource extends SourceBase {
  kind: "files-dynamic";
  root: string;
  converterRoot: string;
  include: FileFilters;
  exclude: FileFilters;
}

/** `<accounts>` — users and roles. Always static. */
export interface AccountSource extends SourceBase {
  kind: "accounts";
  entries: AccountRef[];
}

export type SourceDefinition =
  | StaticItemSource
  | DynamicItemSource
  | StaticFileSource
  | DynamicFileSource
  | AccountSource;

/** The whole `<project>` document — metadata plus sources. */
export interface PackageDefinition {
  metadata: PackageMetadata;
  /** `<SaveProject>` — whether the definition is embedded into the built package. */
  saveProject: boolean;
  sources: SourceDefinition[];
}

/** The whole package in memory — the value passed between core, xmc, and the UI. */
export interface PackageModel {
  metadata: PackageMetadata;
  /** Resolved items to install / freshly exported items. */
  items: ItemModel[];
  /** Source definitions, used by the Create (designer) side. */
  sources: SourceDefinition[];
  /** Whether to emit `installer/project`. Read back from that entry's presence. */
  saveProject?: boolean;
  /** Binary streams referenced by media fields. */
  blobs?: BlobModel[];
  /**
   * Opaque byte-faithful provenance: set by `readPackage`, consumed by `writePackage`
   * to reproduce the original `.zip` byte-for-byte (the raw zip records). Ignored by the
   * xmc/UI layers. Treat as internal to core/; mutating the semantic fields above does not
   * update it, so a writer that has changed content must rebuild rather than replay.
   */
  provenance?: unknown;
}
