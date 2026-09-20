// Draft restore and debounced autosave.
//
// Both were a useEffect + useRef pair inside useDefinition and therefore untestable. The
// ordering they encode is load-bearing: write before the draft has been read and the
// initial empty document silently destroys the user's work.
//
// The Storage shims mirror storage/__tests__/definitions.test.ts — node has no real
// localStorage, which is exactly why every accessor takes one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AUTOSAVE_DELAY_MS, restoreDraft, startDraftAutosave } from "../autosave";
import { createDesignerStore, selectXml } from "../designer";
import type { DesignerStoreApi } from "../designer";
import { buildDefinition, emptyDefinition } from "@/src/core/definition";
import { readDraft, saveDraft } from "@/src/storage/definitions";
import { createSource } from "../../sources";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

/** Storage that rejects everything, like a browser with site data blocked. */
function hostileStorage(): Storage {
  const throwing = () => {
    throw new DOMException("denied");
  };
  return {
    length: 0,
    clear: throwing,
    getItem: throwing,
    key: throwing,
    removeItem: throwing,
    setItem: throwing,
  } as unknown as Storage;
}

let store: DesignerStoreApi;
let storage: Storage;

beforeEach(() => {
  store = createDesignerStore();
  storage = memoryStorage();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("restoreDraft", () => {
  it("loads a stored draft into the document", () => {
    const definition = emptyDefinition();
    definition.metadata.name = "Restored";
    saveDraft(buildDefinition(definition), storage);

    restoreDraft(store, storage);

    expect(store.getState().definition.metadata.name).toBe("Restored");
  });

  it("restores as an UNNAMED project — a draft is not a saved project", () => {
    saveDraft(buildDefinition(emptyDefinition()), storage);
    restoreDraft(store, storage);
    expect(store.getState().projectName).toBeNull();
    expect(store.getState().dirty).toBe(false);
  });

  it("marks the store hydrated", () => {
    restoreDraft(store, storage);
    expect(store.getState().hydrated).toBe(true);
  });

  it("leaves an empty document when there is no draft", () => {
    restoreDraft(store, storage);
    expect(store.getState().definition.sources).toEqual([]);
  });

  it("discards a draft that no longer parses rather than blocking the designer", () => {
    saveDraft("this is not a definition", storage);
    expect(() => restoreDraft(store, storage)).not.toThrow();
    expect(store.getState().definition.sources).toEqual([]);
  });

  it("still hydrates after a bad draft — one would otherwise suppress autosave forever", () => {
    saveDraft("this is not a definition", storage);
    restoreDraft(store, storage);
    expect(store.getState().hydrated).toBe(true);
  });

  it("survives storage that throws on read", () => {
    expect(() => restoreDraft(store, hostileStorage())).not.toThrow();
    expect(store.getState().hydrated).toBe(true);
  });
});

describe("startDraftAutosave", () => {
  it("writes the serialized definition after the debounce", () => {
    restoreDraft(store, storage);
    const stop = startDraftAutosave(store, { storage });

    store.getState().patchMetadata({ name: "Typed" });
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    expect(readDraft(storage)).toBe(selectXml(store.getState()));
    stop();
  });

  it("does not write before the debounce elapses", () => {
    restoreDraft(store, storage);
    const stop = startDraftAutosave(store, { storage });

    store.getState().patchMetadata({ name: "Typed" });
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);

    expect(readDraft(storage)).toBeUndefined();
    stop();
  });

  it("coalesces a burst of edits into one write", () => {
    restoreDraft(store, storage);
    const setItem = vi.spyOn(storage, "setItem");
    const stop = startDraftAutosave(store, { storage });

    for (const name of ["a", "ab", "abc"]) {
      store.getState().patchMetadata({ name });
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(store.getState().definition.metadata.name).toBe("abc");
    stop();
  });

  it("does NOT write while unhydrated — the empty document must not clobber the draft", () => {
    const stop = startDraftAutosave(store, { storage });

    store.getState().patchMetadata({ name: "Typed" });
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    expect(readDraft(storage)).toBeUndefined();
    stop();
  });

  it("ignores a selection change, which is not a document edit", () => {
    restoreDraft(store, storage);
    store.getState().addSource(createSource("items-static"));
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    const setItem = vi.spyOn(storage, "setItem");
    const stop = startDraftAutosave(store, { storage });

    store.getState().select({ kind: "metadata" });
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    expect(setItem).not.toHaveBeenCalled();
    stop();
  });

  it("reports a storage failure through onError", () => {
    restoreDraft(store, storage);
    const onError = vi.fn();
    const stop = startDraftAutosave(store, { storage: hostileStorage(), onError });

    store.getState().patchMetadata({ name: "Typed" });
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    stop();
  });

  it("clears the error after a write succeeds again", () => {
    restoreDraft(store, storage);
    const onError = vi.fn();
    const stop = startDraftAutosave(store, { storage, onError });

    store.getState().patchMetadata({ name: "Typed" });
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    expect(onError).toHaveBeenCalledWith(undefined);
    stop();
  });

  it("stops writing once unsubscribed", () => {
    restoreDraft(store, storage);
    const stop = startDraftAutosave(store, { storage });
    stop();

    store.getState().patchMetadata({ name: "Typed" });
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    expect(readDraft(storage)).toBeUndefined();
  });

  it("cancels a pending write when unsubscribed mid-debounce", () => {
    restoreDraft(store, storage);
    const stop = startDraftAutosave(store, { storage });

    store.getState().patchMetadata({ name: "Typed" });
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    stop();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);

    expect(readDraft(storage)).toBeUndefined();
  });
});
