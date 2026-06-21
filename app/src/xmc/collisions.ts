// xmc/collisions — resolve item collisions during install.
//
// The runtime counterpart of the legacy collision dialog (Overwrite / Merge(+submode) /
// Skip, with Apply / Apply-to-all / Abort). See wiki/articles/installation-wizard-ui.md
// Screen 9. The per-source default comes from CollisionOption; "Ask User" is resolved
// here by prompting the UI.

import type { CollisionOption, ItemModel } from "../core/model";

/** What the user (or a pre-set option) decided for a colliding item. */
export interface CollisionDecision extends CollisionOption {
  /** Apply this decision to every remaining collision, not just this item. */
  applyToAll?: boolean;
  /** Abort the whole installation. */
  abort?: boolean;
}

/** Asked by the install loop when a source's option is "Ask User". The UI supplies this. */
export type CollisionPrompt = (item: ItemModel) => Promise<CollisionDecision>;

/**
 * Decide how to handle one colliding item: use the source default unless it's "Ask User",
 * in which case prompt. (Stub — fill in once install.ts drives the loop.)
 */
export async function resolveCollision(
  _item: ItemModel,
  _sourceDefault: CollisionOption | "ask",
  _prompt: CollisionPrompt,
): Promise<CollisionDecision> {
  throw new Error("resolveCollision: not implemented");
}
