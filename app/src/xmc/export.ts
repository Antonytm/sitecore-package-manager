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
  BlobModel,
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
import type { GraphqlError, PartialResult } from "./authoring";
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
import { DROPPABLE_SELECTIONS, listOf, sharingOfField, totalOf, typeOfField } from "./fetchcaps";
import type {
  CapabilityId,
  CapabilityReport,
  Many,
  ProbeField,
  ProbeItem,
} from "./fetchcaps";
import { describeShape as describeSchema, introspectSchema } from "./introspect";
import type { Request as IntrospectRequest, SchemaShape } from "./introspect";
import { fetchMedia } from "./media";
import type { MediaRequest } from "./media";
import { resolveSource } from "./resolve";
import { getTemplate } from "./templates";
import type { TemplateInfo } from "./templates";

/**
 * Items per aliased request.
 *
 * Was 25 back when a field selection was capped at the endpoint's 50-field page. Asking for
 * the whole set multiplies the work behind one request several times over — every field
 * costs a value, a standard-value check and a template-field lookup, and the selection
 * appears twice per item, at the top level and again inside `versions`. Ten keeps a request
 * near the size that was already being served. `pass` recovers from a dropped connection by
 * halving, but not provoking one costs a single round trip instead of three.
 */
const DEFAULT_BATCH = 10;

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
  /** Injected in tests; defaults to a real content-transfer pull of the media items. */
  fetchMedia?: typeof fetchMedia;
}

export interface ExportedItems {
  items: ItemModel[];
  /** Per-item problems that did not stop the run, keyed for display. */
  problems: string[];
  /** Media items whose bytes could not be fetched, so the package carries a dead link. */
  danglingMedia: string[];
  /** Media items found while reading, and the blob id each one points at. */
  media: MediaRequest[];
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
      const source = perVersion.length > 0 ? rawVersion.fields : raw.fields;
      // A connection answers one page. Shipping a prefix of an item's fields produces a
      // package that installs cleanly and is missing content, which is the worst kind of
      // wrong — so say so rather than let it pass.
      const total = totalOf(source);
      const got = listOf(source).length;
      if (total !== undefined && got < total) {
        problems.push(
          ref.path + ": the endpoint returned " + got + " of " + total +
            " fields in " + language + ", so this item is packaged incomplete",
        );
      }
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

/**
 * Attribute a batch's GraphQL errors to the items that caused them.
 *
 * A batch is one aliased document, so an error arrives keyed by `path` — `["a3", "versions",
 * "nodes", 0, "fields", "nodes", 2, "value"]`. Reporting only `error.message` turns that into
 * a bare "Object reference not set to an instance of an object.", which names neither the
 * item nor the field and is therefore unactionable: the server threw, and the path is the
 * only record of where.
 *
 * `a3` maps back to `batch[3]`, and the remainder names the field chain.
 */
function attribute(errors: GraphqlError[], batch: ItemRef[], language: string): string[] {
  return errors.map((error) => {
    const at = locate(error, batch);
    const message = error.message ?? "an item could not be read";
    const within = (error.path ?? []).slice(1).join(".");
    const where = at ? batch[at.index].path : "an item in this batch";
    return (
      where + " [" + language + "]: " + message + (within ? " (at " + within + ")" : "")
    );
  });
}

/** At most this many paths are named before a caveat switches to "and N more". */
const NAMED_PATHS = 3;

/**
 * Is losing this capability, in these languages, something the package actually paid for?
 *
 * `fallback` is the one that can cost nothing. Its only consumer is the extra-language
 * pass: the primary language is written straight from its own fetch and never consults the
 * flag. So an item degraded only in the primary language lost nothing, and saying otherwise
 * trains people to skim the caveats — which is how a real one gets missed.
 */
function mattered(capability: CapabilityId, languages: Set<string>, primary: string): boolean {
  if (capability !== "fallback") return true;
  return [...languages].some((language) => language !== primary);
}

/**
 * Caveats for degraded items: one per DISTINCT loss, not one per item.
 *
 * Whole regions of the tree degrade identically. `Item.isFallback` resolves through
 * `ItemAdapter.SiteContext`, which is `new SiteInfo(FindSiteForItem().Properties)` — and
 * `FindSiteForItem` returns null for any path no site's base path covers. Everything under
 * `/sitecore/templates`, `/sitecore/media library`, `/sitecore/layout` and `/sitecore/system`
 * therefore answers "Object reference not set to an instance of an object." for that one
 * field, every time. Exporting a template folder used to produce one identically-worded
 * sentence per item — eighteen of them for eighteen templates — describing a single
 * structural fact.
 *
 * So group by what was lost and where it was lost, name a few paths, and count the rest.
 */
function describeDegraded(
  degraded: Map<string, { capabilities: Set<CapabilityId>; languages: Set<string> }>,
  primary: string,
): string[] {
  const groups = new Map<string, { lost: Set<CapabilityId>; languages: string[]; paths: string[] }>();

  for (const [path, { capabilities, languages }] of degraded) {
    const lost = [...capabilities].filter((c) => mattered(c, languages, primary));
    if (lost.length === 0) continue;
    const ordered = CAPABILITIES.filter((c) => lost.includes(c.id)).map((c) => c.id);
    const inLanguages = [...languages].sort();
    const key = ordered.join("+") + "|" + inLanguages.join(",");
    const group = groups.get(key) ?? { lost: new Set(ordered), languages: inLanguages, paths: [] };
    group.paths.push(path);
    groups.set(key, group);
  }

  return [...groups.values()].map(({ lost, languages, paths }) => {
    // The capability's own `need` text, so the caveat reads the same whether a selection
    // was never available on this endpoint or was lost on these particular items.
    const need = CAPABILITIES.filter((c) => lost.has(c.id))
      .map((c) => c.need)
      .join("; ");
    const where = languages.join(", ");

    if (paths.length === 1) {
      return (
        paths[0] + ": the endpoint threw on this item in " + where +
        ", so it was read without " + need + "."
      );
    }
    const named = paths.slice(0, NAMED_PATHS).join(", ");
    const rest = paths.length - NAMED_PATHS;
    return (
      paths.length + " items were read without " + need +
      " — the endpoint threw on them in " + where + ": " + named +
      (rest > 0 ? " and " + rest + " more" : "") + "."
    );
  });
}

/** Which item in the batch an error belongs to, and the selection it failed on. */
function locate(
  error: GraphqlError,
  batch: ItemRef[],
): { index: number; selection?: string } | undefined {
  const path = error.path ?? [];
  const match = /^a(\d+)$/.exec(String(path[0] ?? ""));
  if (!match) return undefined;
  const index = Number(match[1]);
  if (!batch[index]) return undefined;
  return { index, selection: path[1] === undefined ? undefined : String(path[1]) };
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
  const media: MediaRequest[] = [];
  let done = 0;

  // Per-item content keyed by id, filled language by language.
  const content = new Map<string, Map<string, RawItem>>();

  /** Items that only read at all because a selection was dropped, keyed by path. */
  const degraded = new Map<
    string,
    { capabilities: Set<CapabilityId>; languages: Set<string> }
  >();

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

  /**
   * One aliased pass, with a single targeted retry for items the endpoint threw on.
   *
   * A resolver error on a NON-NULL field propagates to the nearest nullable parent — here
   * `item` — so one unreadable boolean costs the whole item, every field of it included.
   * A media item does exactly this to `isFallback`: the Authoring API answers "Object
   * reference not set to an instance of an object." and the item vanishes from the package
   * despite every other field having resolved.
   *
   * Where the error names a selection we are allowed to lose, ask again for just those
   * items without it. Only `DROPPABLE_SELECTIONS` qualify, and each recovered item reports
   * exactly what was given up — a degraded item the user is told about beats a missing item
   * they are not.
   */
  async function passOnce(
    batch: ItemRef[],
    language: string,
  ): Promise<Record<string, RawItem | null>> {
    const first = await request<Record<string, RawItem | null>>(
      aliasedDocument(batch, selection, language),
      {},
    );
    const data: Record<string, RawItem | null> = { ...(first.data ?? {}) };

    const dropped = new Set<CapabilityId>();
    const indices: number[] = [];
    const blocked: GraphqlError[] = [];

    for (const error of first.errors) {
      const at = locate(error, batch);
      const capability = at?.selection ? DROPPABLE_SELECTIONS[at.selection] : undefined;
      // Only worth retrying when the item really did go missing; a nulled sub-field that
      // left the item standing has already been handled by the schema.
      if (at && capability && !data["a" + at.index]) {
        dropped.add(capability);
        if (!indices.includes(at.index)) indices.push(at.index);
      } else {
        blocked.push(error);
      }
    }

    problems.push(...attribute(blocked, batch, language));
    if (indices.length === 0) return data;

    const retryRefs = indices.map((i) => batch[i]);
    const reduced = itemSelection(
      new Set([...report.supported].filter((c) => !dropped.has(c))),
      report.discovered ?? ASSUMED,
    );
    const second = await request<Record<string, RawItem | null>>(
      aliasedDocument(retryRefs, reduced, language),
      {},
    );
    problems.push(...attribute(second.errors, retryRefs, language));

    for (let i = 0; i < retryRefs.length; i++) {
      const raw = second.data?.["a" + i];
      if (!raw) continue;
      data["a" + indices[i]] = raw;
      // Recorded rather than reported here: the same item degrades once per language, and
      // one caveat repeated per language reads like several distinct faults. Summarised
      // once the whole run is done, in `describeDegraded`.
      const seen = degraded.get(retryRefs[i].path) ?? {
        capabilities: new Set<CapabilityId>(),
        languages: new Set<string>(),
      };
      for (const c of dropped) seen.capabilities.add(c);
      seen.languages.add(language);
      degraded.set(retryRefs[i].path, seen);
    }

    return data;
  }

  /**
   * One pass over a batch, halved and retried when the REQUEST ITSELF fails.
   *
   * A GraphQL error arrives in `errors` and is handled above. What this catches is the
   * other kind: the request never completes. Measured against a live tenant as
   * `net::ERR_QUIC_PROTOCOL_ERROR` surfacing through the SDK as "Failed to fetch" — the
   * connection dropped, so there is no response to read and no error path naming an item.
   *
   * Observed on a tenant partway through a template export, against a build that still
   * capped fields at 50 — so this is not a consequence of asking for the whole field set.
   * What actually provokes it is unconfirmed: a single oversized item, the cumulative
   * length of a long run of POSTs, or the edge itself are all consistent with the evidence.
   *
   * Halving works whichever it is, and that is the point. A dropped connection names
   * nothing — there is no response, no error path, no item — so the only lever available is
   * to ask for less and see what still fails. Each half is half the ask, and the recursion
   * bottoms out at a single item, which localises an oversized one for free. An item that
   * still cannot be fetched alone is reported and skipped, the same treatment an item that
   * errors already gets, rather than losing the whole package to it.
   */
  async function pass(
    batch: ItemRef[],
    language: string,
  ): Promise<Record<string, RawItem | null>> {
    try {
      return await passOnce(batch, language);
    } catch (e: unknown) {
      options.signal?.throwIfAborted();
      const message = e instanceof Error ? e.message : String(e);

      if (batch.length === 1) {
        problems.push(
          batch[0].path + " [" + language + "]: the request failed — " + message,
        );
        return {};
      }

      const half = Math.ceil(batch.length / 2);
      const left = await pass(batch.slice(0, half), language);
      const right = await pass(batch.slice(half), language);
      // Each half answers with aliases keyed against ITS OWN array, so the right half's
      // `a0` is the parent's `a{half}`. Re-key rather than merge, or every item after the
      // split is read as the wrong item.
      const data: Record<string, RawItem | null> = {};
      for (let i = 0; i < half; i++) data["a" + i] = left["a" + i] ?? null;
      for (let i = half; i < batch.length; i++) data["a" + i] = right["a" + (i - half)] ?? null;
      return data;
    }
  }

  for (const batch of batches) {
    options.signal?.throwIfAborted();

    // First pass in the source's own language: also tells us which languages exist.
    const firstPass = { data: await pass(batch, primary) };

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
    // The primary language was just fetched for every item in the batch, so it can never
    // need a second pass. It was being re-added whenever an item failed — that item has no
    // content entry, so every language looks missing for it — costing a redundant request
    // and reporting the same failure twice.
    extra.delete(primary);

    for (const language of extra) {
      options.signal?.throwIfAborted();
      const later = { data: await pass(batch, language) };

      for (let i = 0; i < batch.length; i++) {
        const raw = later.data?.["a" + i];
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

  problems.push(...describeDegraded(degraded, primary));

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

    // GraphQL returns no binary at all — a blob field's value is the blob's GUID, not its
    // bytes — so an item carrying one is recorded here and its file is fetched separately
    // through a content-transfer pull (xmc/media.ts). Anything that pull cannot deliver
    // stays in `danglingMedia`, because a package whose media is silently absent is worse
    // than one that says so.
    const mediaField = [...mapped.item.sharedFields, ...mapped.item.languages.flatMap((l) =>
      [...l.unversionedFields, ...l.versions.flatMap((v) => v.fields)],
    )].find((f) => f.type?.toLowerCase() === "attachment" || f.name?.toLowerCase() === "blob");
    if (mediaField) {
      media.push({ path: mapped.item.path, blobId: mediaField.value ?? "" });
    }

    items.push(mapped.item);
  }

  return { items: linkByPath(items, problems), problems, danglingMedia, media };
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
  if (refs.length === 0) return { items: [], problems: [], danglingMedia: [], media: [] };

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
  /** Media bytes that came back, ready for `blob/<db>/<guid>` entries in the zip. */
  blobs: BlobModel[];
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
  const media: MediaRequest[] = [];
  const claimed = new Set<Guid>();
  let duplicates = 0;

  for (const source of definition.sources) {
    options.signal?.throwIfAborted();
    const exported = await exportSource(ctx, source, options);
    problems.push(...exported.problems);
    danglingMedia.push(...exported.danglingMedia);
    media.push(...exported.media);
    for (const item of exported.items) {
      if (claimed.has(item.id)) {
        duplicates++;
        continue;
      }
      claimed.add(item.id);
      items.push(item);
    }
  }

  // The bytes, now that every source has named the media it needs. Deliberately one pull
  // for the whole definition rather than one per source: a transfer is a create, a poll
  // loop and a delete, and the same media item can be claimed by two sources.
  const unique = new Map(media.map((m) => [m.path, m]));
  const fetched = await (options.fetchMedia ?? fetchMedia)(ctx, [...unique.values()], {
    signal: options.signal,
    database: ctx.database,
  });
  problems.push(...fetched.problems);
  danglingMedia.push(...fetched.missing);

  return { items, problems, danglingMedia, media, duplicates, blobs: fetched.blobs };
}
