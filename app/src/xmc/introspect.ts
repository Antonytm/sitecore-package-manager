// xmc/introspect — ask the endpoint what its schema actually calls things.
//
// Every selection this app sends against the Authoring API has so far been a guess checked
// against reality, because the schema is not documented anywhere we can reach. For browsing
// that was survivable: a wrong guess degrades a picker. For generating a package it is not
// — the fields we need either exist under some name or the package cannot be built, and
// "not built" is a dead end if we cannot say what to ask for instead.
//
// GraphQL can answer this itself. Introspection is what the Authoring IDE uses to offer
// completion, so it is normally available, and it turns the whole problem from guesswork
// into a lookup: find the type behind `item`, list its fields, find the type behind its
// `fields` connection, list those.
//
// The names that come back are then used through ALIASES — `id: templateFieldId` — so the
// rest of the code keeps reading one stable shape no matter what this tenant calls things.

import type { PartialResult } from "./authoring";

/** A minimal `__Type` reference, unwrapped through NonNull/List wrappers. */
interface TypeRef {
  name?: string | null;
  kind?: string | null;
  ofType?: TypeRef | null;
}

interface IntrospectedField {
  name?: string;
  type?: TypeRef | null;
}

interface IntrospectedType {
  name?: string | null;
  fields?: IntrospectedField[] | null;
}

export type Request = <T>(
  document: string,
  variables: Record<string, unknown>,
) => Promise<PartialResult<T>>;

/** Peel NonNull and List wrappers off a type reference to get the named type. */
function named(ref: TypeRef | null | undefined): string | undefined {
  let level: TypeRef | null | undefined = ref;
  for (let depth = 0; level && depth < 8; depth++) {
    if (level.name) return level.name;
    level = level.ofType;
  }
  return undefined;
}

const TYPE_REF =
  "type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }";

const typeDocument = (name: string) =>
  'query Shape { __type(name: "' + name + '") { name fields { name ' + TYPE_REF + " } } }";

export interface TypeShape {
  name: string;
  /** Field name → the named type it returns. */
  fields: Map<string, string | undefined>;
}

async function shapeOf(request: Request, typeName: string): Promise<TypeShape | undefined> {
  const result = await request<{ __type?: IntrospectedType | null }>(typeDocument(typeName), {});
  const fields = result.data?.__type?.fields;
  if (!fields || fields.length === 0) return undefined;
  const map = new Map<string, string | undefined>();
  for (const f of fields) if (f.name) map.set(f.name, named(f.type));
  return { name: typeName, fields: map };
}

export interface SchemaShape {
  /** The type `item(where: …)` returns, and its fields. */
  item: TypeShape;
  /** The type behind `item { fields { nodes … } }`, and its fields. */
  field?: TypeShape;
  /**
   * The type behind `field { templateField { … } }`, when there is one.
   *
   * This is where a real Authoring schema keeps a field's TYPE and its shared/unversioned
   * flags — an ItemField carries the value, its template field carries the definition. It
   * is also what demotes the separate template catalog to a fallback.
   */
  templateField?: TypeShape;
  /** True when the field list is reached through a `nodes` connection. */
  fieldsAreConnection: boolean;
  /** True when the versions list is reached through a `nodes` connection. */
  versionsAreConnection: boolean;
}

/** Does this type expose a `nodes` collection (a connection) rather than being a list? */
async function isConnection(
  request: Request,
  typeName: string | undefined,
): Promise<boolean> {
  if (!typeName) return false;
  const shape = await shapeOf(request, typeName);
  return shape?.fields.has("nodes") ?? false;
}

/**
 * Walk from the query root to the item type and on to its field type.
 *
 * Done as a walk rather than by asking for likely type names, because the name of the item
 * type is exactly the kind of thing we would otherwise be guessing. Five requests at worst,
 * once per session.
 */
export async function introspectSchema(request: Request): Promise<SchemaShape | undefined> {
  const root = await request<{ __schema?: { queryType?: { name?: string } } }>(
    "query Root { __schema { queryType { name } } }",
    {},
  );
  const rootName = root.data?.__schema?.queryType?.name;
  if (!rootName) return undefined;

  const rootShape = await shapeOf(request, rootName);
  const itemTypeName = rootShape?.fields.get("item");
  if (!itemTypeName) return undefined;

  const item = await shapeOf(request, itemTypeName);
  if (!item) return undefined;

  const versionsAreConnection = await isConnection(
    request,
    pick(item, ["versions", "itemVersions"]) ? item.fields.get(pick(item, ["versions", "itemVersions"])!) : undefined,
  );

  const fieldsTypeName = pick(item, ["fields", "ownFields"])
    ? item.fields.get(pick(item, ["fields", "ownFields"])!)
    : undefined;
  if (!fieldsTypeName) return { item, fieldsAreConnection: false, versionsAreConnection };

  const fieldsShape = await shapeOf(request, fieldsTypeName);
  if (!fieldsShape) return { item, fieldsAreConnection: false, versionsAreConnection };

  // `fields` is usually a connection carrying `nodes`, but may be a plain list.
  const nodeTypeName = fieldsShape.fields.get("nodes");
  if (!nodeTypeName) {
    return { item, field: fieldsShape, fieldsAreConnection: false, versionsAreConnection };
  }

  const field = await shapeOf(request, nodeTypeName);

  // An ItemField carries the value; its template field carries the definition — the type
  // label and the shared/unversioned flags the package format needs.
  const templateFieldName = field ? pick(field, ["templateField", "definition"]) : undefined;
  const templateFieldType = templateFieldName ? field!.fields.get(templateFieldName) : undefined;
  const templateField = templateFieldType
    ? await shapeOf(request, templateFieldType)
    : undefined;

  return { item, field, templateField, fieldsAreConnection: true, versionsAreConnection };
}

/** The first candidate this schema actually has, or undefined. */
export function pick(shape: TypeShape | undefined, candidates: string[]): string | undefined {
  if (!shape) return undefined;
  for (const name of candidates) if (shape.fields.has(name)) return name;
  // Case-insensitive second pass — schemas differ on casing more often than on wording.
  const lower = new Map([...shape.fields.keys()].map((k) => [k.toLowerCase(), k]));
  for (const name of candidates) {
    const found = lower.get(name.toLowerCase());
    if (found) return found;
  }
  return undefined;
}

/** A compact listing of what a type offers, for telling the user what we found. */
export function describeShape(shape: TypeShape | undefined, limit = 40): string {
  if (!shape) return "(not discovered)";
  const names = [...shape.fields.keys()];
  return (
    shape.name +
    ": " +
    names.slice(0, limit).join(", ") +
    (names.length > limit ? ", … (" + names.length + " total)" : "")
  );
}
