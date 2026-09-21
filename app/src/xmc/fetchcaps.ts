// xmc/fetchcaps — what this endpoint can actually tell us about an item.
//
// Generating a package needs far more than browsing does: a field's GUID and type, whether
// its value is the item's OWN or inherited from __Standard values, the version numbers, the
// languages, and a promise that a wide folder was not silently truncated.
//
// None of that is documented for the Authoring API, and the first attempt at this file
// guessed the names — which failed against a real tenant on all three load-bearing
// capabilities at once. That is the signature of wrong names rather than a limited schema,
// so the names are no longer guessed: introspect.ts asks the schema what it calls things,
// and the chosen name is wired in through a GraphQL ALIAS (`id: templateFieldId`) so every
// parser downstream keeps reading one stable shape.
//
// Three rules survive from the version that guessed, because they were learned the hard way
// and are independent of naming:
//
//  1. ASSERT VALUES, NOT THE ABSENCE OF A THROW. An unknown *schema* field rejects the
//     whole query, but an unknown *Sitecore field name* inside `fields(names: […])` comes
//     back as an empty list with no error at all. "It didn't throw" proves nothing.
//  2. PROBE EACH CAPABILITY SEPARATELY. One unknown field invalidates an entire document,
//     so asking for everything at once tells us only that *something* is missing.
//  3. This module stays pure — documents and checks here, requests in export.ts — so the
//     whole ladder is unit-testable against fixture responses.

import type { Sharing } from "../core/model";
import type { SchemaShape, TypeShape } from "./introspect";
import { pick } from "./introspect";

/** The distinct things generation needs to ask for. */
export type CapabilityId =
  | "fieldId"
  | "fieldType"
  | "ownValues"
  | "fieldSharing"
  | "versions"
  | "languages"
  | "fallback"
  | "parent"
  | "childrenTotal";

export interface ProbeField {
  id?: string;
  name?: string;
  value?: string;
  type?: string;
  containsStandardValue?: boolean;
  shared?: boolean;
  unversioned?: boolean;
  /**
   * `Versioned | Unversioned | Shared` as one enum, which is how the live Authoring schema
   * states sharing — `ItemTemplateField` has a `versioning` enum and no boolean pair.
   */
  versioning?: string;
  /** The field's DEFINITION, where a real schema keeps its type and sharing flags. */
  templateField?: {
    type?: string;
    shared?: boolean;
    unversioned?: boolean;
    versioning?: string;
  } | null;
}

/**
 * A collection may come back as a connection (`{ nodes: [...] }`) or as a plain list, and
 * which one it is varies per field within the SAME schema — this tenant's `fields` is a
 * connection while its `versions` is a list of Item. Aliases can rename a field but cannot
 * reshape it, so both shapes are accepted here and normalised by {@link listOf}.
 */
export type Many<T> = { nodes?: T[]; totalCount?: number } | T[] | null | undefined;

/** Normalise a connection or a plain list to an array. */
export function listOf<T>(value: Many<T>): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : (value.nodes ?? []);
}

/**
 * How many entries the endpoint says exist, when the connection reports it.
 *
 * A connection is PAGED. This endpoint's default page is 50 (`GraphQL.DefaultPageSize`),
 * and an item's field closure is routinely larger than that, so a selection that does not
 * ask for the whole set silently receives a prefix of it. `totalCount` is the only way to
 * tell a complete answer from a truncated one.
 */
export function totalOf<T>(value: Many<T>): number | undefined {
  if (!value || Array.isArray(value)) return undefined;
  return typeof value.totalCount === "number" ? value.totalCount : undefined;
}

export interface ProbeItem {
  itemId?: string;
  isFallback?: boolean;
  parent?: { itemId?: string } | null;
  fields?: Many<ProbeField>;
  versions?: Many<{ version?: number }>;
  languages?: Many<{ name?: string }>;
  children?: { totalCount?: number; nodes?: unknown[] } | unknown[];
}

/**
 * The real name this schema uses for each thing we need, as discovered by introspection.
 * `undefined` means the schema has no such field under any name we recognise — a definite
 * negative that needs no request to confirm.
 */
export interface Discovered {
  fieldsOn?: string;
  fieldName?: string;
  fieldValue?: string;
  fieldId?: string;
  fieldType?: string;
  ownValue?: string;
  shared?: string;
  unversioned?: string;
  /** A single enum naming the sharing, where the schema has one instead of two booleans. */
  versioning?: string;
  versions?: string;
  versionNumber?: string;
  languages?: string;
  fallback?: string;
  parent?: string;
  children?: string;
  /** `templateField` on the field node, when the schema has one. */
  templateFieldOn?: string;
  /** Names on the template-field type. */
  tfType?: string;
  tfShared?: string;
  tfUnversioned?: string;
  tfVersioning?: string;
  fieldsAreConnection: boolean;
  /** The argument that asks a connection for more than one page, when it takes one. */
  fieldsFirstArg?: string;
  /** True when the fields connection reports `totalCount`, so truncation is detectable. */
  fieldsHaveTotal?: boolean;
  versionsAreConnection: boolean;
}

/** Candidate spellings, best first. Widened as real schemas are observed. */
const CANDIDATES = {
  fields: ["fields", "ownFields"],
  fieldName: ["name"],
  fieldValue: ["value", "rawValue", "jsonValue"],
  fieldId: ["id", "fieldId", "templateFieldId", "definitionId", "fieldID"],
  fieldType: ["type", "fieldType", "typeName"],
  ownValue: [
    "containsStandardValue",
    "isStandardValue",
    "inheritsStandardValue",
    "hasStandardValue",
    "isInherited",
  ],
  shared: ["shared", "isShared"],
  unversioned: ["unversioned", "isUnversioned"],
  versioning: ["versioning", "sharing"],
  versions: ["versions", "itemVersions"],
  versionNumber: ["version", "versionNumber"],
  languages: ["languages", "itemLanguages"],
  fallback: ["isFallback"],
  parent: ["parent", "parentItem"],
  children: ["children", "childItems"],
  templateField: ["templateField", "definition"],
  tfType: ["type", "fieldType", "typeName"],
  tfShared: ["shared", "isShared"],
  tfUnversioned: ["unversioned", "isUnversioned"],
  tfVersioning: ["versioning", "sharing"],
  first: ["first", "take", "limit"],
};

/** The paging argument a field takes, if it takes one we recognise. */
function firstArgOf(shape: TypeShape | undefined, fieldName: string | undefined): string | undefined {
  const args = fieldName ? shape?.args?.get(fieldName) : undefined;
  if (!args) return undefined;
  return CANDIDATES.first.find((name) => args.has(name));
}

/** What this schema offers, resolved to concrete names. */
export function discover(schema: SchemaShape | undefined): Discovered {
  if (!schema) return { fieldsAreConnection: true, versionsAreConnection: true };
  const { item, field, templateField } = schema;
  return {
    fieldsOn: pick(item, CANDIDATES.fields),
    fieldName: pick(field, CANDIDATES.fieldName),
    fieldValue: pick(field, CANDIDATES.fieldValue),
    fieldId: pick(field, CANDIDATES.fieldId),
    fieldType: pick(field, CANDIDATES.fieldType),
    ownValue: pick(field, CANDIDATES.ownValue),
    shared: pick(field, CANDIDATES.shared),
    unversioned: pick(field, CANDIDATES.unversioned),
    versioning: pick(field, CANDIDATES.versioning),
    versions: pick(item, CANDIDATES.versions),
    versionNumber: undefined, // resolved against the version node, which is an item
    languages: pick(item, CANDIDATES.languages),
    fallback: pick(item, CANDIDATES.fallback),
    parent: pick(item, CANDIDATES.parent),
    children: pick(item, CANDIDATES.children),
    templateFieldOn: pick(field, CANDIDATES.templateField),
    tfType: pick(templateField, CANDIDATES.tfType),
    tfShared: pick(templateField, CANDIDATES.tfShared),
    tfUnversioned: pick(templateField, CANDIDATES.tfUnversioned),
    tfVersioning: pick(templateField, CANDIDATES.tfVersioning),
    fieldsAreConnection: schema.fieldsAreConnection,
    fieldsFirstArg: firstArgOf(item, pick(item, CANDIDATES.fields)),
    fieldsHaveTotal: schema.fieldsConnection?.fields.has("totalCount") ?? false,
    versionsAreConnection: schema.versionsAreConnection,
  };
}

/** When introspection is unavailable, fall back to the conventional spellings. */
export const ASSUMED: Discovered = {
  fieldsOn: "fields",
  fieldName: "name",
  fieldValue: "value",
  fieldId: "id",
  fieldType: "type",
  ownValue: "containsStandardValue",
  shared: "shared",
  unversioned: "unversioned",
  versions: "versions",
  languages: "languages",
  fallback: "isFallback",
  parent: "parent",
  children: "children",
  fieldsAreConnection: true,
  versionsAreConnection: true,
};

/** `alias: realName` when they differ, plain otherwise. */
function alias(aliasName: string, realName: string): string {
  return aliasName === realName ? realName : aliasName + ": " + realName;
}

/**
 * How many fields to ask a connection for in one go.
 *
 * A connection answers ONE PAGE. This endpoint's default is 50 — `GraphQL.DefaultPageSize`,
 * read in `Sitecore.GraphQL.NetFxHost` — and an item's field closure is comfortably larger:
 * the Standard Template alone contributes about ninety. The visible symptom was a media
 * item that packaged eight fields and none of its Statistics section, because `__created`,
 * `__revision` and `__updated` sit past the cut. They are also the only VERSIONED values a
 * media item on an unversioned template has, so losing them meant the installed item had no
 * version at all.
 *
 * Asked for explicitly rather than paged through: one round trip per item per language is
 * already the cost model here, and no real template approaches this number.
 */
const FIELD_PAGE = 1000;

/** Wrap a field sub-selection in the connection shape this schema uses. */
function fieldsBlock(d: Discovered, inner: string): string | undefined {
  if (!d.fieldsOn) return undefined;
  if (!d.fieldsAreConnection) return alias("fields", d.fieldsOn) + " { " + inner + " }";

  // Only page when introspection saw the argument. Sending `first:` at a connection that
  // does not take one turns a working query into a validation error, and `fieldId` is a
  // hard stop — a schema we cannot page is still a schema we can read.
  const paging = d.fieldsFirstArg ? "(" + d.fieldsFirstArg + ": " + FIELD_PAGE + ")" : "";
  const total = d.fieldsHaveTotal ? " totalCount" : "";
  return alias("fields", d.fieldsOn) + paging + " { nodes { " + inner + " }" + total + " }";
}

/** The always-present part of a field selection: its name and value. */
function baseFieldProps(d: Discovered): string[] {
  const props: string[] = [];
  if (d.fieldName) props.push(alias("name", d.fieldName));
  if (d.fieldValue) props.push(alias("value", d.fieldValue));
  return props;
}

/**
 * Select one property either directly off the field node, or through its template field.
 * `templateField { type }` cannot be aliased into a flat `type`, so the parser accepts
 * both shapes instead — see {@link typeOfField}.
 */
function fieldProp(
  d: Discovered,
  aliasName: string,
  direct: string | undefined,
  viaTemplate: string | undefined,
): string | undefined {
  if (direct) return alias(aliasName, direct);
  if (viaTemplate && d.templateFieldOn) {
    return d.templateFieldOn + " { " + alias(aliasName, viaTemplate) + " }";
  }
  return undefined;
}

/**
 * The sharing sub-selection, wherever this schema keeps it.
 *
 * Four shapes, best first. The live Authoring schema is the LAST of them: `ItemField` has
 * no sharing at all and `ItemTemplateField` states it as a single `versioning` enum
 * (`VERSIONED | UNVERSIONED | SHARED`). Knowing only the boolean pair, this returned
 * undefined, the capability read as unsupported, and every field fell through to the
 * catalog — which asked for the same two booleans and also found nothing. Everything then
 * defaulted to Versioned, which is right for ordinary content and wrong for every media
 * item.
 */
function sharingProps(d: Discovered): string | undefined {
  const direct = [
    d.shared ? alias("shared", d.shared) : undefined,
    d.unversioned ? alias("unversioned", d.unversioned) : undefined,
  ].filter(Boolean);
  if (direct.length > 0) return direct.join(" ");
  if (d.versioning) return alias("versioning", d.versioning);

  const viaTemplate = [
    d.tfShared ? alias("shared", d.tfShared) : undefined,
    d.tfUnversioned ? alias("unversioned", d.tfUnversioned) : undefined,
  ].filter(Boolean);
  if (viaTemplate.length > 0 && d.templateFieldOn) {
    return d.templateFieldOn + " { " + viaTemplate.join(" ") + " }";
  }
  if (d.tfVersioning && d.templateFieldOn) {
    return d.templateFieldOn + " { " + alias("versioning", d.tfVersioning) + " }";
  }
  return undefined;
}

/**
 * One enum value → our `Sharing`.
 *
 * Case-insensitive: HotChocolate serialises `FieldVersioning` as `VERSIONED`, but the name
 * is the contract, not its casing.
 */
export function sharingFromVersioning(value: string | undefined): Sharing | undefined {
  const name = value?.toUpperCase();
  if (name === "SHARED") return "Shared";
  if (name === "UNVERSIONED") return "Unversioned";
  if (name === "VERSIONED") return "Versioned";
  return undefined;
}

/** A field's type label, from the field node or its definition. */
export function typeOfField(f: ProbeField): string | undefined {
  const value = f.type ?? f.templateField?.type;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A field's sharing, from the field node or its definition. */
export function sharingOfField(f: ProbeField): Sharing | undefined {
  const shared = f.shared ?? f.templateField?.shared;
  const unversioned = f.unversioned ?? f.templateField?.unversioned;
  if (typeof shared === "boolean" || typeof unversioned === "boolean") {
    if (shared) return "Shared";
    return unversioned ? "Unversioned" : "Versioned";
  }
  return sharingFromVersioning(f.versioning ?? f.templateField?.versioning ?? undefined);
}

export interface Capability {
  id: CapabilityId;
  /** What is lost without it — shown to the user verbatim. */
  need: string;
  /** True when a package simply cannot be built without it. */
  hardStop: boolean;
  /** The `item { … }` selection that tests it, or undefined when the name is unknown. */
  selection(d: Discovered): string | undefined;
  /** Did the endpoint actually answer, rather than merely accept the question? */
  assert(item: ProbeItem): boolean;
}

const GUID = /^\{?[0-9A-Fa-f]{8}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{12}\}?$/;

const nodes = (item: ProbeItem): ProbeField[] => listOf(item.fields);

export const CAPABILITIES: Capability[] = [
  {
    id: "fieldId",
    need: "the GUID of each field",
    // The item XML keys every field by `tfid`, and field NAMES are not unique across an
    // inheritance chain, so there is no way to guess one. Without this there is no package.
    hardStop: true,
    selection: (d) =>
      d.fieldId ? fieldsBlock(d, [...baseFieldProps(d), alias("id", d.fieldId)].join(" ")) : undefined,
    assert: (item) => nodes(item).some((f) => typeof f.id === "string" && GUID.test(f.id)),
  },
  {
    id: "ownValues",
    need: "whether a value is the item's own or inherited from __Standard values",
    // The one failure that is invisible. Sitecore's serializer writes only fields the item
    // OWNS — 63 of 93 sample items carry a resolved `sortorder` attribute with no
    // `__sortorder` field precisely because it is inherited. Writing every resolved value
    // would bake the defaults in and permanently detach the items from their standard
    // values on the target, and the package would still install without an error.
    hardStop: true,
    selection: (d) =>
      d.ownValue
        ? fieldsBlock(d, [...baseFieldProps(d), alias("containsStandardValue", d.ownValue)].join(" "))
        : undefined,
    assert: (item) => nodes(item).some((f) => typeof f.containsStandardValue === "boolean"),
  },
  {
    id: "versions",
    need: "the version numbers of each item",
    hardStop: true,
    selection: (d) => {
      if (!d.versions) return undefined;
      const body = d.versionsAreConnection ? "nodes { version }" : "version";
      return alias("versions", d.versions) + " { " + body + " }";
    },
    assert: (item) =>
      listOf(item.versions).some((v) => typeof v.version === "number" && v.version > 0),
  },
  {
    id: "fieldSharing",
    need: "whether each field is shared, unversioned or versioned",
    // Decides which bucket a value lands in and what `fieldproperties` claims. Guess it
    // wrong and a Shared field is written once per version, so installing changes the
    // field's sharing on the target template. The template catalog is the fallback.
    hardStop: false,
    selection: (d) => {
      const sharing = sharingProps(d);
      return sharing ? fieldsBlock(d, [...baseFieldProps(d), sharing].join(" ")) : undefined;
    },
    assert: (item) => nodes(item).some((f) => sharingOfField(f) !== undefined),
  },
  {
    id: "fieldType",
    need: "each field's type label",
    // Recoverable: the template catalog can supply the type instead.
    hardStop: false,
    selection: (d) => {
      const prop = fieldProp(d, "type", d.fieldType, d.tfType);
      return prop ? fieldsBlock(d, [...baseFieldProps(d), prop].join(" ")) : undefined;
    },
    assert: (item) => nodes(item).some((f) => !!typeOfField(f)),
  },
  {
    id: "languages",
    need: "which languages an item has",
    hardStop: false,
    selection: (d) => (d.languages ? alias("languages", d.languages) + " { name }" : undefined),
    assert: (item) => listOf(item.languages).some((l) => typeof l.name === "string" && l.name),
  },
  {
    id: "fallback",
    need: "whether a language version is real or falling back to another language",
    // The same class of mistake as standard values: a fallback version is not the item's
    // own content, and packaging it would create a real version on the target where none
    // existed. Recoverable only in the sense that a single-language package is unaffected.
    hardStop: false,
    selection: (d) => (d.fallback ? alias("isFallback", d.fallback) : undefined),
    assert: (item) => typeof item.isFallback === "boolean",
  },
  {
    id: "parent",
    need: "each item's parent",
    // Recoverable: within a package most parents are present, so a missing one can be
    // matched by path. An item whose parent is outside the package cannot be.
    hardStop: false,
    selection: (d) => (d.parent ? alias("parent", d.parent) + " { itemId }" : undefined),
    assert: (item) => typeof item.parent?.itemId === "string" && item.parent.itemId.length > 0,
  },
  {
    id: "childrenTotal",
    need: "confirmation that a wide folder was not truncated",
    // `children { nodes }` is requested with no pagination anywhere in this codebase and
    // `pageInfo` is never read. For Preview an undercount is cosmetic; here it silently
    // ships an incomplete package, so we want to be able to prove the count.
    hardStop: false,
    selection: (d) =>
      d.children ? alias("children", d.children) + " { totalCount nodes { itemId } }" : undefined,
    assert: (item) => {
      const children = item.children;
      if (!children || Array.isArray(children)) return false;
      return (
        typeof children.totalCount === "number" &&
        (children.nodes ?? []).length === children.totalCount
      );
    },
  },
];

/** Wrap one capability's selection in a document that asks for nothing else. */
export function probeDocument(selection: string): string {
  return (
    "query ExportProbe($path: String, $itemId: ID, $language: String, $database: String) {\n" +
    "  item(where: { path: $path, itemId: $itemId, language: $language, database: $database }) {\n" +
    "    itemId\n    " +
    selection +
    "\n  }\n}"
  );
}

/**
 * A value the endpoint already escaped would be escaped a second time on write, turning an
 * Image field into literal text. Stored markup values begin with `<`; an answer beginning
 * with `&lt;` means the endpoint handed back presentation, not storage.
 */
export function looksPreEscaped(value: string): boolean {
  return value.startsWith("&lt;") || value.startsWith("&amp;lt;");
}

/**
 * The `item { … }` selection to fetch real content with, given what the endpoint proved it
 * can answer. Composed from the capability list rather than written out, so a capability
 * the tenant lacks is simply not asked for instead of failing the whole document.
 */
export function itemSelection(supported: Set<CapabilityId>, d: Discovered): string {
  const fieldProps = [...baseFieldProps(d)];
  if (supported.has("fieldId") && d.fieldId) fieldProps.push(alias("id", d.fieldId));
  if (supported.has("fieldType")) {
    const prop = fieldProp(d, "type", d.fieldType, d.tfType);
    if (prop) fieldProps.push(prop);
  }
  if (supported.has("ownValues") && d.ownValue) {
    fieldProps.push(alias("containsStandardValue", d.ownValue));
  }
  if (supported.has("fieldSharing")) {
    const sharing = sharingProps(d);
    if (sharing) fieldProps.push(sharing);
  }
  const fields = fieldsBlock(d, fieldProps.join(" "));

  const parts = ["itemId", "name", "path", "template { templateId name }"];
  if (fields) parts.push(fields);
  if (supported.has("fallback") && d.fallback) parts.push(alias("isFallback", d.fallback));
  if (supported.has("parent") && d.parent) parts.push(alias("parent", d.parent) + " { itemId }");
  if (supported.has("languages") && d.languages) {
    parts.push(alias("languages", d.languages) + " { name }");
  }
  if (supported.has("versions") && d.versions) {
    const inner = d.versionsAreConnection
      ? "nodes { version " + (fields ?? "") + " }"
      : "version " + (fields ?? "");
    parts.push(alias("versions", d.versions) + " { " + inner + " }");
  }
  return parts.join("\n      ");
}

/**
 * Top-level item selections that may be dropped and asked for again, keyed by the name they
 * appear under in a GraphQL error path.
 *
 * All three are `hardStop: false` capabilities: losing one degrades the package in a way
 * that can be described to the user, rather than making it silently wrong. The hard-stop
 * capabilities are deliberately absent — there is no version of "retry without `versions`"
 * that produces a package worth having.
 */
export const DROPPABLE_SELECTIONS: Record<string, CapabilityId> = {
  isFallback: "fallback",
  parent: "parent",
  languages: "languages",
};

export interface CapabilityReport {
  supported: Set<CapabilityId>;
  /** Everything unsupported, whether or not it blocks. */
  missing: Capability[];
  /** The subset that makes generation impossible. */
  blocking: Capability[];
  /** What introspection found, so a failure can say what IS available. */
  discovered?: Discovered;
  /** Human-readable listing of the schema, when it could be read. */
  schemaNotes?: string[];
}

/**
 * Turn per-capability probe answers into a report. `undefined` means the request was
 * rejected outright, or was never sent because the schema has no such field; an item that
 * came back still has to pass the value-level check.
 */
export function reportFrom(
  answers: Map<CapabilityId, ProbeItem | undefined>,
  extra: Pick<CapabilityReport, "discovered" | "schemaNotes"> = {},
): CapabilityReport {
  const supported = new Set<CapabilityId>();
  const missing: Capability[] = [];

  for (const capability of CAPABILITIES) {
    const answer = answers.get(capability.id);
    if (answer && capability.assert(answer)) supported.add(capability.id);
    else missing.push(capability);
  }

  return { supported, missing, blocking: missing.filter((c) => c.hardStop), ...extra };
}

/** A sentence naming exactly what the endpoint would not supply. */
export function describeBlocked(report: CapabilityReport): string | undefined {
  if (report.blocking.length === 0) return undefined;
  return (
    "This environment's Authoring API did not supply " +
    report.blocking.map((c) => c.need).join(", ") +
    ". A package built without that would install cleanly and be wrong, so it was not built."
  );
}
