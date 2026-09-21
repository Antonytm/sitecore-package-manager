// xmc/templates — per-session catalog of what a template says about its fields.
//
// A field's GUID, its type label and its sharing (Shared / Unversioned / Versioned) are
// properties of the TEMPLATE, not of the item. That is not a guess: across the sample
// packages the `fieldproperties` string is byte-identical for every item using a given
// template, and identical across all four languages of a multi-language item. Sitecore's
// own ItemFieldsProperties reads sharing off the template field.
//
// So this is also the cheap way to get it — one fetch per distinct template rather than
// one per item (28 templates behind 90 item versions in the samples). The catalog is only
// consulted for what the item selection could not already answer; when the endpoint puts
// `shared`/`unversioned`/`type` on the item's own field nodes, nothing here runs.
//
// The selection is negotiated the same way everything else against this schema is: try,
// check the VALUES that came back, fall to the next rung. A template's field is itself an
// item, so the last rung reads the standard fields off it using `fields(names: […])` —
// the one mechanism already proven to work.

import type { Guid } from "../core/model";
import type { Sharing } from "../core/properties";
import { AuthoringError, authoringGraphql } from "./authoring";
import { toBracedGuid } from "./browse";
import type { XmcContext } from "./client";

/** What a template says about one of its fields. */
export interface TemplateField {
  id: Guid;
  name: string;
  type?: string;
  sharing: Sharing;
}

export interface TemplateInfo {
  id: Guid;
  /** Keyed by field id — names are NOT unique across an inheritance chain. */
  fields: Map<Guid, TemplateField>;
}

/** `__Shared` and `__Unversioned` on a template field item. */
const SHARED_FIELD = "__Shared";
const UNVERSIONED_FIELD = "__Unversioned";
const TYPE_FIELD = "Type";

interface RawTemplateField {
  templateFieldId?: string;
  templateFieldID?: string;
  id?: string;
  name?: string;
  type?: string;
  shared?: boolean;
  unversioned?: boolean;
  /** `VERSIONED | UNVERSIONED | SHARED` — how the live Authoring schema states sharing. */
  versioning?: string;
  fields?: { nodes?: { name?: string; value?: string }[] };
}

interface RawTemplate {
  templateId?: string;
  name?: string;
  ownFields?: { nodes?: RawTemplateField[] };
  fields?: { nodes?: RawTemplateField[] };
}

interface Rung {
  id: string;
  document: string;
}

/**
 * Candidate shapes, richest first. Each asks for the FULL field set (`fields`, not
 * `ownFields`) where it can, because `fieldproperties` covers the inherited closure —
 * 129 tokens for an item with 25 fields — and own-fields-only cannot reach it.
 */
/**
 * How many template fields to ask for at once.
 *
 * `ItemTemplate.fields` is `[UsePagination]`, so it answers one page — 50 by default on
 * this endpoint. A template whose closure is larger would come back silently short, and a
 * field missing from the catalog is a field whose sharing we then guess.
 */
const FIELD_PAGE = 1000;

const RUNGS: Rung[] = [
  {
    // The live Authoring schema's own spelling: one `versioning` enum on the template
    // field, no boolean pair anywhere. Tried first because it is the only rung that
    // actually answers on XM Cloud.
    id: "versioning",
    document: `
      query TemplateFields($templateId: ID) {
        template(where: { templateId: $templateId }) {
          templateId
          name
          fields(first: ${FIELD_PAGE}) { nodes { templateFieldId name type versioning } }
        }
      }
    `,
  },
  {
    id: "flags",
    document: `
      query TemplateFields($templateId: ID) {
        template(where: { templateId: $templateId }) {
          templateId
          name
          fields(first: ${FIELD_PAGE}) { nodes { templateFieldId name type shared unversioned } }
        }
      }
    `,
  },
  {
    id: "own-flags",
    document: `
      query TemplateFields($templateId: ID) {
        template(where: { templateId: $templateId }) {
          templateId
          name
          ownFields(first: ${FIELD_PAGE}) { nodes { templateFieldId name type shared unversioned } }
        }
      }
    `,
  },
  {
    // A template field is an item; read the standard fields off it directly. Uses only the
    // `fields(names: […])` mechanism that resolve.ts already proved works.
    id: "standard-fields",
    document: `
      query TemplateFields($templateId: ID) {
        template(where: { templateId: $templateId }) {
          templateId
          name
          fields(first: ${FIELD_PAGE}) {
            nodes {
              templateFieldId
              name
              fields(names: ["${SHARED_FIELD}", "${UNVERSIONED_FIELD}", "${TYPE_FIELD}"]) {
                nodes { name value }
              }
            }
          }
        }
      }
    `,
  },
];

function fieldIdOf(raw: RawTemplateField): string | undefined {
  return raw.templateFieldId ?? raw.templateFieldID ?? raw.id;
}

/** Sitecore writes checkbox fields as "1" for true. */
const isTrue = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

function sharingOf(raw: RawTemplateField): Sharing | undefined {
  if (typeof raw.shared === "boolean" || typeof raw.unversioned === "boolean") {
    if (raw.shared) return "Shared";
    return raw.unversioned ? "Unversioned" : "Versioned";
  }
  const versioning = raw.versioning?.toUpperCase();
  if (versioning === "SHARED") return "Shared";
  if (versioning === "UNVERSIONED") return "Unversioned";
  if (versioning === "VERSIONED") return "Versioned";
  const nested = raw.fields?.nodes;
  if (!nested || nested.length === 0) return undefined;
  const value = (name: string) =>
    nested.find((n) => n.name?.toLowerCase() === name.toLowerCase())?.value;
  if (isTrue(value(SHARED_FIELD))) return "Shared";
  if (isTrue(value(UNVERSIONED_FIELD))) return "Unversioned";
  return "Versioned";
}

function typeOf(raw: RawTemplateField): string | undefined {
  if (raw.type) return raw.type;
  return raw.fields?.nodes?.find((n) => n.name?.toLowerCase() === TYPE_FIELD.toLowerCase())?.value;
}

/** Parse one answer, returning undefined when it carried no usable field data. */
function parse(raw: RawTemplate | null | undefined, templateId: Guid): TemplateInfo | undefined {
  const rawFields = raw?.fields?.nodes ?? raw?.ownFields?.nodes ?? [];
  const fields = new Map<Guid, TemplateField>();
  for (const f of rawFields) {
    const id = fieldIdOf(f);
    const sharing = sharingOf(f);
    // A row that cannot say what it is teaches us nothing — refusing here is what makes
    // "the request succeeded" different from "the endpoint answered".
    if (!id || !sharing) continue;
    const braced = toBracedGuid(id);
    fields.set(braced, { id: braced, name: f.name ?? "", type: typeOf(f), sharing });
  }
  return fields.size > 0 ? { id: templateId, fields } : undefined;
}

/** Per-session state. Reset between tests via {@link resetTemplateCatalog}. */
let agreedRung: Rung | undefined;
let exhausted = false;
const cache = new Map<Guid, TemplateInfo | undefined>();

/** Testing seam — the negotiated rung and the cache are module-level on purpose. */
export function resetTemplateCatalog(): void {
  agreedRung = undefined;
  exhausted = false;
  cache.clear();
}

export interface TemplateCatalogOptions {
  /** Injected in tests, and the seam a corrected selection would be supplied through. */
  fetch?: (document: string, templateId: Guid) => Promise<RawTemplate | null | undefined>;
}

async function run(
  ctx: XmcContext,
  document: string,
  templateId: Guid,
  options: TemplateCatalogOptions,
): Promise<RawTemplate | null | undefined> {
  if (options.fetch) return options.fetch(document, templateId);
  const data = await authoringGraphql<{ template?: RawTemplate | null }>(ctx, document, {
    // The API wants bare GUIDs, exactly as browse.ts found.
    templateId: templateId.replace(/[{}]/g, ""),
  });
  return data.template;
}

/**
 * What this template says about its fields, or `undefined` when the endpoint cannot say.
 *
 * The rung is negotiated once per session and then reused: committing to one document
 * matters because a catalog half-built from two shapes would classify fields
 * inconsistently, which is the same trap resolve.ts documents for item metadata.
 */
export async function getTemplate(
  ctx: XmcContext,
  templateId: Guid,
  options: TemplateCatalogOptions = {},
): Promise<TemplateInfo | undefined> {
  const key = toBracedGuid(templateId);
  if (cache.has(key)) return cache.get(key);
  if (exhausted) return undefined;

  if (agreedRung) {
    let info: TemplateInfo | undefined;
    try {
      info = parse(await run(ctx, agreedRung.document, key, options), key);
    } catch (e: unknown) {
      // A per-template failure is not a reason to renegotiate; the shape already worked.
      if (!(e instanceof AuthoringError)) throw e;
      info = undefined;
    }
    cache.set(key, info);
    return info;
  }

  for (const rung of RUNGS) {
    let info: TemplateInfo | undefined;
    try {
      info = parse(await run(ctx, rung.document, key, options), key);
    } catch (e: unknown) {
      if (!(e instanceof AuthoringError)) throw e;
      continue; // schema rejected this shape — try the next
    }
    // Validating is not answering: a shape that comes back without usable values is no
    // better than one the schema refused.
    if (!info) continue;
    agreedRung = rung;
    cache.set(key, info);
    return info;
  }

  exhausted = true;
  return undefined;
}
