// Runs under vitest's node environment, so there is no real localStorage — the store
// takes an injectable Storage for exactly this reason.

import { describe, it, expect, beforeEach } from "vitest";
import {
  StorageUnavailableError,
  clearDraft,
  definitionExists,
  deleteDefinition,
  listDefinitions,
  readDefinition,
  readDraft,
  saveDefinition,
  saveDraft,
} from "../definitions";

/** Minimal in-memory Storage. */
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

let store: Storage;
beforeEach(() => {
  store = memoryStorage();
});

describe("saved projects", () => {
  it("saves, reads back and lists a project", () => {
    saveDefinition("My package", "<project />", store);
    expect(readDefinition("My package", store)).toBe("<project />");
    expect(definitionExists("My package", store)).toBe(true);
    expect(listDefinitions(store).map((d) => d.name)).toEqual(["My package"]);
  });

  it("stamps savedAt", () => {
    const saved = saveDefinition("a", "<project />", store);
    expect(Number.isNaN(Date.parse(saved.savedAt))).toBe(false);
  });

  it("overwrites a project saved under the same name", () => {
    saveDefinition("a", "<one />", store);
    saveDefinition("a", "<two />", store);
    expect(readDefinition("a", store)).toBe("<two />");
    expect(listDefinitions(store)).toHaveLength(1);
  });

  it("lists case-insensitively by name", () => {
    for (const n of ["zebra", "Apple", "mango"]) saveDefinition(n, "<project />", store);
    expect(listDefinitions(store).map((d) => d.name)).toEqual(["Apple", "mango", "zebra"]);
  });

  it("deletes a project, and ignores deleting one that is absent", () => {
    saveDefinition("a", "<project />", store);
    deleteDefinition("a", store);
    expect(readDefinition("a", store)).toBeUndefined();
    expect(() => deleteDefinition("missing", store)).not.toThrow();
  });

  it("preserves definition XML verbatim, including CRLF", () => {
    const xml = "<project>\r\n  <Name />\r\n</project>";
    saveDefinition("a", xml, store);
    expect(readDefinition("a", store)).toBe(xml);
  });

  it("reports a missing project as undefined", () => {
    expect(readDefinition("nope", store)).toBeUndefined();
    expect(definitionExists("nope", store)).toBe(false);
  });
});

describe("the working draft", () => {
  it("saves, reads and clears", () => {
    expect(readDraft(store)).toBeUndefined();
    saveDraft("<project />", store);
    expect(readDraft(store)).toBe("<project />");
    clearDraft(store);
    expect(readDraft(store)).toBeUndefined();
  });

  it("is independent of the named projects", () => {
    saveDefinition("a", "<saved />", store);
    saveDraft("<draft />", store);
    expect(readDefinition("a", store)).toBe("<saved />");
    clearDraft(store);
    expect(readDefinition("a", store)).toBe("<saved />");
  });
});

describe("when storage is unavailable", () => {
  it("reads degrade to empty rather than throwing", () => {
    expect(listDefinitions(hostileStorage())).toEqual([]);
    expect(readDefinition("a", hostileStorage())).toBeUndefined();
    expect(readDraft(hostileStorage())).toBeUndefined();
    expect(listDefinitions(undefined)).toEqual([]);
  });

  it("writes throw a typed error the UI can surface", () => {
    expect(() => saveDefinition("a", "<project />", hostileStorage())).toThrow(
      StorageUnavailableError,
    );
    expect(() => saveDraft("<project />", undefined)).toThrow(StorageUnavailableError);
  });

  it("clearing a draft never throws", () => {
    expect(() => clearDraft(hostileStorage())).not.toThrow();
    expect(() => clearDraft(undefined)).not.toThrow();
  });

  it("survives corrupt stored JSON", () => {
    store.setItem("spm.definitions.v1", "{not json");
    expect(listDefinitions(store)).toEqual([]);
    saveDefinition("a", "<project />", store);
    expect(listDefinitions(store).map((d) => d.name)).toEqual(["a"]);
  });

  it("skips entries that are not shaped like a project", () => {
    store.setItem("spm.definitions.v1", JSON.stringify({ good: { xml: "<a />" }, bad: 42 }));
    expect(listDefinitions(store).map((d) => d.name)).toEqual(["good"]);
  });
});
