// The filter chain a dynamic source resolves through.
//
// These semantics decide what ends up in someone's package, and most of them are traps:
// a filter that is present but blank must match EVERYTHING (Sitecore's writer emits
// `<Pattern />` for an untouched filter), an empty `<Exclude>` must subtract NOTHING, and
// a metadata field the API withheld must not quietly fail every item.
//
// Nothing here touches the network — that is the whole reason the predicate lives in
// `core/` rather than next to the walk that feeds it.

import { describe, it, expect } from "vitest";
import {
  activeFilters,
  matches,
  matchesFilters,
  nameMatcher,
  parseSitecoreDate,
  unevaluable,
} from "../filters";
import type { FilterCandidate } from "../filters";
import type { ItemFilters } from "../model";

const TEMPLATE = "{A6C086AD-9651-4912-BC60-512CA5417795}";
const OTHER_TEMPLATE = "{37A75481-CA32-4354-8991-A470426AE164}";

/** A fully-populated candidate; individual tests blank out what they are about. */
function candidate(over: Partial<FilterCandidate> = {}): FilterCandidate {
  return {
    name: "Home Page",
    templateId: TEMPLATE,
    created: new Date("2024-01-15T10:30:00Z"),
    modified: new Date("2024-06-01T12:00:00Z"),
    createdBy: "sitecore\\jane",
    modifiedBy: "sitecore\\bob",
    languages: ["en", "da-DK"],
    neverPublish: false,
    ...over,
  };
}

const NOW = new Date("2024-07-01T00:00:00Z");

describe("a filter that is present but blank", () => {
  // Sitecore writes these for filters the user never filled in. Reading one as a
  // restriction empties the package.
  it("does not restrict anything", () => {
    const blank: ItemFilters = {
      name: { pattern: "", searchType: "Simple" },
      publish: { publishDate: undefined, checkWorkflow: false },
      templates: [],
      createdBy: [],
      modifiedBy: [],
      languages: [],
    };
    expect(activeFilters(blank)).toEqual([]);
    expect(matchesFilters(candidate(), blank, NOW)).toBe(true);
  });

  it("treats a whitespace-only name pattern as unset", () => {
    expect(activeFilters({ name: { pattern: "   ", searchType: "Simple" } })).toEqual([]);
  });

  it("treats `within 0 days` as unset, since the radio button writes 0 before you type", () => {
    expect(activeFilters({ created: { mode: "within", days: 0 } })).toEqual([]);
    expect(matchesFilters(candidate(), { created: { mode: "within", days: 0 } }, NOW)).toBe(true);
  });

  it("treats an empty date range as unset", () => {
    expect(activeFilters({ modified: { mode: "range" } })).toEqual([]);
  });
});

describe("the name filter", () => {
  it("matches a Simple pattern as a case-insensitive substring", () => {
    expect(nameMatcher("home", "Simple")!("Home Page")).toBe(true);
    expect(nameMatcher("PAGE", "Simple")!("Home Page")).toBe(true);
    expect(nameMatcher("news", "Simple")!("Home Page")).toBe(false);
  });

  it("anchors a Wildcards pattern across the whole name", () => {
    const starts = nameMatcher("Home*", "Wildcards")!;
    expect(starts("Home Page")).toBe(true);
    expect(starts("My Home Page")).toBe(false);
    expect(nameMatcher("Ho?e*", "Wildcards")!("Home Page")).toBe(true);
  });

  it("escapes regex metacharacters inside a Wildcards pattern", () => {
    // The dot must be a literal dot, not "any character".
    expect(nameMatcher("a.b", "Wildcards")!("a.b")).toBe(true);
    expect(nameMatcher("a.b", "Wildcards")!("axb")).toBe(false);
  });

  it("matches a Regex pattern unanchored and case-insensitively", () => {
    expect(nameMatcher("^home", "Regex")!("Home Page")).toBe(true);
    expect(nameMatcher("pa(ge|ges)", "Regex")!("Home Page")).toBe(true);
  });

  it("reports an uncompilable regex rather than throwing", () => {
    expect(nameMatcher("(unclosed", "Regex")).toBeUndefined();
  });

  it("lets a broken pattern restrict nothing, instead of failing the whole preview", () => {
    const f: ItemFilters = { name: { pattern: "(unclosed", searchType: "Regex" } };
    expect(() => matchesFilters(candidate(), f, NOW)).not.toThrow();
    expect(matchesFilters(candidate(), f, NOW)).toBe(true);
  });
});

describe("parseSitecoreDate", () => {
  it("reads Sitecore's separator-free format, which `new Date()` rejects", () => {
    expect(parseSitecoreDate("20240115T103000Z")?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  it("reads a bare date in that format", () => {
    expect(parseSitecoreDate("20240115")?.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it("reads the YYYY-MM-DD the designer's own date inputs produce", () => {
    expect(parseSitecoreDate("2024-01-15")?.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it("returns undefined for junk rather than epoch zero, which would pass every date test", () => {
    expect(parseSitecoreDate("not a date")).toBeUndefined();
    expect(parseSitecoreDate("")).toBeUndefined();
    expect(parseSitecoreDate(undefined)).toBeUndefined();
  });
});

describe("date filters", () => {
  it("keeps an item inside `within N days`", () => {
    const f: ItemFilters = { modified: { mode: "within", days: 60 } };
    expect(matchesFilters(candidate(), f, NOW)).toBe(true);
  });

  it("drops an item older than `within N days`", () => {
    const f: ItemFilters = { created: { mode: "within", days: 60 } };
    // Created in January, asked for the last 60 days of a July "now".
    expect(matchesFilters(candidate(), f, NOW)).toBe(false);
  });

  it("applies an open-ended range from one side only", () => {
    expect(matchesFilters(candidate(), { created: { mode: "range", from: "2024-01-01" } }, NOW)).toBe(true);
    expect(matchesFilters(candidate(), { created: { mode: "range", from: "2024-02-01" } }, NOW)).toBe(false);
    expect(matchesFilters(candidate(), { created: { mode: "range", to: "2024-02-01" } }, NOW)).toBe(true);
  });

  it("includes the whole of the end day, not just its midnight", () => {
    // Created 10:30 on the 15th; a range ending on the 15th must still contain it.
    const f: ItemFilters = { created: { mode: "range", to: "2024-01-15" } };
    expect(matchesFilters(candidate(), f, NOW)).toBe(true);
  });
});

describe("the template filter", () => {
  it("matches regardless of braces, dashes or case", () => {
    const bare = TEMPLATE.replace(/[{}-]/g, "").toLowerCase();
    expect(matchesFilters(candidate(), { templates: [bare] }, NOW)).toBe(true);
  });

  it("drops an item using a different template", () => {
    expect(matchesFilters(candidate(), { templates: [OTHER_TEMPLATE] }, NOW)).toBe(false);
  });

  it("accepts any one of several templates", () => {
    expect(matchesFilters(candidate(), { templates: [OTHER_TEMPLATE, TEMPLATE] }, NOW)).toBe(true);
  });
});

describe("the account and language filters", () => {
  it("compares accounts case-insensitively", () => {
    expect(matchesFilters(candidate(), { createdBy: ["SITECORE\\JANE"] }, NOW)).toBe(true);
    expect(matchesFilters(candidate(), { createdBy: ["sitecore\\bob"] }, NOW)).toBe(false);
  });

  it("checks created-by and updated-by separately", () => {
    expect(matchesFilters(candidate(), { modifiedBy: ["sitecore\\bob"] }, NOW)).toBe(true);
    expect(matchesFilters(candidate(), { modifiedBy: ["sitecore\\jane"] }, NOW)).toBe(false);
  });

  it("matches an item that has any one of the listed languages", () => {
    expect(matchesFilters(candidate(), { languages: ["fr-FR", "da-DK"] }, NOW)).toBe(true);
    expect(matchesFilters(candidate(), { languages: ["fr-FR"] }, NOW)).toBe(false);
  });
});

describe("the publish filter", () => {
  it("drops an item marked never publish", () => {
    const f: ItemFilters = { publish: { publishDate: "2024-07-01", checkWorkflow: false } };
    expect(matchesFilters(candidate({ neverPublish: true }), f, NOW)).toBe(false);
  });

  it("honours the valid-from / valid-to window", () => {
    const f: ItemFilters = { publish: { publishDate: "2024-07-01", checkWorkflow: false } };
    expect(matchesFilters(candidate({ validFrom: new Date("2024-01-01") }), f, NOW)).toBe(true);
    expect(matchesFilters(candidate({ validFrom: new Date("2025-01-01") }), f, NOW)).toBe(false);
    expect(matchesFilters(candidate({ validTo: new Date("2024-01-01") }), f, NOW)).toBe(false);
  });

  it("cannot be evaluated when it asks for the workflow state", () => {
    const f: ItemFilters = { publish: { publishDate: "2024-07-01", checkWorkflow: true } };
    expect(activeFilters(f)).toEqual(["publish"]);
    expect(unevaluable(f, candidate())).toEqual(["publish"]);
    // Unevaluable means skipped, not failed.
    expect(matchesFilters(candidate({ neverPublish: true }), f, NOW)).toBe(true);
  });
});

describe("unevaluable", () => {
  it("names the filters whose metadata the API did not return", () => {
    const f: ItemFilters = {
      name: { pattern: "Home", searchType: "Simple" },
      created: { mode: "within", days: 30 },
      createdBy: ["sitecore\\jane"],
      templates: [TEMPLATE],
    };
    // What a "basic" selection yields: identity only.
    const basic: FilterCandidate = { name: "Home Page", templateId: TEMPLATE };
    expect(unevaluable(f, basic).sort()).toEqual(["created", "createdBy"]);
  });

  it("is empty when every active filter has its data", () => {
    const f: ItemFilters = { created: { mode: "within", days: 365 }, templates: [TEMPLATE] };
    expect(unevaluable(f, candidate())).toEqual([]);
  });

  it("never reports name or template, which always come back", () => {
    const f: ItemFilters = { name: { pattern: "x", searchType: "Simple" }, templates: [TEMPLATE] };
    expect(unevaluable(f, { name: "x", templateId: TEMPLATE })).toEqual([]);
  });
});

describe("a filter that cannot be judged", () => {
  // The alternative — failing it — empties the preview whenever the API withholds a
  // field, which reads as "your query matches nothing" and is simply wrong.
  it("is skipped rather than failed", () => {
    const basic: FilterCandidate = { name: "Home Page", templateId: TEMPLATE };
    const f: ItemFilters = { created: { mode: "within", days: 1 } };
    expect(matchesFilters(basic, f, NOW)).toBe(true);
  });

  it("still lets the filters that CAN be judged do their work", () => {
    const basic: FilterCandidate = { name: "Home Page", templateId: TEMPLATE };
    const f: ItemFilters = {
      created: { mode: "within", days: 1 },
      templates: [OTHER_TEMPLATE],
    };
    expect(matchesFilters(basic, f, NOW)).toBe(false);
  });
});

describe("include composition", () => {
  it("requires every active filter to pass", () => {
    const f: ItemFilters = {
      name: { pattern: "Home", searchType: "Simple" },
      templates: [TEMPLATE],
    };
    expect(matchesFilters(candidate(), f, NOW)).toBe(true);
    expect(matchesFilters(candidate({ name: "News" }), f, NOW)).toBe(false);
  });
});

describe("exclude composition", () => {
  // The one that would be catastrophic to get wrong: an empty ItemFilters matches
  // everything, so running the include predicate over an absent <Exclude> would drop the
  // entire subtree.
  it("subtracts nothing when it sets no filters", () => {
    expect(matches(candidate(), {}, {}, NOW)).toBe(true);
  });

  it("drops an item the exclude chain matches", () => {
    const exclude: ItemFilters = { templates: [TEMPLATE] };
    expect(matches(candidate(), {}, exclude, NOW)).toBe(false);
  });

  it("keeps an item the exclude chain does not match", () => {
    const exclude: ItemFilters = { templates: [OTHER_TEMPLATE] };
    expect(matches(candidate(), {}, exclude, NOW)).toBe(true);
  });

  it("applies after include, so exclude can carve out of a matched set", () => {
    const include: ItemFilters = { templates: [TEMPLATE] };
    const exclude: ItemFilters = { name: { pattern: "Home", searchType: "Simple" } };
    expect(matches(candidate(), include, exclude, NOW)).toBe(false);
    expect(matches(candidate({ name: "News" }), include, exclude, NOW)).toBe(true);
  });
});
