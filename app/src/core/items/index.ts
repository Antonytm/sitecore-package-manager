// core/items — item XML  <->  ItemModel.
//
// The heart of byte-compat: the per-version `<item>` XML (fields, encoding, blob refs)
// described in wiki/articles/item-serialization.md. Planned XML lib: `fast-xml-parser`.
//
// TODO: `npm i fast-xml-parser` and implement. Kept dependency-free for now.

import type { ItemModel } from "../model";

/** Parse one item's serialized XML into the domain model. */
export function parseItem(_xml: string): ItemModel {
  throw new Error("parseItem: not implemented");
}

/** Serialize an item back to its canonical XML form (must round-trip byte-for-byte). */
export function serializeItem(_item: ItemModel): string {
  throw new Error("serializeItem: not implemented");
}
