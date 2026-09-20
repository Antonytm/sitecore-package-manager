// xmc/resolve — what does a source actually contribute?
//
// This is the read half of the Create flow's first phase: turn a source DEFINITION into the
// list of entries it resolves to right now. A static source already is that list; a dynamic
// source is a root plus filters that only mean something against live content.
//
// It backs the Package Designer's two Preview surfaces — the per-source PREVIEW tab and the
// ribbon's whole-package Preview. `export.ts` will build on it later: generation needs the
// same entry list plus every field, version and blob behind it, which Preview does not.
//
// The filter predicates themselves are in `core/filters` — pure, and tested there. What
// lives here is the I/O: walking the tree, and getting enough metadata back to judge.

import { formatAccountRef, formatItemRef } from "../core/definition";
import { matches, nameMatcher, parseSitecoreDate, unevaluable } from "../core/filters";
import type { FilterCandidate, FilterKey } from "../core/filters";
import type {
  BehaviourOptions,
  ItemFilters,
  ItemRef,
  PackageDefinition,
  SourceDefinition,
} from "../core/model";
import { authoringGraphql } from "./authoring";
import { SUBTREE_LIMIT, enumerateSubtree, toBracedGuid } from "./browse";
import type { ItemNode, ItemQuery } from "./browse";
import type { XmcContext } from "./client";

// ── the selection ladder ────────────────────────────────────────────────────
//
// Five of the eight filters test metadata the picker queries never ask for. Which richer
// selection an Authoring endpoint accepts is not something we can know from here, and a
// field it rejects fails the WHOLE query at validation — so rather than guess once, try
// progressively weaker selections and keep the first that validates.
//
// The picker documents in browse.ts are deliberately not touched by any of this: the
// content tree must keep working even if every variant below is refused.

/** The standard fields the date, account and publish filters test. */
const META_FIELDS = [
  "__Created",
  "__Updated",
  "__Created by",
  "__Updated by",
  "__Never publish",
  "__Valid from",
  "__Valid to",
];

const BASE_FIELDS = `
  itemId
  name
  path
  hasChildren
  template { templateId name }
`;

interface PreviewSelection {
  id: "rich" | "rich-all" | "basic";
  fields: string;
  /** Whether this selection is meant to carry metadata at all. */
  carriesMetadata: boolean;
}

const SELECTIONS: PreviewSelection[] = [
  {
    id: "rich",
    carriesMetadata: true,
    fields: `
      ${BASE_FIELDS}
      languages { name }
      fields(names: [${META_FIELDS.map((f) => '"' + f + '"').join(", ")}]) {
        nodes { name value }
      }
    `,
  },
  // Same data without the `names` argument, in case the endpoint has no such filter.
  // Heavier per item, which is why it is second rather than first.
  {
    id: "rich-all",
    carriesMetadata: true,
    fields: `
      ${BASE_FIELDS}
      languages { name }
      fields { nodes { name value } }
    `,
  },
  { id: "basic", carriesMetadata: false, fields: BASE_FIELDS },
];

function documentFor(selection: PreviewSelection, withChildren: boolean): string {
  const children = withChildren ? `children { nodes { ${selection.fields} } }` : "";
  return `
    query PreviewItem($path: String, $itemId: ID, $language: String, $database: String) {
      item(where: { path: $path, itemId: $itemId, language: $language, database: $database }) {
        ${selection.fields}
        ${children}
      }
    }
  `;
}

/** What this endpoint turned out to support. */
interface Negotiated {
  selection: PreviewSelection;
  /** Filters the fetched data can actually decide. */
  supported: Set<FilterKey>;
}

/**
 * What this session settled on.
 *
 * Cached because the probe costs a request and the answer cannot change mid-session; a
 * walk must also commit to ONE document, or half the items come back without metadata and
 * the filters apply inconsistently.
 */
let agreed: Negotiated | undefined;

/** Testing seam — the module-level cache would otherwise leak between cases. */
export function resetPreviewSelection(): void {
  agreed = undefined;
}

/** Name and template read the base selection, which the pickers prove works. */
const ALWAYS: FilterKey[] = ["name", "templates"];

/**
 * What a probe response proves, field by field.
 *
 * Checking VALUES, not just that the query validated, is the whole point. A field name the
 * schema does not know is a validation error and throws — but a *Sitecore* field name that
 * does not exist is only an argument, so `fields(names: ["__Craeted"])` returns an empty
 * list, no error. Trusting the absence of a throw would leave every date filter matching
 * nothing and reporting itself as applied, which is the worst of both outcomes.
 */
function capabilitiesFrom(raw: RawPreviewItem | null): Set<FilterKey> {
  const supported = new Set<FilterKey>(ALWAYS);
  if (!raw) return supported;

  const values = new Map<string, string>();
  for (const field of raw.fields?.nodes ?? []) {
    if (field.name && field.value) values.set(field.name, field.value);
  }

  // Every Sitecore item has these, so an empty value means we asked the wrong question.
  if (values.has("__Created")) {
    supported.add("created");
    supported.add("modified");
  }
  if (values.has("__Created by")) {
    supported.add("createdBy");
    supported.add("modifiedBy");
  }
  // The publish fields are legitimately blank on most items, so they cannot be asserted
  // the same way; reaching the standard fields at all is the best evidence available.
  if (values.has("__Created")) supported.add("publish");
  if ((raw.languages ?? []).length > 0) supported.add("languages");

  return supported;
}

/**
 * Settle on a selection, trying the ladder once.
 *
 * A rung that throws is refused by the schema; a rung that returns without the values we
 * asked for is answering a different question than we think. Both mean "try the next one".
 */
async function negotiate(ctx: XmcContext, root: ItemQuery): Promise<Negotiated> {
  if (agreed) return agreed;

  for (const selection of SELECTIONS) {
    if (!selection.carriesMetadata) break;
    let raw: RawPreviewItem | null;
    try {
      raw = await runQuery(ctx, documentFor(selection, false), root);
    } catch {
      continue;
    }
    const supported = capabilitiesFrom(raw);
    if (supported.size > ALWAYS.length) {
      agreed = { selection, supported };
      return agreed;
    }
  }

  // The floor: exactly what the content-tree pickers ask for, which is known to work.
  agreed = {
    selection: SELECTIONS[SELECTIONS.length - 1],
    supported: new Set(ALWAYS),
  };
  return agreed;
}

// ── fetching ────────────────────────────────────────────────────────────────

interface RawField {
  name?: string;
  value?: string;
}

interface RawPreviewItem {
  itemId?: string;
  name?: string;
  path?: string;
  hasChildren?: boolean;
  template?: { templateId?: string; name?: string } | null;
  languages?: { name?: string }[] | null;
  fields?: { nodes?: RawField[] } | null;
  children?: { nodes?: RawPreviewItem[] } | null;
}

function variablesFor(ctx: XmcContext, q: ItemQuery): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  if (q.path) variables.path = q.path;
  // The API wants a bare GUID; the app carries braced ones.
  if (q.itemId) variables.itemId = q.itemId.replace(/[{}]/g, "");
  if (q.language) variables.language = q.language;
  const database = q.database ?? ctx.database;
  if (database) variables.database = database;
  return variables;
}

async function runQuery(
  ctx: XmcContext,
  document: string,
  q: ItemQuery,
): Promise<RawPreviewItem | null> {
  const data = await authoringGraphql<{ item: RawPreviewItem | null }>(
    ctx,
    document,
    variablesFor(ctx, q),
  );
  return data.item ?? null;
}

function toNode(raw: RawPreviewItem, selection: PreviewSelection): ItemNode {
  const node: ItemNode = {
    id: toBracedGuid(raw.itemId ?? ""),
    name: raw.name ?? "",
    path: raw.path ?? "",
    hasChildren: raw.hasChildren ?? false,
    templateId: toBracedGuid(raw.template?.templateId ?? ""),
    templateName: raw.template?.name ?? "",
  };

  if (selection.carriesMetadata) {
    const fields: Record<string, string> = {};
    for (const field of raw.fields?.nodes ?? []) {
      if (field.name) fields[field.name] = field.value ?? "";
    }
    node.meta = {
      fields,
      languages: (raw.languages ?? []).map((l) => l.name ?? "").filter(Boolean),
    };
  }

  return node;
}

// ── metadata → the value the predicate tests ────────────────────────────────

function toCandidate(node: ItemNode): FilterCandidate {
  const meta = node.meta;
  const fields = meta?.fields ?? {};
  const text = (key: string) => (fields[key] ?? "") || undefined;

  return {
    name: node.name,
    templateId: node.templateId,
    created: parseSitecoreDate(fields["__Created"]),
    modified: parseSitecoreDate(fields["__Updated"]),
    createdBy: text("__Created by"),
    modifiedBy: text("__Updated by"),
    languages: meta?.languages,
    // Undefined rather than false when there is no metadata at all: that is the difference
    // between "this item publishes" and "we never asked", and only the second should be
    // reported as a filter we could not apply.
    neverPublish: meta ? fields["__Never publish"] === "1" : undefined,
    validFrom: parseSitecoreDate(fields["__Valid from"]),
    validTo: parseSitecoreDate(fields["__Valid to"]),
  };
}

/**
 * A candidate shaped like the data this endpoint returns, used to ask which filters can be
 * judged at all.
 *
 * Asking a real item instead would be wrong: one item that genuinely has no `__Created by`
 * value would make us report the created-by filter as unsupported for the whole run.
 */
function sampleFor(supported: Set<FilterKey>): FilterCandidate {
  const when = (key: FilterKey) => supported.has(key);
  return {
    name: "",
    templateId: "",
    created: when("created") ? new Date(0) : undefined,
    modified: when("modified") ? new Date(0) : undefined,
    createdBy: when("createdBy") ? "" : undefined,
    modifiedBy: when("modifiedBy") ? "" : undefined,
    languages: when("languages") ? [] : undefined,
    neverPublish: when("publish") ? false : undefined,
  };
}

/**
 * Filters the source sets that this run cannot decide.
 *
 * Both chains are asked, since an exclude filter that silently does nothing widens the
 * package just as much as an include one that does.
 */
function unevaluatedFor(
  supported: Set<FilterKey>,
  include: ItemFilters,
  exclude: ItemFilters,
): FilterKey[] {
  const sample = sampleFor(supported);
  return [...new Set([...unevaluable(include, sample), ...unevaluable(exclude, sample)])];
}

// ── the public shape ────────────────────────────────────────────────────────

/** One row of a preview. */
export interface PreviewEntry {
  /** The `<x-item>` key — what the generator's `Uniq` sink de-duplicates on. */
  key: string;
  /** Present for item sources; file and account entries have no item reference. */
  ref?: ItemRef;
}

export interface ResolvedSource {
  entries: PreviewEntry[];
  /** How many items were examined — for a dynamic source, the whole subtree. */
  scanned: number;
  /** The walk stopped at the cap, so the list below is a prefix of the real answer. */
  truncated: boolean;
  /** Filters this source sets that the run could not judge, so the UI can say so. */
  unevaluated: FilterKey[];
  /** Why this source resolves to nothing, when that is by design rather than by query. */
  note?: string;
}

export interface ResolveOptions {
  signal?: AbortSignal;
  /** Called with the running count of items examined; drives the progress line. */
  onProgress?: (scanned: number) => void;
  limit?: number;
}

/** What a dynamic source resolves to right now. */
async function resolveDynamic(
  ctx: XmcContext,
  source: Extract<SourceDefinition, { kind: "items-dynamic" }>,
  options: ResolveOptions,
): Promise<ResolvedSource> {
  if (!source.root) {
    return {
      entries: [],
      scanned: 0,
      truncated: false,
      unevaluated: [],
      note: "No search root is set yet.",
    };
  }

  // A pattern that cannot compile would otherwise restrict nothing, and a preview that
  // quietly ignores the filter you are looking at is worse than one that refuses to run.
  for (const chain of [source.include, source.exclude]) {
    if (chain.name && chain.name.pattern.trim() !== "") {
      if (!nameMatcher(chain.name.pattern, chain.name.searchType)) {
        throw new Error(
          'Item name filter: "' + chain.name.pattern + '" is not a valid ' +
            chain.name.searchType.toLowerCase() + " pattern.",
        );
      }
    }
  }

  const root: ItemQuery = { itemId: source.root, database: source.database };
  const { selection, supported } = await negotiate(ctx, root);
  const withChildren = documentFor(selection, true);
  const itemOnly = documentFor(selection, false);
  const limit = options.limit ?? SUBTREE_LIMIT;

  const nodes = await enumerateSubtree(ctx, root, {
    signal: options.signal,
    limit,
    truncateAtLimit: true,
    onProgress: options.onProgress,
    fetchRoot: async (q) => {
      const raw = await runQuery(ctx, itemOnly, q);
      return raw ? toNode(raw, selection) : undefined;
    },
    fetchChildren: async (q) => {
      const raw = await runQuery(ctx, withChildren, q);
      return (raw?.children?.nodes ?? []).map((child) => toNode(child, selection));
    },
  });

  // The root is filtered alongside its descendants — it is an item like any other, and the
  // legacy source walks the subtree "under Root" without exempting it.
  const now = new Date();
  const entries: PreviewEntry[] = [];
  for (const node of nodes) {
    if (!matches(toCandidate(node), source.include, source.exclude, now)) continue;
    const ref: ItemRef = {
      database: source.database,
      path: node.path.replace(/\/[^/]*$/, "") || "/",
      id: node.id,
      language: "invariant",
      version: 0,
    };
    entries.push({ key: formatItemRef(ref), ref });
  }

  return {
    entries,
    scanned: nodes.length,
    truncated: nodes.length >= limit,
    unevaluated: unevaluatedFor(supported, source.include, source.exclude),
  };
}

/**
 * What one source contributes.
 *
 * Static kinds are already their own answer and cost no requests; only a dynamic item
 * source has to go and look.
 */
export async function resolveSource(
  ctx: XmcContext,
  source: SourceDefinition,
  options: ResolveOptions = {},
): Promise<ResolvedSource> {
  switch (source.kind) {
    case "items-dynamic":
      return resolveDynamic(ctx, source, options);

    case "items-static": {
      const entries = source.entries.map((ref) => ({ key: formatItemRef(ref), ref }));
      return { entries, scanned: entries.length, truncated: false, unevaluated: [] };
    }

    case "files-static": {
      const entries = source.entries.map((path) => ({ key: path }));
      return { entries, scanned: entries.length, truncated: false, unevaluated: [] };
    }

    case "accounts": {
      const entries = source.entries.map((a) => ({ key: formatAccountRef(a) }));
      return { entries, scanned: entries.length, truncated: false, unevaluated: [] };
    }

    case "files-dynamic":
      // A query over a server file system SitecoreAI does not have. The source is preserved
      // in the definition, but there is nothing here to resolve it against.
      return {
        entries: [],
        scanned: 0,
        truncated: false,
        unevaluated: [],
        note: "File sources cannot be resolved — SitecoreAI has no server file system.",
      };
  }
}

// ── the whole package ───────────────────────────────────────────────────────

/** One source's contribution to the package preview. */
export interface PreviewSourceSummary {
  uid: string;
  name: string;
  kind: SourceDefinition["kind"];
  behaviour: BehaviourOptions;
  /** Entries this source contributed AFTER duplicates were removed. */
  contributed: number;
  /** Entries it resolved to before another source had already claimed them. */
  resolved: number;
  unevaluated: FilterKey[];
  note?: string;
  /** Set when this source failed; the rest of the package still previews. */
  error?: string;
}

export interface PackagePreview {
  /** Deduplicated, in the order the sources are listed. */
  entries: (PreviewEntry & { sourceUid: string })[];
  /** Entries dropped because an earlier source already contributed the same key. */
  duplicates: number;
  sources: PreviewSourceSummary[];
}

/**
 * What the built package would contain.
 *
 * Duplicates are removed exactly as generation does — the `Uniq` sink collapses entries by
 * key, so listing the same item in two sources is harmless. First source to claim a key
 * keeps it, which is also what makes the per-source counts add up.
 *
 * One source failing does not fail the preview: its error is recorded against that source
 * and the others still resolve, because "your third source has a bad root" is far more
 * useful than a single red message with nothing behind it.
 */
export async function resolveDefinition(
  ctx: XmcContext,
  definition: PackageDefinition,
  options: ResolveOptions = {},
): Promise<PackagePreview> {
  const entries: (PreviewEntry & { sourceUid: string })[] = [];
  const sources: PreviewSourceSummary[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let scanned = 0;

  for (const source of definition.sources) {
    const summary: PreviewSourceSummary = {
      uid: source.uid,
      name: source.name,
      kind: source.kind,
      behaviour: source.behaviour,
      contributed: 0,
      resolved: 0,
      unevaluated: [],
    };
    sources.push(summary);

    let resolved: ResolvedSource;
    try {
      // Progress is reported as a running total across the whole package. Passing the
      // caller's callback straight through would restart the count at zero on every
      // source, which reads as the walk going backwards.
      resolved = await resolveSource(ctx, source, {
        ...options,
        onProgress: options.onProgress && ((n) => options.onProgress!(scanned + n)),
      });
    } catch (error) {
      // An abort is the user's decision about the whole preview, not one source's failure.
      if (options.signal?.aborted) throw error;
      summary.error = error instanceof Error ? error.message : String(error);
      continue;
    }

    scanned += resolved.scanned;
    summary.resolved = resolved.entries.length;
    summary.unevaluated = resolved.unevaluated;
    summary.note = resolved.note;

    for (const entry of resolved.entries) {
      if (seen.has(entry.key)) {
        duplicates += 1;
        continue;
      }
      seen.add(entry.key);
      entries.push({ ...entry, sourceUid: source.uid });
      summary.contributed += 1;
    }
  }

  return { entries, duplicates, sources };
}
