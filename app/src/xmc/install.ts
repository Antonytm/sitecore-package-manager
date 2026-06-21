// xmc/install — apply a parsed package to XM Cloud.  (model ──► API)
//
// The "ZIP → Marketplace API calls" direction. Takes the resolved ItemModel[] from
// core and writes them via the XMC Authoring API, honoring collision options.
// See wiki/articles/package-installation.md.

import type { ItemModel, PackageModel } from "../core/model";
import type { XmcContext } from "./client";
import type { CollisionPrompt } from "./collisions";

export interface InstallOptions {
  /** Called when a source's option is "Ask User". */
  onCollision?: CollisionPrompt;
  /** Progress callback (per item). */
  onProgress?: (done: number, total: number, item: ItemModel) => void;
}

export interface InstallResult {
  installed: number;
  skipped: number;
  failed: Array<{ item: ItemModel; error: string }>;
}

/** Apply every item in the package to the target environment. */
export async function installPackage(
  _ctx: XmcContext,
  _pkg: PackageModel,
  _opts: InstallOptions = {},
): Promise<InstallResult> {
  // TODO: for each item → check existence → resolveCollision → XMC create/update mutation.
  throw new Error("installPackage: not implemented");
}
