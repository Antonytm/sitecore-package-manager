// Everything Generate ZIP decides, kept out of the dialog so it can be tested.
//
// vitest runs `environment: "node"` over `src/**/*.test.ts` — no jsdom, no .tsx — so a
// decision living inside a component is a decision with no coverage. The dialog stays a
// renderer; the naming, the model assembly and the honesty about what the package does and
// does not contain all live here.

import type {
  ItemModel,
  PackageDefinition,
  PackageModel,
  SourceDefinition,
} from "@/src/core/model";
import type { ExportedPackage } from "@/src/xmc/export";
import { isReadOnlyKind, sourceLabel } from "../sources";

/** The legacy dialog pre-fills `Unnamed Package.zip`; a named package uses its own name. */
export function defaultPackageName(definition: PackageDefinition): string {
  const name = definition.metadata.name?.trim();
  if (!name) return "Unnamed Package.zip";
  const version = definition.metadata.version?.trim();
  return (version ? name + "-" + version : name) + ".zip";
}

/**
 * The value `writePackage` turns into bytes.
 *
 * `saveProject` mirrors the definition, so a package built from a project that stores its
 * definition carries `installer/project` and one that does not, does not — the same switch
 * the legacy generator reads.
 */
export function toPackageModel(
  definition: PackageDefinition,
  items: ItemModel[],
): PackageModel {
  return {
    metadata: definition.metadata,
    items,
    sources: definition.sources,
    saveProject: definition.saveProject,
  };
}

/** Sources that are kept in the definition but can never contribute content here. */
export function inertSources(sources: SourceDefinition[]): SourceDefinition[] {
  return sources.filter((s) => isReadOnlyKind(s.kind));
}

const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

/**
 * What the user needs to know before shipping this package, worst first.
 *
 * Each line describes something the package does NOT contain, or contains differently from
 * what was asked. Generation already refuses outright when the result would be wrong; these
 * are the cases where it is incomplete but still useful, and hiding them would mean the
 * gap is discovered on the target instead of here.
 */
export function generationCaveats(
  result: ExportedPackage,
  definition: PackageDefinition,
): string[] {
  const lines: string[] = [];

  if (result.danglingMedia.length > 0) {
    lines.push(
      plural(result.danglingMedia.length, "item") +
        " reference media whose binary could not be read, so the package carries the " +
        "reference without the file: " +
        result.danglingMedia.slice(0, 5).join(", ") +
        (result.danglingMedia.length > 5 ? ", …" : "") +
        ". The media has to already exist on the target, or those items will install broken.",
    );
  }

  if (result.problems.length > 0) {
    lines.push(
      plural(result.problems.length, "problem") +
        " while reading content — " +
        result.problems.slice(0, 5).join("; ") +
        (result.problems.length > 5 ? "; …" : ""),
    );
  }

  const inert = inertSources(definition.sources);
  if (inert.length > 0) {
    lines.push(
      "Skipped " +
        inert.map(sourceLabel).join(", ") +
        " — SitecoreAI has no server file system and identity lives in the Cloud Portal, so " +
        "file and security-account sources are preserved in the definition but contribute " +
        "nothing to the package.",
    );
  }

  if (result.duplicates > 0) {
    lines.push(
      plural(result.duplicates, "duplicate entry", "duplicate entries") +
        " removed — the same item was claimed by more than one source, and a package " +
        "carries each item once.",
    );
  }

  return lines;
}

/** One line stating what was actually built. */
export function generationSummary(result: ExportedPackage): string {
  const versions = result.items.reduce(
    (n, item) => n + item.languages.reduce((m, l) => m + l.versions.length, 0),
    0,
  );
  return (
    plural(result.items.length, "item") + ", " + plural(versions, "version") + " in total."
  );
}
