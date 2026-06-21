// core/definition — installer/project definition XML  <->  sources + metadata.
//
// The package definition schema (static `xitems`/`xfiles`/`accounts` vs dynamic
// `items`/`files` sources) from wiki/articles/package-definition-xml.md.
//
// TODO: implement against the same XML lib as core/items.

import type { PackageMetadata, SourceDefinition } from "../model";

export interface ParsedDefinition {
  metadata: PackageMetadata;
  sources: SourceDefinition[];
}

/** Parse `installer/project` into metadata + source definitions. */
export function parseDefinition(_xml: string): ParsedDefinition {
  throw new Error("parseDefinition: not implemented");
}

/** Build the `installer/project` XML from metadata + source definitions. */
export function buildDefinition(_def: ParsedDefinition): string {
  throw new Error("buildDefinition: not implemented");
}
