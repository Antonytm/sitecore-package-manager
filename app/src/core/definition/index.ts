// core/definition — installer/project definition XML  ->  metadata + sources.
//
// The package definition schema (static `xitems`/`xfiles`/`accounts` vs dynamic
// `items`/`files` sources) from wiki/articles/package-definition-xml.md.
//
// Read direction only is semantic: parseDefinition extracts metadata + source intent for
// the model. Byte-identity of the stored `installer/project` is guaranteed elsewhere by
// replaying the raw zip entry (see core/package), so this module does NOT need to
// reproduce the original XML formatting.

import type {
  PackageMetadata,
  SourceDefinition,
  StaticItemSource,
  DynamicItemSource,
  UnsupportedSource,
  DynamicItemFilters,
  Guid,
} from "../model";
import { parseXml, child, children, childText, XmlNode } from "./xml";

export interface ParsedDefinition {
  metadata: PackageMetadata;
  sources: SourceDefinition[];
}

const GUID_RE = /\{[0-9A-Fa-f-]{36}\}/;

/** Extract the braced GUID from an x-item reference like `/master/path/{ID}/invariant/0`. */
function guidOf(ref: string): Guid | undefined {
  return ref.match(GUID_RE)?.[0];
}

/** Database segment of an x-item reference (`/<db>/...`). */
function databaseOf(ref: string): string {
  const parts = ref.split("/").filter(Boolean);
  return parts[0] ?? "";
}

function parseMetadata(project: XmlNode): PackageMetadata {
  const meta = child(child(project, "Metadata") ?? project, "metadata");
  const m: PackageMetadata = { name: "" };
  if (!meta) return m;
  m.name = childText(meta, "PackageName");
  const set = (k: keyof PackageMetadata, tag: string) => {
    const v = childText(meta, tag);
    if (v) (m as unknown as Record<string, unknown>)[k] = v;
  };
  set("author", "Author");
  set("version", "Version");
  set("publisher", "Publisher");
  set("readme", "Readme");
  set("license", "License");
  set("postStep", "PostStep");
  set("comment", "Comment");
  const attrs = childText(meta, "Attributes");
  if (attrs) {
    const record: Record<string, string> = {};
    for (const token of attrs.split("|")) {
      if (!token) continue;
      const eq = token.indexOf("=");
      if (eq === -1) continue;
      record[token.slice(0, eq)] = token.slice(eq + 1);
    }
    if (Object.keys(record).length > 0) m.attributes = record;
  }
  return m;
}

function parseStaticItems(node: XmlNode): StaticItemSource {
  const entriesNode = child(node, "Entries");
  const refs = entriesNode ? children(entriesNode, "x-item").map((e) => e.text) : [];
  const entries = refs.map(guidOf).filter((g): g is Guid => !!g);
  return {
    kind: "items-static",
    name: childText(node, "Name"),
    database: refs.length > 0 ? databaseOf(refs[0]) : "",
    entries,
    // The static schema carries no explicit collision mode; the installer/designer
    // default applies. Modeled as Overwrite here; the UI can override per source.
    installMode: { install: "Overwrite" },
  };
}

function parseDynamicItems(node: XmlNode): DynamicItemSource {
  const filters: DynamicItemFilters = {};
  const include = child(node, "Include");
  if (include) {
    const nameFilter = child(include, "ItemNameFilter");
    if (nameFilter) filters.itemName = childText(nameFilter, "Pattern") || undefined;
    const templateFilter = child(include, "ItemTemplateFilter");
    if (templateFilter) filters.templateId = childText(templateFilter, "Templates") || undefined;
    const langFilter = child(include, "ItemLanguageFilter");
    if (langFilter) filters.language = childText(langFilter, "Languages") || undefined;
  }
  return {
    kind: "items-dynamic",
    name: childText(node, "Name"),
    database: childText(node, "Database"),
    root: childText(node, "Root"),
    filters,
    installMode: { install: "Overwrite" },
  };
}

const UNSUPPORTED_KINDS: Record<string, UnsupportedSource["kind"]> = {
  xfiles: "files-static",
  files: "files-dynamic",
  accounts: "accounts",
};

/** Parse `installer/project` into metadata + source definitions. */
export function parseDefinition(xml: string): ParsedDefinition {
  const project = parseXml(xml);
  const metadata = parseMetadata(project);
  const sources: SourceDefinition[] = [];
  const sourcesNode = child(project, "Sources");
  if (sourcesNode) {
    for (const node of sourcesNode.children) {
      if (node.name === "xitems") sources.push(parseStaticItems(node));
      else if (node.name === "items") sources.push(parseDynamicItems(node));
      else if (UNSUPPORTED_KINDS[node.name]) {
        sources.push({
          kind: UNSUPPORTED_KINDS[node.name],
          name: childText(node, "Name"),
        });
      }
    }
  }
  return { metadata, sources };
}

/**
 * Build `installer/project` XML from metadata + sources. Best-effort, for packages we
 * author from scratch (the Create flow) — NOT byte-identical to Sitecore's writer, so it
 * is never used on the round-trip path. Implemented when the Create flow needs it.
 */
export function buildDefinition(_def: ParsedDefinition): string {
  throw new Error("buildDefinition: not implemented (Create flow)");
}
