// core/package — the public facade of the pure layer.
//
// Two inverse functions over the domain model. Everything above (xmc, UI) imports from
// here, not from the sub-modules.
//
//   readPackage:   zip bytes    ──►  PackageModel  (+ opaque byte-faithful provenance)
//   writePackage:  PackageModel  ──►  zip bytes
//
// Round-trip invariant (the core integration test, runnable against files/ with no
// Sitecore): writePackage(readPackage(bytes)) === bytes. It holds because readPackage
// stashes the raw zip records on model.provenance and writePackage replays them verbatim
// (cross-implementation DEFLATE is not canonical, so recompressing could not match). See
// app/src/ARCHITECTURE.md.

import type {
  PackageModel,
  BlobModel,
  ItemModel,
  ItemLanguageModel,
  ItemVersionModel,
  FieldModel,
  Guid,
} from "./model";
import type { PackageDefinition } from "./model";
import { readZip, writeZip, ZipArchive, ZipEntry } from "./zip";
import { parseItemXml, serializeItemXml, getAttr, decodeXml, RawItemEntry } from "./items";
import { buildItemEntries } from "./items/build";
import {
  parseProperties,
  serializeProperties,
  getProperty,
  parseFieldSharing,
  Sharing,
} from "./properties";
import { readMetadata, writeMetadata } from "./metadata";
import { parseDefinition, buildDefinition } from "./definition";

const INNER_NAME = "package.zip";
const GUID_SEG = /^\{[0-9A-Fa-f-]{36}\}$/;

/** Opaque provenance stashed on PackageModel.provenance for byte-faithful rewrite. */
interface PackageProvenance {
  outer: ZipArchive;
}

// ── read ──────────────────────────────────────────────────────────────────────

interface ItemEntryRef {
  name: string; // full inner zip entry name
  db: string;
  pathSegment: string; // "/sitecore/content/..."
  id: Guid;
  language: string;
  version: number;
  raw: RawItemEntry;
}

/** Split an `items/<db>/<path…>/{id}/<lang>/<ver>/xml` key into its parts. */
function parseItemKey(name: string): Omit<ItemEntryRef, "raw"> | null {
  const parts = name.split("/");
  if (parts[0] !== "items" || parts[parts.length - 1] !== "xml") return null;
  const idIdx = parts.findIndex((p) => GUID_SEG.test(p));
  if (idIdx === -1) return null;
  const db = parts[1];
  const pathParts = parts.slice(2, idIdx);
  return {
    name,
    db,
    pathSegment: "/" + pathParts.join("/"),
    id: parts[idIdx],
    language: parts[idIdx + 1],
    version: Number(parts[idIdx + 2]),
  };
}

function fieldFrom(
  raw: { attrs: RawItemEntry["fields"][number]["attrs"]; content: string | null },
  sharing: Sharing,
): FieldModel {
  return {
    id: getAttr(raw.attrs, "tfid") ?? "",
    name: getAttr(raw.attrs, "key"),
    type: getAttr(raw.attrs, "type"),
    sharing,
    value: raw.content === null ? "" : decodeXml(raw.content),
  };
}

/** Merge the per-(language,version) entries of one item into a single ItemModel. */
function buildItemModel(
  id: Guid,
  refs: ItemEntryRef[],
  sharing: Map<string, Map<string, Sharing>>,
  fieldProperties: Map<string, string>,
): ItemModel {
  // Use the first entry for item-level attributes (stable across versions).
  const head = refs[0].raw;
  const sharedFields: FieldModel[] = [];
  const sharedSeen = new Set<string>();
  const languages = new Map<string, ItemLanguageModel>();

  for (const ref of refs) {
    const share = sharing.get(ref.name) ?? new Map<string, Sharing>();
    let lang = languages.get(ref.language);
    if (!lang) {
      lang = { language: ref.language, unversionedFields: [], versions: [] };
      languages.set(ref.language, lang);
    }
    const unversionedSeen = new Set(lang.unversionedFields.map((f) => f.id));
    const version: ItemVersionModel = { version: ref.version, fields: [] };

    for (const f of ref.raw.fields) {
      const tfid = getAttr(f.attrs, "tfid") ?? "";
      // A field absent from `fieldproperties` reads as Versioned — Sitecore itself ships
      // such orphans (4 entries in the samples carry one).
      const kind = share.get(tfid) ?? "Versioned";
      const field = fieldFrom(f, kind);
      if (kind === "Shared") {
        if (!sharedSeen.has(field.id)) {
          sharedSeen.add(field.id);
          sharedFields.push(field);
        }
      } else if (kind === "Unversioned") {
        if (!unversionedSeen.has(field.id)) {
          unversionedSeen.add(field.id);
          lang.unversionedFields.push(field);
        }
      } else {
        version.fields.push(field);
      }
    }
    // A (language, version) pair identifies one entry, so it can only appear once. The
    // samples prove the writer does not always guarantee that — items-statically carries
    // `alaris` twice, byte-identical, at entry 16 and again at 154 — and two rows here
    // would make the rebuilt package emit the duplicate too. Collapse it the way the
    // generator's `Uniq` sink does: first one wins.
    if (!lang.versions.some((v) => v.version === version.version)) lang.versions.push(version);
  }

  return {
    id,
    name: getAttr(head.attrs, "name") ?? "",
    path: refs[0].pathSegment,
    templateId: getAttr(head.attrs, "tid") ?? "",
    parentId: getAttr(head.attrs, "parentid") ?? "",
    masterId: getAttr(head.attrs, "mid"),
    branchId: getAttr(head.attrs, "bid"),
    database: refs[0].db,
    key: getAttr(head.attrs, "key"),
    sortorder: getAttr(head.attrs, "sortorder"),
    templateName: getAttr(head.attrs, "template"),
    created: getAttr(head.attrs, "created"),
    fieldProperties: fieldProperties.get(refs[0].name),
    sharedFields,
    languages: [...languages.values()],
  };
}

/** Parse a classic Sitecore package `.zip` (outer bytes) into the domain model. */
export async function readPackage(bytes: Uint8Array): Promise<PackageModel> {
  const outer = readZip(bytes);
  const innerEntry = outer.byName.get(INNER_NAME);
  if (!innerEntry) throw new Error("readPackage: outer zip has no package.zip");
  const inner = readZip(innerEntry.data);

  // metadata/ files → PackageMetadata
  const metaFiles = new Map<string, Uint8Array>();
  for (const e of inner.entries) {
    if (e.name.startsWith("metadata/")) {
      metaFiles.set(e.name.slice("metadata/".length), e.data);
    }
  }
  let metadata = readMetadata(metaFiles);

  // installer/project → sources (and fall back for metadata if metadata/ was absent)
  const projectEntry = inner.byName.get("installer/project");
  let sources: PackageModel["sources"] = [];
  const saveProject = projectEntry !== undefined;
  if (projectEntry) {
    const def = parseDefinition(new TextDecoder("utf-8").decode(projectEntry.data));
    sources = def.sources;
    if (!metadata.name) metadata = def.metadata;
  }

  // items/ + properties/items/ → ItemModel[]
  const refsById = new Map<Guid, ItemEntryRef[]>();
  const sharingByEntry = new Map<string, Map<string, Sharing>>();
  const fieldPropsByEntry = new Map<string, string>();
  const blobs: BlobModel[] = [];
  for (const e of inner.entries) {
    if (e.name.startsWith("blob/")) {
      const rest = e.name.slice("blob/".length).split("/");
      // `blob/<db>/<guid>` and `blob/_file based/<md5-guid>` share a shape.
      if (rest.length === 2) blobs.push({ id: rest[1], database: rest[0], data: e.data });
      continue;
    }
    const key = parseItemKey(e.name);
    if (!key) continue;
    const raw = parseItemXml(new TextDecoder("utf-8").decode(e.data));
    const ref: ItemEntryRef = { ...key, raw };
    const list = refsById.get(key.id) ?? [];
    list.push(ref);
    refsById.set(key.id, list);

    const propsEntry = inner.byName.get("properties/" + e.name);
    if (propsEntry) {
      const props = parseProperties(propsEntry.data);
      sharingByEntry.set(e.name, parseFieldSharing(props));
      const raw = getProperty(props, "fieldproperties");
      if (raw !== undefined) fieldPropsByEntry.set(e.name, raw);
    }
  }

  const items: ItemModel[] = [];
  for (const [id, refs] of refsById) {
    refs.sort((a, b) =>
      a.language === b.language
        ? a.version - b.version
        : a.language < b.language
          ? -1
          : 1,
    );
    items.push(buildItemModel(id, refs, sharingByEntry, fieldPropsByEntry));
  }

  const provenance: PackageProvenance = { outer };
  return { metadata, items, sources, saveProject, blobs, provenance };
}

// ── write ─────────────────────────────────────────────────────────────────────

/** The format marker Sitecore writes; 19 bytes, no trailing newline. */
const INSTALLER_VERSION = "41.00.000000.000000";

/**
 * Items with parents before their children.
 *
 * The installer re-sorts everything itself (`EntrySorter`, and `ItemInstaller` postpones
 * items whose parent is not in yet), so this is fidelity rather than correctness — but it
 * is what Sitecore emits, and a lexicographic sort is demonstrably NOT: the real output
 * puts `Collection/{513A…}` before `Collection/alaris/…` even though `'a' < '{'`.
 */
export function parentsFirst(items: ItemModel[]): ItemModel[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<Guid>();
  const out: ItemModel[] = [];
  const visit = (item: ItemModel) => {
    if (seen.has(item.id)) return;
    seen.add(item.id); // before recursing, so a parent cycle terminates
    const parent = byId.get(item.parentId);
    if (parent && parent.id !== item.id) visit(parent);
    out.push(item);
  };
  for (const item of items) visit(item);
  return out;
}

function textEntry(name: string, text: string): ZipEntry {
  return { name, data: new TextEncoder().encode(text) };
}

function archiveOf(entries: ZipEntry[]): ZipArchive {
  return {
    entries,
    byName: new Map(entries.map((e) => [e.name, e])),
    prefix: new Uint8Array(0),
    eocd: new Uint8Array(0),
  };
}

/** Assemble the inner `package.zip` entry list, in the order Sitecore writes it. */
function innerEntries(model: PackageModel): ZipEntry[] {
  const entries: ZipEntry[] = [textEntry("installer/version", INSTALLER_VERSION)];

  if (model.saveProject !== false) {
    const definition: PackageDefinition = {
      metadata: model.metadata,
      saveProject: true,
      sources: model.sources,
    };
    entries.push(textEntry("installer/project", buildDefinition(definition)));
  }

  // writeMetadata already returns its files in the ASCII order Sitecore emits them.
  for (const [name, data] of writeMetadata(model.metadata)) {
    entries.push({ name: "metadata/" + name, data });
  }

  // Each item version is followed immediately by its own side-car — the real archives
  // interleave the pair rather than writing two separate blocks.
  for (const item of parentsFirst(model.items)) {
    for (const built of buildItemEntries(item)) {
      entries.push(textEntry(built.key, serializeItemXml(built.item)));
      entries.push({
        name: "properties/" + built.key,
        data: serializeProperties(built.properties),
      });
    }
  }

  for (const blob of model.blobs ?? []) {
    entries.push({ name: "blob/" + (blob.database ?? "master") + "/" + blob.id, data: blob.data });
  }

  return entries;
}

/** Serialize the domain model back to a classic package `.zip` (outer bytes). */
export async function writePackage(model: PackageModel): Promise<Uint8Array> {
  const prov = model.provenance as PackageProvenance | undefined;
  if (prov?.outer) {
    // Faithful path: replay the preserved raw zip records → byte-identical to the source.
    return writeZip(prov.outer);
  }
  // From-scratch path (Create flow): build both layers from the model. Deliberately NOT
  // byte-identical — cross-implementation DEFLATE is not canonical, so the framing differs
  // even when every entry's content matches exactly. See app/src/ARCHITECTURE.md.
  const inner = writeZip(archiveOf(innerEntries(model)));
  return writeZip(archiveOf([{ name: INNER_NAME, data: inner }]));
}

export * from "./model";
