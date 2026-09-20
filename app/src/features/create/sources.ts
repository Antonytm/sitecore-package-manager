// features/create/sources — factories and labels for the five source kinds.
//
// Keeps the "Add" ribbon, the left nav and the source detail panel agreeing on what each
// kind is called and what a fresh one looks like.

import {
  mdiAccountGroupOutline,
  mdiFileDocumentMultipleOutline,
  mdiFileTreeOutline,
  mdiFolderSearchOutline,
  mdiTextSearch,
} from "@mdi/js";
import { ASK_USER } from "@/src/core/model";
import type { BehaviourOptions, SourceDefinition } from "@/src/core/model";
import { newSourceUid } from "@/src/core/definition";

export type SourceKind = SourceDefinition["kind"];

/** Labels mirror the legacy ribbon's Add group exactly. */
export const SOURCE_LABELS: Record<SourceKind, string> = {
  "accounts": "Security accounts",
  "items-dynamic": "Items dynamically",
  "files-dynamic": "Files dynamically",
  "items-static": "Items statically",
  "files-static": "Files statically",
};

export const SOURCE_ICONS: Record<SourceKind, string> = {
  "accounts": mdiAccountGroupOutline,
  "items-dynamic": mdiTextSearch,
  "files-dynamic": mdiFolderSearchOutline,
  "items-static": mdiFileTreeOutline,
  "files-static": mdiFileDocumentMultipleOutline,
};

/**
 * The ribbon's Add group, in the order the legacy toolbar lists them.
 *
 * Only the two item kinds are offered. The rest describe things SitecoreAI has no
 * equivalent for, so authoring one would produce a source that can never resolve:
 *
 * - **Files** — there is no server file system to browse or to install files onto.
 * - **Security accounts** — users and roles live in the Cloud Portal, not in the content
 *   databases, and the Authoring API does not expose them to pick from.
 *
 * This only removes the way to CREATE one. Every kind stays in the model, the parser and
 * the serializer, so a definition authored by the classic Package Designer still opens,
 * round-trips byte-for-byte and saves unharmed — see {@link isReadOnlyKind}.
 */
export const ADD_ORDER: SourceKind[] = ["items-dynamic", "items-static"];

export function isDynamic(kind: SourceKind): boolean {
  return kind === "items-dynamic" || kind === "files-dynamic";
}

export function isFileKind(kind: SourceKind): boolean {
  return kind === "files-static" || kind === "files-dynamic";
}

/**
 * Kinds the designer shows but will not edit — the ones missing from {@link ADD_ORDER}.
 *
 * Silently dropping part of someone's package would be worse than not opening it, so an
 * existing source of one of these kinds is kept verbatim and routed to a read-only summary
 * instead of an editor.
 */
export function isReadOnlyKind(kind: SourceKind): boolean {
  return isFileKind(kind) || kind === "accounts";
}

/** The legacy designer shows unnamed sources as "Unnamed source" in the tree. */
export const UNNAMED = "Unnamed source";

export function sourceLabel(source: SourceDefinition): string {
  return source.name.trim() === "" ? UNNAMED : source.name;
}

/** A blank source of the given kind, ready for its wizard to fill in. */
export function createSource(kind: SourceKind, database = "master"): SourceDefinition {
  const base = { uid: newSourceUid(), name: "", behaviour: { ...ASK_USER } };
  switch (kind) {
    case "items-static":
      return { ...base, kind, entries: [], skipVersions: false };
    case "items-dynamic":
      return {
        ...base,
        kind,
        database,
        root: "",
        skipVersions: false,
        include: {},
        exclude: {},
      };
    case "files-static":
      return { ...base, kind, entries: [], converterRoot: "/" };
    case "files-dynamic":
      return { ...base, kind, root: "", converterRoot: "/", include: {}, exclude: {} };
    case "accounts":
      return { ...base, kind, entries: [] };
  }
}

/**
 * The Installation options column, as the legacy Preview writes it.
 *
 * `Undefined` is the designer's "Ask User" — the mode that defers the choice to the
 * installation wizard — so it is spelled out rather than shown as the raw enum value.
 */
export function behaviourLabel(behaviour: BehaviourOptions): string {
  if (behaviour.itemMode === "Undefined") return "Ask User";
  if (behaviour.itemMode === "Merge") return "Merge / " + behaviour.itemMergeMode;
  return behaviour.itemMode;
}

/**
 * A fingerprint of what a dynamic source would resolve to.
 *
 * Preview keeps its last result so that switching tabs does not re-run a walk thousands of
 * requests long. That cache has to know when it stopped describing the current query —
 * showing yesterday's list beside today's filters is worse than showing nothing. Comparing
 * this string is how the tab decides to label a result stale.
 *
 * Deliberately not a hash: the strings are small, and a collision would silently present a
 * stale list as current.
 */
export function dynamicQueryKey(source: SourceDefinition): string {
  if (source.kind !== "items-dynamic") return source.uid;
  return JSON.stringify([source.database, source.root, source.include, source.exclude]);
}

/** How many entries a source contributes, for the left nav and Preview tab. */
export function entryCount(source: SourceDefinition): number | undefined {
  switch (source.kind) {
    case "items-static":
    case "files-static":
    case "accounts":
      return source.entries.length;
    default:
      return undefined; // dynamic sources resolve at generation time
  }
}
