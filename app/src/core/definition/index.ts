// core/definition — the `installer/project` package definition, both directions.
//
//   XML ──parseDefinition──► PackageDefinition ──buildDefinition──► XML
//
// The schema (static `xitems`/`xfiles`/`accounts` vs dynamic `items`/`files` sources)
// is documented in wiki/articles/package-definition-xml.md, but the AUTHORITY is the six
// real definitions in files/samples/definitions/ — the prose abbreviates some elements.
//
// `buildDefinition` aims to be byte-identical to Sitecore's own writer: the round-trip
// `buildDefinition(parseDefinition(xml)) === xml` is asserted against every sample in
// __tests__/roundtrip.test.ts. Two quirks that test exists to protect:
//
//   * ItemDateFilter orders NotOlderThan BEFORE the ActionDate pair; FileDateFilter
//     orders it AFTER. They are otherwise identical.
//   * `xitems` carries a bare <Transforms /> while items/files/xfiles carry a full
//     InstallerConfigurationTransform block.

import type {
  AccountRef,
  AccountSource,
  BehaviourOptions,
  DateFilter,
  DynamicFileSource,
  DynamicItemSource,
  FileFilters,
  Guid,
  ItemFilters,
  ItemMergeMode,
  ItemMode,
  ItemRef,
  PackageDefinition,
  PackageMetadata,
  SourceDefinition,
  StaticFileSource,
  StaticItemSource,
} from "../model";
import { ASK_USER } from "../model";
import { child, children, childText, parseXml, XmlNode, XmlWriter } from "./xml";

/** Kept for compatibility with the Install path, which only wants these two fields. */
export interface ParsedDefinition {
  metadata: PackageMetadata;
  sources: SourceDefinition[];
}

// ── ids ─────────────────────────────────────────────────────────────────────

let uidCounter = 0;
/** Fresh client-side key for a source. Not serialized; only identity for the UI. */
export function newSourceUid(): string {
  uidCounter += 1;
  return "src-" + uidCounter.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// ── references ──────────────────────────────────────────────────────────────

const GUID_RE = /^\{[0-9A-Fa-f-]{36}\}$/;

/**
 * Parse `/master/sitecore/content/Home/{ID}/invariant/0`.
 * The braced ID is the third-from-last segment; everything between the database and it
 * is the path. Returns undefined for shapes we do not recognise, so the caller can skip.
 */
export function parseItemRef(ref: string): ItemRef | undefined {
  const parts = ref.split("/").filter((p) => p !== "");
  if (parts.length < 4) return undefined;
  const version = Number(parts[parts.length - 1]);
  const language = parts[parts.length - 2];
  const id = parts[parts.length - 3];
  if (!GUID_RE.test(id) || !Number.isFinite(version)) return undefined;
  return {
    database: parts[0],
    path: "/" + parts.slice(1, parts.length - 3).join("/"),
    id,
    language,
    version,
  };
}

export function formatItemRef(r: ItemRef): string {
  const path = r.path === "/" ? "" : r.path.replace(/\/+$/, "");
  return "/" + r.database + path + "/" + r.id + "/" + r.language + "/" + r.version;
}

export function parseAccountRef(ref: string): AccountRef | undefined {
  const colon = ref.indexOf(":");
  if (colon === -1) return undefined;
  const type = ref.slice(0, colon);
  if (type !== "roles" && type !== "users") return undefined;
  const rest = ref.slice(colon + 1);
  const slash = rest.indexOf("\\");
  return slash === -1
    ? { type, domain: "", name: rest }
    : { type, domain: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

export function formatAccountRef(a: AccountRef): string {
  return a.type + ":" + (a.domain ? a.domain + "\\" : "") + a.name;
}

/** Split a `|`-delimited list, dropping the empty tail Sitecore leaves behind. */
function splitList(text: string): string[] {
  return text.split("|").filter((t) => t !== "");
}

// ── metadata ────────────────────────────────────────────────────────────────

/** `<metadata>` children, in the exact order Sitecore writes them. */
const METADATA_FIELDS: Array<[tag: string, key: keyof PackageMetadata]> = [
  ["PackageName", "name"],
  ["Author", "author"],
  ["Version", "version"],
  ["Revision", "revision"],
  ["License", "license"],
  ["Comment", "comment"],
  ["Attributes", "attributes"],
  ["Readme", "readme"],
  ["Publisher", "publisher"],
  ["PostStep", "postStep"],
  ["PackageID", "packageId"],
];

function parseAttributes(packed: string): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const token of packed.split("|")) {
    if (token === "") continue;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    record[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

/** Pack back to `name=value|name=value|` — note the TRAILING separator Sitecore emits. */
function formatAttributes(attrs: Record<string, string> | undefined): string {
  const entries = Object.entries(attrs ?? {});
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => k + "=" + v).join("|") + "|";
}

function parseMetadata(project: XmlNode): PackageMetadata {
  const meta = child(child(project, "Metadata") ?? project, "metadata");
  const m: PackageMetadata = { name: "" };
  if (!meta) return m;
  for (const [tag, key] of METADATA_FIELDS) {
    const raw = childText(meta, tag);
    if (key === "attributes") {
      const attrs = parseAttributes(raw);
      if (attrs) m.attributes = attrs;
    } else if (key === "name") {
      m.name = raw;
    } else if (raw !== "") {
      (m as unknown as Record<string, unknown>)[key] = raw;
    }
  }
  return m;
}

function writeMetadataBlock(w: XmlWriter, m: PackageMetadata): void {
  w.block(1, "Metadata", () => {
    w.block(2, "metadata", () => {
      for (const [tag, key] of METADATA_FIELDS) {
        w.leaf(
          3,
          tag,
          key === "attributes"
            ? formatAttributes(m.attributes)
            : ((m as unknown as Record<string, unknown>)[key] as string | undefined) ?? "",
        );
      }
    });
  });
}

// ── behaviour options ───────────────────────────────────────────────────────

const ITEM_MODES: ItemMode[] = ["Undefined", "Overwrite", "Merge", "Skip", "SideBySide"];
const MERGE_MODES: ItemMergeMode[] = ["Undefined", "Clear", "Append", "Merge"];

function parseBehaviour(converterBody: XmlNode | undefined): BehaviourOptions {
  const options = converterBody
    ? child(
        child(child(converterBody, "Transforms") ?? converterBody, "InstallerConfigurationTransform") ??
          converterBody,
        "Options",
      )
    : undefined;
  const b = options ? child(options, "BehaviourOptions") : undefined;
  if (!b) return { ...ASK_USER };
  const mode = childText(b, "ItemMode") as ItemMode;
  const merge = childText(b, "ItemMergeMode") as ItemMergeMode;
  return {
    itemMode: ITEM_MODES.includes(mode) ? mode : "Undefined",
    itemMergeMode: MERGE_MODES.includes(merge) ? merge : "Undefined",
  };
}

/** `<Transforms>` holding the behaviour seed. */
function writeTransforms(w: XmlWriter, depth: number, b: BehaviourOptions): void {
  w.block(depth, "Transforms", () => {
    w.block(depth + 1, "InstallerConfigurationTransform", () => {
      w.block(depth + 2, "Options", () => {
        w.block(depth + 3, "BehaviourOptions", () => {
          w.leaf(depth + 4, "ItemMode", b.itemMode);
          w.leaf(depth + 4, "ItemMergeMode", b.itemMergeMode);
        });
      });
    });
  });
}

// ── filters ─────────────────────────────────────────────────────────────────

function parseDateFilter(node: XmlNode): DateFilter | undefined {
  const from = childText(node, "ActionDateFrom");
  const to = childText(node, "ActionDateTo");
  if (from !== "" || to !== "") {
    return { mode: "range", from: from || undefined, to: to || undefined };
  }
  const days = childText(node, "NotOlderThan");
  return days === "" ? undefined : { mode: "within", days: Number(days) };
}

const SEARCH_TYPES: Record<string, "Simple" | "Regex" | "Wildcards"> = {
  Simple: "Simple",
  Regex: "Regex",
  Wildcards: "Wildcards",
};

function parseItemFilters(node: XmlNode | undefined): ItemFilters {
  const f: ItemFilters = {};
  if (!node) return f;

  const name = child(node, "ItemNameFilter");
  if (name) {
    f.name = {
      pattern: childText(name, "Pattern"),
      searchType: SEARCH_TYPES[childText(name, "FilterSearchType")] ?? "Simple",
    };
  }
  for (const d of children(node, "ItemDateFilter")) {
    const parsed = parseDateFilter(d);
    if (!parsed) continue;
    if (childText(d, "FilterType") === "CreatedFilter") f.created = parsed;
    else f.modified = parsed;
  }
  const publish = child(node, "ItemPublishFilter");
  if (publish) {
    f.publish = {
      publishDate: childText(publish, "PublishDate") || undefined,
      checkWorkflow: childText(publish, "CheckWorkflow") === "True",
    };
  }
  const templates = child(node, "ItemTemplateFilter");
  if (templates) f.templates = splitList(childText(templates, "Templates"));
  for (const u of children(node, "ItemUserFilter")) {
    const accounts = splitList(childText(u, "Accounts"));
    if (childText(u, "FilterType") === "Created") f.createdBy = accounts;
    else f.modifiedBy = accounts;
  }
  const langs = child(node, "ItemLanguageFilter");
  if (langs) f.languages = splitList(childText(langs, "Languages"));
  return f;
}

function parseFileFilters(node: XmlNode | undefined): FileFilters {
  const f: FileFilters = {};
  if (!node) return f;
  const name = child(node, "FileNameFilter");
  if (name) {
    f.name = {
      pattern: childText(name, "Pattern"),
      acceptDirectories: childText(name, "AcceptDirectories") === "True",
    };
  }
  for (const d of children(node, "FileDateFilter")) {
    const parsed = parseDateFilter(d);
    if (!parsed) continue;
    if (childText(d, "FilterType") === "CreatedFilter") f.created = parsed;
    else f.modified = parsed;
  }
  return f;
}

const bool = (v: boolean) => (v ? "True" : "False");

/**
 * Emit a date filter. `itemOrder` selects the child order: item filters put
 * NotOlderThan before the ActionDate pair, file filters put it after.
 */
function writeDateFilter(
  w: XmlWriter,
  depth: number,
  tag: string,
  filterType: string,
  d: DateFilter,
  itemOrder: boolean,
): void {
  const within = d.mode === "within" ? String(d.days) : "";
  const from = d.mode === "range" ? d.from ?? "" : "";
  const to = d.mode === "range" ? d.to ?? "" : "";
  w.block(depth, tag, () => {
    w.leaf(depth + 1, "FilterType", filterType);
    if (itemOrder) w.leaf(depth + 1, "NotOlderThan", within);
    w.leaf(depth + 1, "ActionDateTo", to);
    w.leaf(depth + 1, "ActionDateFrom", from);
    if (!itemOrder) w.leaf(depth + 1, "NotOlderThan", within);
  });
}

function writeItemFilters(w: XmlWriter, depth: number, tag: string, f: ItemFilters): void {
  w.block(depth, tag, () => {
    if (f.name) {
      w.block(depth + 1, "ItemNameFilter", () => {
        w.leaf(depth + 2, "Pattern", f.name!.pattern);
        w.leaf(depth + 2, "FilterSearchType", f.name!.searchType);
      });
    }
    if (f.created) writeDateFilter(w, depth + 1, "ItemDateFilter", "CreatedFilter", f.created, true);
    if (f.modified) writeDateFilter(w, depth + 1, "ItemDateFilter", "ModifiedFilter", f.modified, true);
    if (f.publish) {
      w.block(depth + 1, "ItemPublishFilter", () => {
        w.leaf(depth + 2, "PublishDate", f.publish!.publishDate ?? "");
        w.leaf(depth + 2, "CheckWorkflow", bool(f.publish!.checkWorkflow));
      });
    }
    if (f.templates) {
      w.block(depth + 1, "ItemTemplateFilter", () => {
        w.leaf(depth + 2, "Templates", f.templates!.join("|"));
      });
    }
    if (f.createdBy) {
      w.block(depth + 1, "ItemUserFilter", () => {
        w.leaf(depth + 2, "FilterType", "Created");
        w.leaf(depth + 2, "Accounts", f.createdBy!.join("|"));
      });
    }
    if (f.modifiedBy) {
      w.block(depth + 1, "ItemUserFilter", () => {
        w.leaf(depth + 2, "FilterType", "Modified");
        w.leaf(depth + 2, "Accounts", f.modifiedBy!.join("|"));
      });
    }
    if (f.languages) {
      w.block(depth + 1, "ItemLanguageFilter", () => {
        w.leaf(depth + 2, "Languages", f.languages!.join("|"));
      });
    }
  });
}

function writeFileFilters(w: XmlWriter, depth: number, tag: string, f: FileFilters): void {
  w.block(depth, tag, () => {
    if (f.name) {
      w.block(depth + 1, "FileNameFilter", () => {
        w.leaf(depth + 2, "Pattern", f.name!.pattern);
        w.leaf(depth + 2, "AcceptDirectories", bool(f.name!.acceptDirectories));
      });
    }
    if (f.created) writeDateFilter(w, depth + 1, "FileDateFilter", "CreatedFilter", f.created, false);
    if (f.modified) writeDateFilter(w, depth + 1, "FileDateFilter", "ModifiedFilter", f.modified, false);
  });
}

// ── sources ─────────────────────────────────────────────────────────────────

function entryTexts(node: XmlNode): string[] {
  const entries = child(node, "Entries");
  return entries ? children(entries, "x-item").map((e) => e.text) : [];
}

function converterBody(node: XmlNode, name: string): XmlNode | undefined {
  const converter = child(node, "Converter");
  return converter ? child(converter, name) : undefined;
}

function parseSource(node: XmlNode): SourceDefinition | undefined {
  const uid = newSourceUid();
  const name = childText(node, "Name");
  const skipVersions = childText(node, "SkipVersions") === "True";

  switch (node.name) {
    case "xitems": {
      const src: StaticItemSource = {
        kind: "items-static",
        uid,
        name,
        behaviour: parseBehaviour(converterBody(node, "ItemToEntryConverter")),
        entries: entryTexts(node)
          .map(parseItemRef)
          .filter((r): r is ItemRef => r !== undefined),
        skipVersions,
      };
      return src;
    }
    case "items": {
      const src: DynamicItemSource = {
        kind: "items-dynamic",
        uid,
        name,
        behaviour: parseBehaviour(converterBody(node, "ItemToEntryConverter")),
        database: childText(node, "Database"),
        root: childText(node, "Root") as Guid,
        skipVersions,
        include: parseItemFilters(child(node, "Include")),
        exclude: parseItemFilters(child(node, "Exclude")),
      };
      return src;
    }
    case "xfiles": {
      const body = converterBody(node, "FileToEntryConverter");
      const src: StaticFileSource = {
        kind: "files-static",
        uid,
        name,
        behaviour: parseBehaviour(body),
        entries: entryTexts(node),
        converterRoot: body ? childText(body, "Root") : "/",
      };
      return src;
    }
    case "files": {
      const body = converterBody(node, "FileToEntryConverter");
      const src: DynamicFileSource = {
        kind: "files-dynamic",
        uid,
        name,
        behaviour: parseBehaviour(body),
        root: childText(node, "Root"),
        converterRoot: body ? childText(body, "Root") : "/",
        include: parseFileFilters(child(node, "Include")),
        exclude: parseFileFilters(child(node, "Exclude")),
      };
      return src;
    }
    case "accounts": {
      const src: AccountSource = {
        kind: "accounts",
        uid,
        name,
        behaviour: parseBehaviour(converterBody(node, "AccountToEntryConverter")),
        entries: entryTexts(node)
          .map(parseAccountRef)
          .filter((a): a is AccountRef => a !== undefined),
      };
      return src;
    }
    default:
      return undefined;
  }
}

function isAskUser(b: BehaviourOptions): boolean {
  return b.itemMode === "Undefined" && b.itemMergeMode === "Undefined";
}

function writeEntries(w: XmlWriter, depth: number, texts: string[]): void {
  w.block(depth, "Entries", () => {
    for (const t of texts) w.leaf(depth + 1, "x-item", t);
  });
}

function writeSource(w: XmlWriter, depth: number, s: SourceDefinition): void {
  const d = depth;
  switch (s.kind) {
    case "items-static":
      w.block(d, "xitems", () => {
        writeEntries(w, d + 1, s.entries.map(formatItemRef));
        w.leaf(d + 1, "SkipVersions", bool(s.skipVersions));
        w.block(d + 1, "Converter", () => {
          w.block(d + 2, "ItemToEntryConverter", () => {
            // Sitecore writes a bare <Transforms /> here when nothing was configured.
            if (isAskUser(s.behaviour)) w.leaf(d + 3, "Transforms");
            else writeTransforms(w, d + 3, s.behaviour);
          });
        });
        w.leaf(d + 1, "Include");
        w.leaf(d + 1, "Exclude");
        w.leaf(d + 1, "Name", s.name);
      });
      return;

    case "items-dynamic":
      w.block(d, "items", () => {
        w.leaf(d + 1, "Database", s.database);
        w.leaf(d + 1, "Root", s.root);
        w.leaf(d + 1, "SkipVersions", bool(s.skipVersions));
        w.block(d + 1, "Converter", () => {
          w.block(d + 2, "ItemToEntryConverter", () => {
            writeTransforms(w, d + 3, s.behaviour);
          });
        });
        writeItemFilters(w, d + 1, "Include", s.include);
        writeItemFilters(w, d + 1, "Exclude", s.exclude);
        w.leaf(d + 1, "Name", s.name);
      });
      return;

    case "files-static":
      w.block(d, "xfiles", () => {
        writeEntries(w, d + 1, s.entries);
        w.block(d + 1, "Converter", () => {
          w.block(d + 2, "FileToEntryConverter", () => {
            w.leaf(d + 3, "Root", s.converterRoot);
            writeTransforms(w, d + 3, s.behaviour);
          });
        });
        w.leaf(d + 1, "Include");
        w.leaf(d + 1, "Exclude");
        w.leaf(d + 1, "Name", s.name);
      });
      return;

    case "files-dynamic":
      w.block(d, "files", () => {
        w.leaf(d + 1, "Root", s.root);
        w.block(d + 1, "Converter", () => {
          w.block(d + 2, "FileToEntryConverter", () => {
            w.leaf(d + 3, "Root", s.converterRoot);
            writeTransforms(w, d + 3, s.behaviour);
          });
        });
        writeFileFilters(w, d + 1, "Include", s.include);
        writeFileFilters(w, d + 1, "Exclude", s.exclude);
        w.leaf(d + 1, "Name", s.name);
      });
      return;

    case "accounts":
      w.block(d, "accounts", () => {
        writeEntries(w, d + 1, s.entries.map(formatAccountRef));
        w.block(d + 1, "Converter", () => {
          w.block(d + 2, "AccountToEntryConverter", () => {
            if (isAskUser(s.behaviour)) w.leaf(d + 3, "Transforms");
            else writeTransforms(w, d + 3, s.behaviour);
          });
        });
        w.leaf(d + 1, "Include");
        w.leaf(d + 1, "Exclude");
        w.leaf(d + 1, "Name", s.name);
      });
      return;
  }
}

// ── public API ──────────────────────────────────────────────────────────────

/** An empty definition, as the designer's **New** produces. */
export function emptyDefinition(): PackageDefinition {
  return { metadata: { name: "" }, saveProject: true, sources: [] };
}

/** Parse the `installer/project` document into the authoring model. */
export function parseDefinition(xml: string): PackageDefinition {
  const project = parseXml(xml);
  const sourcesNode = child(project, "Sources");
  const sources: SourceDefinition[] = [];
  if (sourcesNode) {
    for (const node of sourcesNode.children) {
      const source = parseSource(node);
      if (source) sources.push(source);
    }
  }
  return {
    metadata: parseMetadata(project),
    saveProject: childText(project, "SaveProject") !== "False",
    sources,
  };
}

/**
 * Serialize back to `installer/project`. Byte-identical to Sitecore's writer for every
 * sample definition: CRLF endings, two-space indent, no XML declaration, and NO trailing
 * newline (the in-package form; the designer's *downloaded* .xml appends one CRLF).
 */
export function buildDefinition(def: PackageDefinition): string {
  const w = new XmlWriter();
  w.block(0, "project", () => {
    writeMetadataBlock(w, def.metadata);
    w.leaf(1, "SaveProject", bool(def.saveProject));
    w.block(1, "Sources", () => {
      for (const s of def.sources) writeSource(w, 2, s);
    });
    w.block(1, "Converter", () => {
      w.block(2, "TrivialConverter", () => {
        w.leaf(3, "Transforms");
      });
    });
    w.leaf(1, "Include");
    w.leaf(1, "Exclude");
    w.leaf(1, "Name");
  });
  return w.toString();
}
