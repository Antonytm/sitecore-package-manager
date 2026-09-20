// core/filters — does one item match a source's `<Include>` / `<Exclude>` chain?
//
// A dynamic source stores a query, not a list: a root plus filters, re-resolved against
// live content every time the package is built. The Package Designer's PREVIEW tab is the
// only way to see what that query actually selects before generating a ZIP.
//
// Fetching the items is `xmc/`'s job. Deciding whether one qualifies is pure logic over a
// value, so it lives here — which is also the only way it can be tested: vitest runs in a
// node environment with no jsdom, so anything reachable only through a component or a live
// SDK call is untestable by construction.
//
// The governing rule, from the legacy UI: every filter "is optional (leave blank = no
// restriction)". Sitecore's own writer emits `<ItemNameFilter><Pattern /></ItemNameFilter>`
// for a filter the user never filled in, so a filter that is PRESENT but EMPTY has to match
// everything. Getting that backwards silently empties the package.

import type { DateFilter, Guid, ItemFilters } from "./model";

/**
 * The facts about one item that a filter can test.
 *
 * Every metadata field is optional because the Authoring API may not return it — see
 * {@link unevaluable}. `name` and `templateId` always come back, so those two filters can
 * always be applied.
 */
export interface FilterCandidate {
  name: string;
  templateId: Guid;
  created?: Date;
  modified?: Date;
  /** `domain\user`, as Sitecore stores it. */
  createdBy?: string;
  modifiedBy?: string;
  languages?: string[];
  neverPublish?: boolean;
  validFrom?: Date;
  validTo?: Date;
}

/** The eight filters the legacy designer offers for an item source. */
export type FilterKey =
  | "name"
  | "created"
  | "modified"
  | "publish"
  | "templates"
  | "createdBy"
  | "modifiedBy"
  | "languages";

/** How each filter reads in a sentence, for the "could not apply" notice. */
export const FILTER_LABELS: Record<FilterKey, string> = {
  name: "item name",
  created: "creation date",
  modified: "modification date",
  publish: "publish date",
  templates: "template",
  createdBy: "created by",
  modifiedBy: "updated by",
  languages: "language",
};

// ── dates ───────────────────────────────────────────────────────────────────

/**
 * Parse the two date shapes this code meets.
 *
 * Sitecore stores `__Created` / `__Updated` in ISO-8601 *basic* format —
 * `20240115T103000Z`, no separators — which `new Date()` does not accept. The designer's
 * own range inputs are `<input type="date">`, so they produce `YYYY-MM-DD`. Both arrive
 * here, so both are handled; anything else is treated as absent rather than as epoch zero,
 * since a silent 1970 would quietly pass every "not older than" test.
 */
export function parseSitecoreDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;

  const basic = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/.exec(value);
  if (basic) {
    const [, y, m, d, hh, mm, ss] = basic;
    return new Date(Date.UTC(+y, +m - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0)));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Whether a date filter constrains anything.
 *
 * `days: 0` counts as unset. `DateFilterFields` writes `{ mode: "within", days: 0 }` the
 * moment the radio button is clicked, before any number is typed, so reading 0 as "within
 * the past zero days" would make merely *looking* at the filter exclude the whole subtree.
 */
function dateFilterActive(filter: DateFilter | undefined): boolean {
  if (!filter) return false;
  if (filter.mode === "within") return filter.days > 0;
  return Boolean(filter.from ?? filter.to);
}

function matchesDate(value: Date | undefined, filter: DateFilter, now: Date): boolean {
  if (!value) return false;
  if (filter.mode === "within") {
    return value.getTime() >= now.getTime() - filter.days * 86_400_000;
  }
  const from = parseSitecoreDate(filter.from);
  const to = parseSitecoreDate(filter.to);
  if (from && value.getTime() < from.getTime()) return false;
  // An end date names a whole day: `<input type="date">` gives midnight, and an item saved
  // that afternoon is plainly within "up to and including" it.
  if (to && value.getTime() > to.getTime() + 86_399_999) return false;
  return true;
}

// ── name ────────────────────────────────────────────────────────────────────

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the matcher for the name filter's three search types.
 *
 * Returns undefined for a pattern that cannot compile — a half-typed regular expression is
 * a normal state of an input box, not a reason to fail the whole preview.
 */
export function nameMatcher(
  pattern: string,
  searchType: "Simple" | "Regex" | "Wildcards",
): ((name: string) => boolean) | undefined {
  if (searchType === "Simple") {
    const needle = pattern.toLowerCase();
    return (name) => name.toLowerCase().includes(needle);
  }

  // Wildcards cover the whole name: "Home*" means "starts with Home", not "contains".
  const source =
    searchType === "Wildcards"
      ? "^" + escapeRegex(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$"
      : pattern;

  try {
    const regex = new RegExp(source, "i");
    return (name) => regex.test(name);
  } catch {
    return undefined;
  }
}

// ── which filters are set, and which can be judged ──────────────────────────

/** Compare ids regardless of braces, case or dashes. */
function sameGuid(a: string, b: string): boolean {
  return a.replace(/[{}-]/g, "").toLowerCase() === b.replace(/[{}-]/g, "").toLowerCase();
}

function has(list: readonly string[] | undefined): boolean {
  return Boolean(list && list.length > 0);
}

/**
 * The filters this object actually constrains.
 *
 * Preview reports these to the user, so "no filters — everything under the root" is an
 * honest statement rather than a guess.
 */
export function activeFilters(f: ItemFilters): FilterKey[] {
  const keys: FilterKey[] = [];
  if (f.name && f.name.pattern.trim() !== "") keys.push("name");
  if (dateFilterActive(f.created)) keys.push("created");
  if (dateFilterActive(f.modified)) keys.push("modified");
  // A publish filter with neither a date nor the workflow check restricts nothing.
  if (f.publish && (f.publish.publishDate || f.publish.checkWorkflow)) keys.push("publish");
  if (has(f.templates)) keys.push("templates");
  if (has(f.createdBy)) keys.push("createdBy");
  if (has(f.modifiedBy)) keys.push("modifiedBy");
  if (has(f.languages)) keys.push("languages");
  return keys;
}

/** The metadata each filter needs before it can be judged at all. */
function dataPresent(key: FilterKey, c: FilterCandidate, f: ItemFilters): boolean {
  switch (key) {
    case "name":
    case "templates":
      return true;
    case "created":
      return c.created !== undefined;
    case "modified":
      return c.modified !== undefined;
    case "createdBy":
      return c.createdBy !== undefined;
    case "modifiedBy":
      return c.modifiedBy !== undefined;
    case "languages":
      return c.languages !== undefined;
    case "publish":
      // Workflow state needs a lookup we do not have, so a filter asking for it cannot be
      // honoured even when every publish field came back.
      return !f.publish?.checkWorkflow && c.neverPublish !== undefined;
  }
}

/**
 * Active filters that this candidate carries no data for.
 *
 * Preview applies what it can and says what it could not, rather than pretending a
 * date-filtered source resolves to the whole subtree.
 */
export function unevaluable(f: ItemFilters, sample: FilterCandidate): FilterKey[] {
  return activeFilters(f).filter((key) => !dataPresent(key, sample, f));
}

// ── the predicate ───────────────────────────────────────────────────────────

/**
 * Whether the candidate satisfies every filter the object actually sets.
 *
 * Filters that cannot be judged are skipped rather than failed — the alternative is an
 * empty preview whenever the API withholds a field, which reads as "your query matches
 * nothing" and is simply wrong. {@link unevaluable} is what tells the user instead.
 */
export function matchesFilters(
  c: FilterCandidate,
  f: ItemFilters,
  now: Date = new Date(),
): boolean {
  for (const key of activeFilters(f)) {
    if (!dataPresent(key, c, f)) continue;

    switch (key) {
      case "name": {
        const match = nameMatcher(f.name!.pattern, f.name!.searchType);
        // An uncompilable pattern restricts nothing; nameMatcher explains why.
        if (match && !match(c.name)) return false;
        break;
      }
      case "created":
        if (!matchesDate(c.created, f.created!, now)) return false;
        break;
      case "modified":
        if (!matchesDate(c.modified, f.modified!, now)) return false;
        break;
      case "templates":
        if (!f.templates!.some((id) => sameGuid(id, c.templateId))) return false;
        break;
      case "createdBy":
        if (!f.createdBy!.some((a) => a.toLowerCase() === c.createdBy!.toLowerCase())) {
          return false;
        }
        break;
      case "modifiedBy":
        if (!f.modifiedBy!.some((a) => a.toLowerCase() === c.modifiedBy!.toLowerCase())) {
          return false;
        }
        break;
      case "languages":
        if (!f.languages!.some((l) => c.languages!.some((h) => h.toLowerCase() === l.toLowerCase()))) {
          return false;
        }
        break;
      case "publish": {
        if (c.neverPublish) return false;
        const at = parseSitecoreDate(f.publish!.publishDate) ?? now;
        if (c.validFrom && at.getTime() < c.validFrom.getTime()) return false;
        if (c.validTo && at.getTime() > c.validTo.getTime()) return false;
        break;
      }
    }
  }
  return true;
}

/**
 * The whole chain: kept by `<Include>`, then dropped by `<Exclude>`.
 *
 * The asymmetry is deliberate. An empty `ItemFilters` matches everything, which is right
 * for include and catastrophic for exclude — running the same predicate both ways would
 * make a source with no exclude filters resolve to nothing at all. So exclude only
 * subtracts when it actually constrains something.
 */
export function matches(
  c: FilterCandidate,
  include: ItemFilters,
  exclude: ItemFilters,
  now: Date = new Date(),
): boolean {
  if (!matchesFilters(c, include, now)) return false;
  if (activeFilters(exclude).length === 0) return true;
  return !matchesFilters(c, exclude, now);
}
