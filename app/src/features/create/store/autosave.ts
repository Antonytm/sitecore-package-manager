// features/create/store/autosave — the draft slot.
//
// Restores the autosaved draft once, then writes the serialized definition back on a
// debounce so a reload never loses unsaved work. Named projects (Save / Save as / Open)
// are a separate, explicit action — see storage/definitions.
//
// Both entry points take an injectable `Storage`, mirroring storage/definitions.ts. That
// is what keeps this testable: vitest runs in the node environment where there is no real
// localStorage, so a module that reached for the default would only be testable in a DOM.
//
// Neither function may be called at module load. These modules are evaluated during Next's
// prerender, where touching localStorage would throw on the server — so both are driven
// from an effect.

import { parseDefinition } from "@/src/core/definition";
import { readDraft, saveDraft } from "@/src/storage/definitions";
import { selectXml } from "./designer";
import type { DesignerStoreApi } from "./designer";

export const AUTOSAVE_DELAY_MS = 600;

/**
 * Restore the autosaved draft into the store, then mark it hydrated.
 *
 * A draft that no longer parses is discarded rather than blocking the designer, and
 * `hydrated` is set either way — otherwise one bad draft would suppress autosave forever.
 */
export function restoreDraft(
  store: DesignerStoreApi,
  storage?: Storage,
): void {
  try {
    const draft = readDraft(storage);
    if (draft) store.getState().load(parseDefinition(draft), null);
  } catch {
    // Unreadable storage, or a draft that no longer parses. Start clean.
  }
  store.getState().setHydrated();
}

/**
 * Begin autosaving the document. Returns an unsubscribe.
 *
 * Subscribes to `definition` alone, not to the whole state: selecting a different source
 * in the left nav changes the state but not the document, and must not re-arm the timer.
 *
 * `onError` receives a storage failure (private mode, quota) so the UI can warn; the
 * subscription itself keeps running, since the next write may well succeed.
 */
export function startDraftAutosave(
  store: DesignerStoreApi,
  options: { storage?: Storage; onError?: (error: Error | undefined) => void } = {},
): () => void {
  const { storage, onError } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const unsubscribe = store.subscribe(
    (state) => state.definition,
    () => {
      // Never write before the stored draft has been read, or the initial empty document
      // would overwrite the draft we are about to load.
      if (!store.getState().hydrated) return;

      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          saveDraft(selectXml(store.getState()), storage);
          onError?.(undefined);
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }, AUTOSAVE_DELAY_MS);
    },
  );

  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
