// core/items/build — ItemModel ──► the per-version entries a package stores.
//
// The inverse of what core/package.ts does on read: one `items/…/xml` entry and one
// matching `properties/items/…/xml` side-car per (language, version). Everything here was
// measured against the real Sitecore output in files/extracted rather than inferred, because
// the format has several rules that look like details and are not:
//
//  - Fields are grouped Versioned → Unversioned → Shared (23/23 sample entries).
//  - A field with an EMPTY value is not serialized at all — there are zero
//    `<content></content>` and zero self-closed `<field/>` nodes across 93 entries. Writing
//    one would blank a field that should inherit from __Standard values.
//  - `fieldproperties` lists the item's full inherited template closure (129 tokens for an
//    item with 25 fields), so it cannot be rebuilt from the fields alone. When the model
//    preserved the original we replay it verbatim; otherwise we compose a well-formed
//    SUBSET covering the fields we do emit, which tells the installer not to touch the
//    sharing of fields it was never told about.
//  - The side-car is UTF-8 with BOM, CRLF, and ends with a trailing CRLF.

import type { FieldModel, ItemModel, Sharing } from "../model";
import type { RawProperties } from "../properties";
import { escapeAttr, escapeContent } from "./escape";
import type { RawAttr, RawField, RawItemEntry } from "./index";

/** `__Revision` — its value is what the side-car's `revision=` repeats. */
const REVISION_FIELD_ID = "{8CDC337E-A112-42FB-BBB4-4143751E123F}";
const CREATED_FIELD_ID = "{25BED78C-4957-4165-998A-CA1B52F67497}";
const SORTORDER_FIELD_ID = "{BA3F86A2-4A1C-4D78-B63D-91C2779C1B5E}";
const ZERO_GUID = "{00000000-0000-0000-0000-000000000000}";

/** Find a well-known field by id, falling back to its name. */
function valueOf(fields: FieldModel[], id: string, name: string): string | undefined {
  const match = fields.find(
    (f) => f.id === id || f.name?.toLowerCase() === name.toLowerCase(),
  );
  return match?.value || undefined;
}

/** Emission order. Also the order `fieldproperties` tokens appear in. */
const SHARING_ORDER: Sharing[] = ["Versioned", "Unversioned", "Shared"];

export interface BuiltItemEntry {
  /** Inner-zip entry name: `items/<db>/<path>/{ID}/<lang>/<ver>/xml`. */
  key: string;
  item: RawItemEntry;
  properties: RawProperties;
}

/** The entry name for one version of an item. `path` already carries its leading slash. */
export function itemEntryKey(item: ItemModel, language: string, version: number): string {
  const db = item.database ?? "master";
  return "items/" + db + item.path + "/" + item.id + "/" + language + "/" + version + "/xml";
}

function attr(name: string, value: string): RawAttr {
  return { name, value: escapeAttr(value) };
}

/** The `<item>` attribute set, in the order Sitecore writes it. */
function itemAttrs(
  item: ItemModel,
  language: string,
  version: number,
  fields: FieldModel[],
): RawAttr[] {
  const attrs: RawAttr[] = [
    attr("name", item.name),
    // Sitecore's Item.Key is documented as "always %Name% in lowercase".
    attr("key", item.key ?? item.name.toLowerCase()),
    attr("id", item.id),
    attr("tid", item.templateId),
    // Branch id has no known Authoring GraphQL surface; the zero GUID reads as "no branch".
    attr("mid", item.masterId ?? ZERO_GUID),
  ];
  // No sample carries `bid`, so it is emitted only when something actually set it.
  if (item.branchId) attrs.push(attr("bid", item.branchId));
  attrs.push(
    // These three are RESOLVED values in Sitecore's output, which is why they can be
    // present as attributes while the matching field is absent. A round-tripped package
    // already carries them; a generated one reads them back off the fields it fetched.
    attr("sortorder", item.sortorder ?? valueOf(fields, SORTORDER_FIELD_ID, "__Sortorder") ?? "0"),
    attr("language", language),
    attr("version", String(version)),
    // Sitecore lower-cases the template name here; `tid` is the authoritative reference.
    attr("template", (item.templateName ?? "").toLowerCase()),
    attr("parentid", item.parentId),
    attr("created", item.created ?? valueOf(fields, CREATED_FIELD_ID, "__Created") ?? ""),
  );
  return attrs;
}

function fieldNode(f: FieldModel): RawField {
  return {
    attrs: [
      attr("tfid", f.id),
      // Sitecore writes the field key lower-cased: `__updated`, not `__Updated`.
      attr("key", (f.name ?? "").toLowerCase()),
      attr("type", f.type ?? ""),
    ],
    content: escapeContent(f.value),
  };
}

/** Every field this item holds anywhere, deduped by id, in V → U → S order. */
function allFields(item: ItemModel): FieldModel[] {
  const byBucket = new Map<Sharing, Map<string, FieldModel>>(
    SHARING_ORDER.map((s) => [s, new Map<string, FieldModel>()]),
  );
  const add = (f: FieldModel, fallback: Sharing) => {
    const bucket = byBucket.get(f.sharing ?? fallback)!;
    if (!bucket.has(f.id)) bucket.set(f.id, f);
  };
  for (const lang of item.languages) {
    for (const v of lang.versions) for (const f of v.fields) add(f, "Versioned");
    for (const f of lang.unversionedFields) add(f, "Unversioned");
  }
  for (const f of item.sharedFields) add(f, "Shared");
  return SHARING_ORDER.flatMap((s) => [...byBucket.get(s)!.values()]);
}

/**
 * `fieldproperties` for this item: the preserved original when we have one (so a
 * round-trip is byte-exact), otherwise a subset built from the fields we can see.
 */
function fieldPropertiesFor(item: ItemModel): string {
  if (item.fieldProperties !== undefined) return item.fieldProperties;
  return allFields(item)
    .map((f) => f.id + ":" + (f.sharing ?? "Versioned"))
    .join("|");
}

export function buildItemEntries(item: ItemModel): BuiltItemEntry[] {
  const db = item.database ?? "master";
  const fieldProperties = fieldPropertiesFor(item);
  const out: BuiltItemEntry[] = [];

  for (const lang of item.languages) {
    // A language with no versions has nowhere to put its values — the format has no entry
    // for it, and `version=0` would read back as version-invariant, which is a different
    // thing. Skip rather than invent.
    for (const version of lang.versions) {
      const ordered: FieldModel[] = [
        ...version.fields,
        ...lang.unversionedFields,
        ...item.sharedFields,
      ].filter((f) => f.value !== "");

      const revision =
        version.fields.find(
          (f) => f.id === REVISION_FIELD_ID || f.name?.toLowerCase() === "__revision",
        )?.value ?? "";

      out.push({
        key: itemEntryKey(item, lang.language, version.version),
        item: {
          attrs: itemAttrs(item, lang.language, version.version, ordered),
          fields: ordered.map(fieldNode),
        },
        properties: {
          bom: true,
          trailingCrlf: true,
          pairs: [
            { key: "database", value: db },
            { key: "id", value: item.id },
            { key: "language", value: lang.language },
            { key: "version", value: String(version.version) },
            { key: "revision", value: revision },
            { key: "fieldproperties", value: fieldProperties },
          ],
        },
      });
    }
  }

  return out;
}
