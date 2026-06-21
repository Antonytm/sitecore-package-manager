// core/package — the public facade of the pure layer.
//
// Two inverse functions over the domain model. Everything above (xmc, UI) should
// import from here, not from the sub-modules.
//
//   readPackage:   zip bytes  ──►  PackageModel
//   writePackage:  PackageModel  ──►  zip bytes
//
// Round-trip invariant (your core test, runnable against files/ with no Sitecore):
//   writePackage(readPackage(bytes)) is byte-identical to `bytes`.

import type { PackageModel } from "./model";
import { readZip, writeZip } from "./zip";
import { parseItem, serializeItem } from "./items";
import { parseDefinition, buildDefinition } from "./definition";

/** Parse a classic Sitecore package `.zip` (outer bytes) into the domain model. */
export async function readPackage(bytes: Uint8Array): Promise<PackageModel> {
  // TODO: outer zip → inner package.zip → readZip → parseDefinition + parseItem(*)
  void bytes;
  void readZip;
  void parseItem;
  void parseDefinition;
  throw new Error("readPackage: not implemented");
}

/** Serialize the domain model back to a classic package `.zip` (outer bytes). */
export async function writePackage(model: PackageModel): Promise<Uint8Array> {
  // TODO: buildDefinition + serializeItem(*) → inner package.zip → writeZip → outer zip
  void model;
  void writeZip;
  void serializeItem;
  void buildDefinition;
  throw new Error("writePackage: not implemented");
}

export * from "./model";
