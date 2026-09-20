"use client";

// The React binding for the document store.
//
// Kept separate so ./designer itself imports no React: that is what lets the whole reducer
// surface be tested under vitest's node environment. Everything here is a one-liner over
// the store in ./designer.

import { useStore } from "zustand";
import { designerStore, selectSelectedSource, selectXml } from "./designer";
import type { DesignerStore } from "./designer";
import type { SourceDefinition } from "@/src/core/model";

/**
 * Subscribe to a slice of the document.
 *
 * Selectors that build a new object or array each call need `useShallow`
 * (`zustand/react/shallow`) — v5 dropped the equality-function argument, so a fresh
 * reference every render would re-render forever.
 */
export function useDesigner<T>(selector: (state: DesignerStore) => T): T {
  return useStore(designerStore, selector);
}

/** The serialized definition. Memoized on definition identity — see {@link selectXml}. */
export function useDefinitionXml(): string {
  return useStore(designerStore, selectXml);
}

/** The source the left nav has selected, if any. */
export function useSelectedSource(): SourceDefinition | undefined {
  return useStore(designerStore, selectSelectedSource);
}
