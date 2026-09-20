// storage/definitions — package definitions persisted in browser local storage.
//
// The legacy Package Designer saved a project as an XML file on the server under
// Data/packages, browsed through a project-file dialog (Refresh / Upload / Download /
// Delete + a File name field). There is no server file system on SitecoreAI, so the
// same dialog is backed by this store instead — see wiki/articles/package-designer-ui.md §11.
//
// What is stored is the SERIALIZED DEFINITION XML, exactly as it would appear at
// `installer/project` inside a built package. That keeps the store format-faithful and
// makes Download a straight byte copy.
//
// This is I/O, so it deliberately lives outside `core/` (which is pure — see ARCHITECTURE.md).
// Every accessor takes an injectable `Storage` so the module is testable under the node
// test environment, and every access is guarded: a browser in private mode can throw on
// access, and a large static-file source can exceed the quota.

/** One saved project. `name` doubles as the storage key and the dialog's File name. */
export interface StoredDefinition {
  name: string;
  /** The `installer/project` XML. */
  xml: string;
  /** ISO-8601 timestamp of the last save. */
  savedAt: string;
}

const PROJECTS_KEY = "spm.definitions.v1";
const DRAFT_KEY = "spm.draft.v1";

/** Raised when local storage is unavailable or full; the UI surfaces this as a toast. */
export class StorageUnavailableError extends Error {
  constructor(operation: string, cause?: unknown) {
    super("Browser storage is unavailable (" + operation + ")");
    this.name = "StorageUnavailableError";
    this.cause = cause;
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined; // blocked site data
  }
}

function read(store: Storage | undefined, key: string): string | undefined {
  if (!store) return undefined;
  try {
    return store.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(store: Storage | undefined, key: string, value: string, operation: string): void {
  if (!store) throw new StorageUnavailableError(operation);
  try {
    store.setItem(key, value);
  } catch (cause) {
    throw new StorageUnavailableError(operation, cause);
  }
}

type ProjectMap = Record<string, StoredDefinition>;

function readMap(store: Storage | undefined): ProjectMap {
  const raw = read(store, PROJECTS_KEY);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Drop anything that does not look like a record, so one bad entry cannot
    // break the whole project list.
    const out: ProjectMap = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<StoredDefinition>;
      if (typeof v?.xml === "string") {
        out[name] = { name, xml: v.xml, savedAt: typeof v.savedAt === "string" ? v.savedAt : "" };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(store: Storage | undefined, map: ProjectMap, operation: string): void {
  write(store, PROJECTS_KEY, JSON.stringify(map), operation);
}

// ── projects ────────────────────────────────────────────────────────────────

/** All saved projects, ordered by name the way the legacy file browser listed them. */
export function listDefinitions(store: Storage | undefined = defaultStorage()): StoredDefinition[] {
  return Object.values(readMap(store)).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export function readDefinition(
  name: string,
  store: Storage | undefined = defaultStorage(),
): string | undefined {
  return readMap(store)[name]?.xml;
}

export function definitionExists(
  name: string,
  store: Storage | undefined = defaultStorage(),
): boolean {
  return name in readMap(store);
}

/** Save under `name`, overwriting any existing project with that name. */
export function saveDefinition(
  name: string,
  xml: string,
  store: Storage | undefined = defaultStorage(),
): StoredDefinition {
  const record: StoredDefinition = { name, xml, savedAt: new Date().toISOString() };
  const map = readMap(store);
  map[name] = record;
  writeMap(store, map, "save project");
  return record;
}

export function deleteDefinition(
  name: string,
  store: Storage | undefined = defaultStorage(),
): void {
  const map = readMap(store);
  if (!(name in map)) return;
  delete map[name];
  writeMap(store, map, "delete project");
}

// ── working draft ───────────────────────────────────────────────────────────
// Separate from the named projects: the designer autosaves here on every edit so a
// reload does not lose unsaved work. Named projects only change on an explicit Save.

export function readDraft(store: Storage | undefined = defaultStorage()): string | undefined {
  return read(store, DRAFT_KEY);
}

export function saveDraft(xml: string, store: Storage | undefined = defaultStorage()): void {
  write(store, DRAFT_KEY, xml, "autosave");
}

export function clearDraft(store: Storage | undefined = defaultStorage()): void {
  if (!store) return;
  try {
    store.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to do — a draft we cannot clear is harmless.
  }
}
