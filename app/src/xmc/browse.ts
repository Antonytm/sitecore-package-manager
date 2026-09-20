// xmc/browse — read-only lookups that back the Package Designer's pickers.
//
// The legacy designer browsed a live Sitecore database (Select Items, Select Root Item,
// the template dual-list, the language checklist, the account grid). Those all map onto
// Authoring GraphQL here — except languages, which have a first-class typed operation.
//
// Nothing in this module writes. Resolving a source definition into actual items is the
// Create flow's job and lives in export.ts.

import type { Guid, ItemRef } from "../core/model";
import { authoringGraphql } from "./authoring";
import type { XmcContext } from "./client";

/**
 * Extra item facts, carried only when the caller asked a selection that fetches them.
 *
 * Kept as raw field values rather than a typed shape: this module browses, it does not
 * interpret. Preview's resolver owns both the selection that fills this in and the
 * mapping out of it, so browse.ts does not have to know what a filter is.
 */
export interface ItemMeta {
  /** Standard-field values keyed by field name — `__Created`, `__Updated`, … */
  fields: Record<string, string>;
  /** Language codes the item has a version in. */
  languages?: string[];
}

/** A node in the content tree picker. */
export interface ItemNode {
  /** Braced, upper-case — the form the package format uses. */
  id: Guid;
  name: string;
  path: string;
  hasChildren: boolean;
  templateId: Guid;
  templateName: string;
  /** Absent for the picker queries; populated by Preview's richer selection. */
  meta?: ItemMeta;
}

/**
 * The Authoring API returns bare lower-case GUIDs; the package format writes them
 * braced and upper-case. Normalising here keeps the rest of the app in one convention.
 */
export function toBracedGuid(raw: string): Guid {
  const bare = raw.replace(/[{}]/g, "").toUpperCase();
  if (bare.length === 32) {
    return (
      "{" +
      bare.slice(0, 8) + "-" + bare.slice(8, 12) + "-" + bare.slice(12, 16) +
      "-" + bare.slice(16, 20) + "-" + bare.slice(20) +
      "}"
    );
  }
  return "{" + bare + "}";
}

interface RawItem {
  itemId?: string;
  name?: string;
  path?: string;
  hasChildren?: boolean;
  template?: { templateId?: string; name?: string } | null;
}

function toNode(raw: RawItem): ItemNode {
  return {
    id: toBracedGuid(raw.itemId ?? ""),
    name: raw.name ?? "",
    path: raw.path ?? "",
    hasChildren: raw.hasChildren ?? false,
    templateId: toBracedGuid(raw.template?.templateId ?? ""),
    templateName: raw.template?.name ?? "",
  };
}

const ITEM_FIELDS = `
  itemId
  name
  path
  hasChildren
  template { templateId name }
`;

const ITEM_WITH_CHILDREN = `
  query ItemWithChildren($path: String, $itemId: ID, $language: String, $database: String) {
    item(where: { path: $path, itemId: $itemId, language: $language, database: $database }) {
      ${ITEM_FIELDS}
      children { nodes { ${ITEM_FIELDS} } }
    }
  }
`;

const ITEM_ONLY = `
  query Item($path: String, $itemId: ID, $language: String, $database: String) {
    item(where: { path: $path, itemId: $itemId, language: $language, database: $database }) {
      ${ITEM_FIELDS}
    }
  }
`;

/** Where to look an item up — by path or by id. */
export interface ItemQuery {
  path?: string;
  itemId?: Guid;
  language?: string;
  database?: string;
}

/**
 * Build the GraphQL variables.
 *
 * Absent keys are OMITTED rather than sent as null: per the GraphQL spec an unsupplied
 * variable is left out of the input object entirely, whereas an explicit null is a real
 * value — and `where: { path: null, itemId: null }` is not a query that can match.
 */
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

/** One item, without its children. Returns undefined when it does not exist. */
export async function getItem(ctx: XmcContext, q: ItemQuery): Promise<ItemNode | undefined> {
  const data = await authoringGraphql<{ item: RawItem | null }>(ctx, ITEM_ONLY, variablesFor(ctx, q));
  return data.item ? toNode(data.item) : undefined;
}

/** An item's direct children — one level of the tree picker. */
export async function getChildren(ctx: XmcContext, q: ItemQuery): Promise<ItemNode[]> {
  const data = await authoringGraphql<{
    item: (RawItem & { children?: { nodes?: RawItem[] } }) | null;
  }>(ctx, ITEM_WITH_CHILDREN, variablesFor(ctx, q));
  return (data.item?.children?.nodes ?? []).map(toNode);
}

/** The root of the content tree, matching the legacy picker's `sitecore` node. */
export const TREE_ROOT_PATH = "/sitecore";

/** Where the template dual-list picker starts. */
export const TEMPLATES_ROOT_PATH = "/sitecore/templates";

/**
 * Databases offered by the picker.
 *
 * The Authoring API is effectively scoped to `master`; `core` and `web` are offered
 * because the definition format records a database per entry and packages authored
 * elsewhere may name them, but browsing them is best-effort.
 */
export function listDatabases(): string[] {
  return ["master", "core", "web"];
}

// ── languages ───────────────────────────────────────────────────────────────

export interface LanguageInfo {
  /** The code written into `ItemLanguageFilter`, e.g. `en` or `ja-JP`. */
  code: string;
  displayName: string;
}

interface RawLanguage {
  iso?: string | null;
  regionalIsoCode?: string | null;
  name?: string | null;
  displayName?: string | null;
  englishName?: string | null;
}

/**
 * Site languages. Unlike everything else here this has a typed operation, so it goes
 * through `client.query` — note the xmc.* return shape is the RequestResult, hence
 * the `.data.data` unwrap.
 */
export async function listLanguages(ctx: XmcContext): Promise<LanguageInfo[]> {
  const result = await ctx.client.query("xmc.xmapp.listLanguages", {
    params: ctx.contextId ? { query: { sitecoreContextId: ctx.contextId } } : {},
  });
  const raw = (result as { data?: { data?: RawLanguage[] } } | undefined)?.data?.data ?? [];
  return raw
    .map((l) => ({
      code: l.name ?? l.regionalIsoCode ?? l.iso ?? "",
      displayName: l.englishName ?? l.displayName ?? l.name ?? l.iso ?? "",
    }))
    .filter((l) => l.code !== "");
}

// ── subtree enumeration ─────────────────────────────────────────────────────

/** Guard against walking an unexpectedly huge subtree into the browser's memory. */
export const SUBTREE_LIMIT = 5000;

export class SubtreeTooLargeError extends Error {
  constructor(readonly limit: number) {
    super("Subtree exceeds " + limit + " items; narrow the selection or use a dynamic source");
    this.name = "SubtreeTooLargeError";
  }
}

export interface EnumerateSubtreeOptions {
  /** Called after each level, with the running total — this drives the progress line. */
  onProgress?: (count: number) => void;
  limit?: number;
  /**
   * Cancels the walk.
   *
   * Checked between requests rather than during one: the Marketplace SDK posts through
   * the parent frame and takes no signal, so a request already in flight has to land.
   * Cancel latency is therefore one round-trip, not the remaining thousands of items.
   */
  signal?: AbortSignal;
  /**
   * Replace the per-level fetch.
   *
   * Preview needs the same walk over a selection that also carries item metadata. Passing
   * the fetchers in keeps the queue, the limit guard and the abort check in one place
   * rather than growing a second, subtly different copy of this loop.
   */
  fetchRoot?: (q: ItemQuery) => Promise<ItemNode | undefined>;
  fetchChildren?: (q: ItemQuery) => Promise<ItemNode[]>;
  /**
   * Stop at `limit` and return what was collected, instead of throwing.
   *
   * Add with Subitems wants the throw: it builds a STORED entry list, and a breadth-first
   * cut through a subtree is not a selection anyone asked for. Preview is informational,
   * where the same cut is genuinely useful — so it opts in, and reports the truncation.
   */
  truncateAtLimit?: boolean;
}

/**
 * Walk a subtree breadth-first, returning every descendant including the root.
 *
 * This backs **Add with Subitems**: a static source stores an explicit entry per item,
 * so the tree genuinely has to be expanded at design time — that is what makes a static
 * source a snapshot rather than a query.
 *
 * A wide subtree is one request per level and can run for minutes, so this must stay
 * interruptible; an aborted walk throws the signal's reason (an `AbortError` by default)
 * and returns nothing. Partial results are deliberately discarded — a breadth-first cut
 * through a subtree is not a selection anyone asked for.
 */
export async function enumerateSubtree(
  ctx: XmcContext,
  root: ItemQuery,
  options: EnumerateSubtreeOptions = {},
): Promise<ItemNode[]> {
  const {
    onProgress,
    limit = SUBTREE_LIMIT,
    signal,
    fetchRoot = (q) => getItem(ctx, q),
    fetchChildren = (q) => getChildren(ctx, q),
    truncateAtLimit = false,
  } = options;

  signal?.throwIfAborted();

  const start = await fetchRoot(root);
  if (!start) return [];

  const collected: ItemNode[] = [start];
  const queue: ItemNode[] = start.hasChildren ? [start] : [];

  while (queue.length > 0) {
    signal?.throwIfAborted();

    const next = queue.shift() as ItemNode;
    const children = await fetchChildren({
      itemId: next.id,
      language: root.language,
      database: root.database,
    });
    for (const child of children) {
      collected.push(child);
      if (collected.length > limit) {
        if (!truncateAtLimit) throw new SubtreeTooLargeError(limit);
        // One over the limit is what detects truncation; hand back exactly the limit.
        return collected.slice(0, limit);
      }
      if (child.hasChildren) queue.push(child);
    }
    onProgress?.(collected.length);
  }
  return collected;
}

/** Turn a browsed node into the `<x-item>` reference a static source stores. */
export function toItemRef(node: ItemNode, database: string): ItemRef {
  return {
    database,
    // The designer writes the parent path; the id segment follows it in the reference.
    path: node.path.replace(/\/[^/]*$/, "") || "/",
    id: node.id,
    // "invariant/0" = all languages, all versions, which is what picking an item means.
    language: "invariant",
    version: 0,
  };
}
