// xmc/export — read items from XM Cloud into the domain model.  (API ──► model)
//
// The "Marketplace calls → ZIP" direction (the read half; core/writePackage does the zip
// half). resolve.ts already answers WHICH items a source selects; this answers what is
// inside each one — every field, language and version that the package has to carry.
//
// Two things make this different in kind from Preview, and they shape the whole file:
//
//  1. PREVIEW MAY DEGRADE; GENERATION MAY NOT. A filter Preview cannot evaluate just makes
//     the list wider, and it says so. A field this cannot read makes the PACKAGE wrong —
//     and wrong in a way that installs cleanly and is discovered much later. So where
//     resolve.ts reports and carries on, this refuses and names what was missing.
//  2. ONE REQUEST PER ITEM DOES NOT SCALE. Preview walks one request per PARENT; export is
//     per item, and every request is a postMessage hop plus an HTTP round trip. 500 items
//     across 3 languages would be ~1500 serial requests. Items are therefore aliased into
//     batches, which is also why this uses authoringGraphqlPartial: with 25 items per
//     document, the throw-on-any-error contract would let one unreadable item destroy the
//     other 24 and then fail the same way on retry.

import type {
  FieldModel,
  Guid,
  ItemLanguageModel,
  ItemModel,
  ItemRef,
  ItemVersionModel,
  PackageDefinition,
  SourceDefinition,
  Sharing,
} from "../core/model";
import { authoringGraphqlPartial } from "./authoring";
import type { PartialResult } from "./authoring";
import { listLanguages, toBracedGuid } from "./browse";
import type { XmcContext } from "./client";
import {
  ASSUMED,
  CAPABILITIES,
  describeBlocked,
  discover,
  itemSelection,
  looksPreEscaped,
  probeDocument,
  reportFrom,
} from "./fetchcaps";
import { listOf, sharingOfField, typeOfField } from "./fetchcaps";
import type {
  CapabilityId,
  CapabilityReport,
  Many,
  ProbeField,
  ProbeItem,
} from "./fetchcaps";
import { describeShape as describeSchema, introspectSchema } from "./introspect";
import type { Request as IntrospectRequest, SchemaShape } from "./introspect";
import { resolveSource } from "./resolve";
import { getTemplate } from "./templates";
import type { TemplateInfo } from "./templates";

const DEFAULT_BATCH = 25;

/** Generation cannot proceed: the endpoint would not supply something load-bearing. */
export class ExportBlocked extends Error {
  readonly name = "ExportBlocked";
  constructor(
    message: string,
    readonly report: CapabilityReport,
  ) {
    super(message);
  }
}

type RawField = ProbeField;

interface RawVersion {
  version?: number;
  fields?: Many<RawField>;
}

interface RawItem {
  itemId?: string;
  isFallback?: boolean;
  parent?: { itemId?: string } | null;
  name?: string;
  path?: string;
  template?: { templateId?: string; name?: string };
  fields?: Many<RawField>;
  languages?: Many<{ name?: string }>;
  versions?: Many<RawVersion>;
}

export interface ExportOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  batchSize?: number;
  /** Injected in tests, and the seam for a corrected request path. */
  request?: <T>(document: string, variables: Record<string, unknown>) => Promise<PartialResult<T>>;
  /** Injected in tests; defaults to the session template catalog. */
  template?: (templateId: Guid) => Promise<TemplateInfo | undefined>;
  /** Resolved entry list, when the caller already has one (Preview did the walk). */
  entries?: ItemRef[];
  /** Injected in tests; defaults to real schema introspection. */
  introspect?: (request: IntrospectRequest) => Promise<SchemaShape | undefined>;
  /** Injected in tests; defaults to the database's language list. */
  allLanguages?: () => Promise<string[]>;
}

export interface ExportedItems {
  items: ItemModel[];
  /** Per-item problems that did not stop the run, keyed for display. */
  problems: string[];
  /** Media items whose bytes could not be fetched, so the package carries a dead link. */
  danglingMedia: string[];
}

// ── capability negotiation ────────────────────────────────────────────────────

let agreed: CapabilityReport | undefined;

/** Testing seam — the negotiated report is module-level so a walk commits to one shape. */
export function resetExportCapabilities(): void {
  agreed = undefined;
}

function requestOf(ctx: XmcContext, options: ExportOptions) {
  return (
    options.request ??
    (<T>(document: string, variables: Record<string, unknown>) =>
      authoringGraphqlPartial<T>(ctx, document, variables))
  );
}

/**
 * Ask the endpoint, once per session, what it can actually answer.
 *
 * Each capability gets its own document: one unknown field invalidates a whole GraphQL
 * query, so a combined probe could only report that *something* was wrong. And each answer
 * is checked for VALUES, because an unknown Sitecore field name is merely an argument —
 * the query validates and comes back empty.
 */
export async function negotiateExport(
  ctx: XmcContext,
  sample: ItemRef,
  options: ExportOptions = {},
): Promise<CapabilityReport> {
  if (agreed) return agreed;
  const request = requestOf(ctx, options);

  // Ask the schema what it calls things before asking it for anything. The first version
  // of this guessed the names and failed all three hard stops at once against a real
  // tenant — which is what wrong names look like, not what a limited schema looks like.
  let schema: SchemaShape | undefined;
  try {
    schema = await (options.introspect ?? introspectSchema)(request);
  } catch {
    schema = undefined; // introspection disabled; fall back to the conventional spellings
  }

  const discovered = schema ? discover(schema) : ASSUMED;
  const schemaNotes = schema
    ? ["item — " + describeSchema(schema.item), "field — " + describeSchema(schema.field)]
    : ["Schema introspection is not available on this endpoint."];

  const answers = new Map<CapabilityId, ProbeItem | undefined>();

  for (const capability of CAPABILITIES) {
    options.signal?.throwIfAborted();
    const selection = capability.selection(discovered);
    // No name for it in this schema is a definite no — asking would only waste a request.
    if (!selection) {
      answers.set(capability.id, undefined);
      continue;
    }
    try {
      const result = await request<{ item?: ProbeItem | null }>(probeDocument(selection), {
        itemId: sample.id.replace(/[{}]/g, ""),
        database: sample.database,
      });
      answers.set(capability.id, result.data?.item ?? undefined);
    } catch {
      // A rejected document is the schema saying no. Record it and keep probing — the
      // other capabilities are independent and we want the full picture in one pass.
      answers.set(capability.id, undefined);
    }
  }

  agreed = reportFrom(answers, { discovered, schemaNotes });
  return agreed;
}

// ── mapping ───────────────────────────────────────────────────────────────────

function sharingOf(raw: RawField, template: TemplateInfo | undefined): Sharing | undefined {
  // The field node answers directly when the schema puts the flags there, or through its
  // `templateField` definition when it does not; the catalog is the last resort.
  const reported = sharingOfField(raw);
  if (reported) return reported;
  const id = raw.id ? toBracedGuid(raw.id) : undefined;
  return id ? template?.fields.get(id)?.sharing : undefined;
}

/**
 * One API field → one model field, or `undefined` when it must not be written.
 *
 * Two values are dropped rather than carried, and both matter more than they look:
 *
 *  - An INHERITED value. Sitecore's serializer writes only fields the item owns; 63 of the
 *    93 sample item versions have a resolved `sortorder` and no `__sortorder` field for
 *    exactly this reason. Writing the resolved value would bake the default in and detach
 *    the item from its standard values on the target, silently.
 *  - An EMPTY value. The samples contain zero empty `<content>` nodes — an empty field is
 *    simply absent, because writing one blanks a value that would otherwise inherit.
 */
function fieldFrom(
  raw: RawField,
  template: TemplateInfo | undefined,
): { field?: FieldModel; problem?: string } {
  if (raw.containsStandardValue === true) return {};
  const value = raw.value ?? "";
  if (value === "") return {};

  const id = raw.id ? toBracedGuid(raw.id) : undefined;
  if (!id) return { problem: "a field came back without an id and was skipped" };

  if (looksPreEscaped(value)) {
    // Escaping it again would ship an Image or Layout field that renders as literal text.
    return {
      problem:
        "field " + (raw.name ?? id) + " came back already XML-escaped, so it was skipped " +
        "rather than escaped twice",
    };
  }

  const known = template?.fields.get(id);
  return {
    field: {
      id,
      name: raw.name ?? known?.name,
      type: typeOfField(raw) ?? known?.type,
      sharing: sharingOf(raw, template),
      value,
    },
  };
}

function split(fields: FieldModel[]) {
  return {
    shared: fields.filter((f) => f.sharing === "Shared"),
    unversioned: fields.filter((f) => f.sharing === "Unversioned"),
    versioned: fields.filter((f) => f.sharing !== "Shared" && f.sharing !== "Unversioned"),
  };
}

interface Mapped {
  item?: ItemModel;
  problems: string[];
}

/** Fold the per-language answers for one item into a single ItemModel. */
function toItemModel(
  ref: ItemRef,
  byLanguage: Map<string, RawItem>,
  template: TemplateInfo | undefined,
): Mapped {
  const problems: string[] = [];
  const first = [...byLanguage.values()][0];
  if (!first) return { problems };

  const shared = new Map<Guid, FieldModel>();
  const languages: ItemLanguageModel[] = [];

  for (const [language, raw] of byLanguage) {
    const unversioned = new Map<Guid, FieldModel>();
    const versions: ItemVersionModel[] = [];

    // A versions list is what the ladder hard-stops on, so it is present by here; the
    // fallback covers an item with a single implicit version.
    const reported = listOf(raw.versions);
    const rawVersions: RawVersion[] =
      reported.length > 0 ? reported : [{ version: 1, fields: raw.fields }];

    for (const rawVersion of rawVersions) {
      const collected: FieldModel[] = [];
      const perVersion = listOf(rawVersion.fields);
      for (const rawField of perVersion.length > 0 ? perVersion : listOf(raw.fields)) {
        const { field, problem } = fieldFrom(rawField, template);
        if (problem) problems.push(ref.path + ": " + problem);
        if (!field) continue;
        collected.push(field);
      }
      const bucket = split(collected);
      for (const f of bucket.shared) if (!shared.has(f.id)) shared.set(f.id, f);
      for (const f of bucket.unversioned) if (!unversioned.has(f.id)) unversioned.set(f.id, f);
      versions.push({ version: rawVersion.version ?? 1, fields: bucket.versioned });
    }

    languages.push({ language, unversionedFields: [...unversioned.values()], versions });
  }

  return {
    problems,
    item: {
      id: toBracedGuid(first.itemId ?? ref.id),
      name: first.name ?? "",
      path: first.path ?? ref.path,
      templateId: toBracedGuid(first.template?.templateId ?? ""),
      templateName: first.template?.name,
      // Left empty when the endpoint does not expose `parent`; linkByPath fills it in
      // afterwards from the other items in the package.
      parentId: first.parent?.itemId ? toBracedGuid(first.parent.itemId) : "",
      database: ref.database,
      key: (first.name ?? "").toLowerCase(),
      sharedFields: [...shared.values()],
      languages,
    },
  };
}

// ── fetching ──────────────────────────────────────────────────────────────────

/**
 * A real culture name, or undefined.
 *
 * `toItemRef` stores `language: "invariant"` because that is what a classic definition's
 * `<x-item>` entry carries — it means "no particular language", not a language. Sending it
 * to GraphQL earns `Culture is not supported … invariant is an invalid culture identifier`
 * once per item, which is what 156 of those problems were.
 */
const NOT_A_CULTURE = new Set(["", "invariant", "und", "0"]);

export function realLanguage(code: string | undefined): string | undefined {
  const trimmed = (code ?? "").trim();
  return NOT_A_CULTURE.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

function aliasedDocument(refs: ItemRef[], selection: string, language: string): string {
  const aliases = refs.map(
    (ref, i) =>
      "  a" + i + ': item(where: { itemId: "' + ref.id.replace(/[{}]/g, "") +
      '", language: "' + language + '", database: "' + ref.database + '" }) {\n      ' +
      selection + "\n    }",
  );
  return "query ExportItems {\n" + aliases.join("\n") + "\n}";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Languages to fetch for an item — what it reported, or just the one we asked for. */
function languagesOf(raw: RawItem | undefined, fallback: string): string[] {
  const named = listOf(raw?.languages)
    .map((l) => l.name)
    .filter((n): n is string => !!n);
  return named.length > 0 ? named : [fallback];
}

/**
 * Every language worth trying, when an item cannot list its own.
 *
 * The live Authoring schema exposes `Item.language` (the one this query asked for) but no
 * `languages`, so there is no way to ask an item which languages it has versions in. The
 * database's language list is the next best thing: ask for each, and keep the ones that
 * come back with a version. `listLanguages` is the one typed operation in this adapter, so
 * it costs a single request for the whole run.
 */
async function databaseLanguages(ctx: XmcContext, options: ExportOptions): Promise<string[]> {
  if (options.allLanguages) return options.allLanguages();
  try {
    return (await listLanguages(ctx)).map((l) => l.code).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchItems(
  ctx: XmcContext,
  refs: ItemRef[],
  report: CapabilityReport,
  options: ExportOptions,
): Promise<ExportedItems> {
  const request = requestOf(ctx, options);
  const template = options.template ?? ((id: Guid) => getTemplate(ctx, id));
  const selection = itemSelection(report.supported, report.discovered ?? ASSUMED);
  const batches = chunk(refs, options.batchSize ?? DEFAULT_BATCH);
  const needsCatalog =
    !report.supported.has("fieldSharing") || !report.supported.has("fieldType");

  const items: ItemModel[] = [];
  const problems: string[] = [];
  const danglingMedia: string[] = [];
  let done = 0;

  // Per-item content keyed by id, filled language by language.
  const content = new Map<string, Map<string, RawItem>>();

  // One request for the whole run. Needed whenever the items cannot list their own
  // languages — which this schema's Item cannot, having `language` but no `languages` —
  // and also to find a real culture to ask in when the entries say "invariant".
  // Needed for two independent reasons: to enumerate languages when the items cannot
  // (this schema's Item has `language` but no `languages`), and to find a real culture to
  // ask in when the entries say "invariant". Either reason on its own is enough.
  const needLanguages = !report.supported.has("languages") || !realLanguage(refs[0].language);
  const fromDatabase = needLanguages ? await databaseLanguages(ctx, options) : [];

  // A batch is fetched one language at a time, so pick one: what the entry asked for if it
  // is a real culture, else the database's first language.
  const primary = realLanguage(refs[0].language) ?? fromDatabase[0] ?? "en";

  for (const batch of batches) {
    options.signal?.throwIfAborted();

    // First pass in the source's own language: also tells us which languages exist.
    const firstPass = await request<Record<string, RawItem | null>>(
      aliasedDocument(batch, selection, primary),
      {},
    );
    for (const error of firstPass.errors) {
      problems.push(error.message ?? "an item could not be read");
    }

    for (let i = 0; i < batch.length; i++) {
      const raw = firstPass.data?.["a" + i];
      if (!raw) continue;
      const perLanguage = new Map<string, RawItem>();
      perLanguage.set(primary, raw);
      content.set(batch[i].id, perLanguage);
    }

    // Remaining languages, one pass each. `where:` takes a single language, so this is the
    // shape the API forces; batching keeps it to one request per language per batch.
    const extra = new Set<string>();
    for (let i = 0; i < batch.length; i++) {
      const reported = report.supported.has("languages")
        ? languagesOf(firstPass.data?.["a" + i] ?? undefined, primary)
        : fromDatabase;

      for (const language of reported) {
        if (!content.get(batch[i].id)?.has(language)) extra.add(language);
      }
    }

    for (const language of extra) {
      options.signal?.throwIfAborted();
      const pass = await request<Record<string, RawItem | null>>(
        aliasedDocument(batch, selection, language),
        {},
      );
      for (let i = 0; i < batch.length; i++) {
        const raw = pass.data?.["a" + i];
        // An item with no version in this language answers with nothing — expected, not
        // an error, and it must not become an empty language entry. A FALLBACK version is
        // not the item's own content either: packaging it would create a real version on
        // the target where the source had none, the same mistake as writing an inherited
        // standard value.
        if (raw && listOf(raw.versions).length > 0 && raw.isFallback !== true) {
          content.get(batch[i].id)?.set(language, raw);
        }
      }
    }

    done += batch.length;
    options.onProgress?.(done, refs.length);
  }

  for (const ref of refs) {
    const perLanguage = content.get(ref.id);
    if (!perLanguage || perLanguage.size === 0) {
      problems.push(ref.path + ": could not be read and is not in the package");
      continue;
    }
    const first = [...perLanguage.values()][0];
    const templateId = first.template?.templateId;
    // Only ask the template when the item's own field nodes could not answer. When the
    // endpoint puts shared/unversioned/type on the fields themselves, that is authoritative
    // and the catalog is pure overhead.
    const info = needsCatalog && templateId ? await template(toBracedGuid(templateId)) : undefined;
    const mapped = toItemModel(ref, perLanguage, info);
    problems.push(...mapped.problems);
    if (!mapped.item) continue;

    // Media bytes live behind the CM media handler, which this iframe holds no credentials
    // for — GraphQL returns no binary at all. Until a route exists, an item carrying a blob
    // reference is packaged with the reference and named here, so the user knows which
    // items will need their media resolving on the target rather than finding out later.
    const mediaField = [...mapped.item.sharedFields, ...mapped.item.languages.flatMap((l) =>
      [...l.unversionedFields, ...l.versions.flatMap((v) => v.fields)],
    )].find((f) => f.type?.toLowerCase() === "attachment" || f.name?.toLowerCase() === "blob");
    if (mediaField) danglingMedia.push(mapped.item.path);

    items.push(mapped.item);
  }

  return { items: linkByPath(items, problems), problems, danglingMedia };
}

/**
 * Fill in any parent id the endpoint would not give us, by matching the parent's PATH
 * against the other items in the package.
 *
 * `parentid` is how the installer positions an item, so an empty one is not cosmetic. This
 * recovers every item whose parent is also being packaged — the common case, since sources
 * are subtrees. An item whose parent is outside the package cannot be recovered, and saying
 * so is better than shipping an item that installs into the wrong place.
 */
function linkByPath(items: ItemModel[], problems: string[]): ItemModel[] {
  const idByPath = new Map(items.map((i) => [i.path.toLowerCase(), i.id]));
  for (const item of items) {
    if (item.parentId) continue;
    const parentPath = item.path.slice(0, item.path.lastIndexOf("/"));
    const parentId = idByPath.get(parentPath.toLowerCase());
    if (parentId) item.parentId = parentId;
    else {
      problems.push(
        item.path + ": its parent is not in the package and the API did not report one, " +
          "so this item has no position to install into",
      );
    }
  }
  return items;
}

// ── public surface ────────────────────────────────────────────────────────────

/** Resolve any item source to its full content. Non-item sources contribute nothing. */
export async function exportSource(
  ctx: XmcContext,
  source: SourceDefinition,
  options: ExportOptions = {},
): Promise<ExportedItems> {
  const refs = options.entries ?? (await entriesFor(ctx, source, options));
  if (refs.length === 0) return { items: [], problems: [], danglingMedia: [] };

  const report = await negotiateExport(ctx, refs[0], options);
  const blocked = describeBlocked(report);
  if (blocked) throw new ExportBlocked(blocked, report);

  return fetchItems(ctx, refs, report, options);
}

async function entriesFor(
  ctx: XmcContext,
  source: SourceDefinition,
  options: ExportOptions,
): Promise<ItemRef[]> {
  if (source.kind === "items-static") return source.entries;
  if (source.kind !== "items-dynamic") return [];
  // resolve.ts already owns the walk, the filters and the abort handling — reuse it rather
  // than enumerate the subtree a second time and drift from it.
  const resolved = await resolveSource(ctx, source, {
    signal: options.signal,
    onProgress: (scanned) => options.onProgress?.(0, scanned),
  });
  return resolved.entries.map((e) => e.ref).filter((r): r is ItemRef => r !== undefined);
}

export interface ExportedPackage extends ExportedItems {
  /** Entries dropped because another source already claimed them, as `Uniq` would. */
  duplicates: number;
}

/**
 * Every item the definition contributes, deduped across sources the way the generator's
 * `Uniq` sink collapses entries by key — the same rule Preview already reports.
 */
export async function exportDefinition(
  ctx: XmcContext,
  definition: PackageDefinition,
  options: ExportOptions = {},
): Promise<ExportedPackage> {
  const items: ItemModel[] = [];
  const problems: string[] = [];
  const danglingMedia: string[] = [];
  const claimed = new Set<Guid>();
  let duplicates = 0;

  for (const source of definition.sources) {
    options.signal?.throwIfAborted();
    const exported = await exportSource(ctx, source, options);
    problems.push(...exported.problems);
    danglingMedia.push(...exported.danglingMedia);
    for (const item of exported.items) {
      if (claimed.has(item.id)) {
        duplicates++;
        continue;
      }
      claimed.add(item.id);
      items.push(item);
    }
  }

  return { items, problems, danglingMedia, duplicates };
}
