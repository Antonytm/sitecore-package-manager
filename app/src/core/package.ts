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
  ItemModel,
  ItemLanguageModel,
  ItemVersionModel,
  FieldModel,
  Guid,
} from "./model";
import { readZip, writeZip, ZipArchive } from "./zip";
import { parseItemXml, getAttr, decodeXml, RawItemEntry } from "./items";
import {
  parseProperties,
  getProperty,
  parseFieldSharing,
  Sharing,
} from "./properties";
import { readMetadata } from "./metadata";
import { parseDefinition } from "./definition";

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

function fieldFrom(raw: { attrs: RawItemEntry["fields"][number]["attrs"]; content: string | null }): FieldModel {
  return {
    id: getAttr(raw.attrs, "tfid") ?? "",
    name: getAttr(raw.attrs, "key"),
    value: raw.content === null ? "" : decodeXml(raw.content),
  };
}

/** Merge the per-(language,version) entries of one item into a single ItemModel. */
function buildItemModel(
  id: Guid,
  refs: ItemEntryRef[],
  sharing: Map<string, Map<string, Sharing>>,
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
      const field = fieldFrom(f);
      const kind = share.get(field.id) ?? "Versioned";
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
    lang.versions.push(version);
  }

  return {
    id,
    name: getAttr(head.attrs, "name") ?? "",
    path: refs[0].pathSegment,
    templateId: getAttr(head.attrs, "tid") ?? "",
    parentId: getAttr(head.attrs, "parentid") ?? "",
    masterId: getAttr(head.attrs, "mid"),
    branchId: getAttr(head.attrs, "bid"),
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
  if (projectEntry) {
    const def = parseDefinition(new TextDecoder("utf-8").decode(projectEntry.data));
    sources = def.sources;
    if (!metadata.name) metadata = def.metadata;
  }

  // items/ + properties/items/ → ItemModel[]
  const refsById = new Map<Guid, ItemEntryRef[]>();
  const sharingByEntry = new Map<string, Map<string, Sharing>>();
  for (const e of inner.entries) {
    const key = parseItemKey(e.name);
    if (!key) continue;
    const raw = parseItemXml(new TextDecoder("utf-8").decode(e.data));
    const ref: ItemEntryRef = { ...key, raw };
    const list = refsById.get(key.id) ?? [];
    list.push(ref);
    refsById.set(key.id, list);

    const propsEntry = inner.byName.get("properties/" + e.name);
    if (propsEntry) {
      sharingByEntry.set(e.name, parseFieldSharing(parseProperties(propsEntry.data)));
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
    items.push(buildItemModel(id, refs, sharingByEntry));
  }

  const provenance: PackageProvenance = { outer };
  return { metadata, items, sources, provenance };
}

// ── write ─────────────────────────────────────────────────────────────────────

/** Serialize the domain model back to a classic package `.zip` (outer bytes). */
export async function writePackage(model: PackageModel): Promise<Uint8Array> {
  const prov = model.provenance as PackageProvenance | undefined;
  if (prov?.outer) {
    // Faithful path: replay the preserved raw zip records → byte-identical to the source.
    return writeZip(prov.outer);
  }
  // From-scratch path (Create flow): regenerate items/metadata into a two-layer zip. Not
  // byte-identical (no source bytes to match) and not yet required for the read→write
  // round-trip, so deferred until the Create flow needs it.
  throw new Error("writePackage: building a package without provenance is not implemented");
}

export * from "./model";
