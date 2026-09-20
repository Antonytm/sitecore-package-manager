// The document store's transitions.
//
// These were a useReducer with no tests at all — the select-on-add behaviour, the
// remove-selected-source fallback and the exact set of actions that dirty the project were
// only ever exercised by hand through the UI.
//
// Nothing here renders. The store is built with zustand/vanilla precisely so it can be
// driven through getState() under vitest's node environment.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createDesignerStore,
  selectSelectedSource,
  selectXml,
} from "../designer";
import type { DesignerStoreApi } from "../designer";
import { buildDefinition, emptyDefinition } from "@/src/core/definition";
import { createSource } from "../../sources";

let store: DesignerStoreApi;
beforeEach(() => {
  store = createDesignerStore();
});

const state = () => store.getState();

describe("initial state", () => {
  it("opens on the metadata page with an empty, clean document", () => {
    expect(state().selection).toEqual({ kind: "metadata" });
    expect(state().definition.sources).toEqual([]);
    expect(state().projectName).toBeNull();
    expect(state().dirty).toBe(false);
  });

  it("starts unhydrated, so autosave cannot run before the draft is read", () => {
    expect(state().hydrated).toBe(false);
  });

  it("gives each store its own document", () => {
    store.getState().addSource(createSource("items-static"));
    expect(createDesignerStore().getState().definition.sources).toEqual([]);
  });
});

describe("addSource", () => {
  it("appends the source", () => {
    const source = createSource("items-static");
    state().addSource(source);
    expect(state().definition.sources).toEqual([source]);
  });

  it("selects the new source — the legacy designer drops you into it", () => {
    const source = createSource("accounts");
    state().addSource(source);
    expect(state().selection).toEqual({ kind: "source", uid: source.uid });
  });

  it("marks the project dirty", () => {
    state().addSource(createSource("items-dynamic"));
    expect(state().dirty).toBe(true);
  });
});

describe("replaceSource", () => {
  it("swaps the matching source by uid and leaves the others alone", () => {
    const first = createSource("items-static");
    const second = createSource("accounts");
    state().addSource(first);
    state().addSource(second);

    state().replaceSource({ ...first, name: "Renamed" });

    expect(state().definition.sources.map((s) => s.name)).toEqual(["Renamed", ""]);
  });

  it("does not move the selection", () => {
    const first = createSource("items-static");
    const second = createSource("accounts");
    state().addSource(first);
    state().addSource(second); // selection is now `second`
    state().replaceSource({ ...first, name: "Renamed" });
    expect(state().selection).toEqual({ kind: "source", uid: second.uid });
  });
});

describe("removeSource", () => {
  it("drops the source", () => {
    const source = createSource("items-static");
    state().addSource(source);
    state().removeSource(source.uid);
    expect(state().definition.sources).toEqual([]);
  });

  it("falls back to metadata when the REMOVED source was the one on screen", () => {
    const source = createSource("items-static");
    state().addSource(source);
    state().removeSource(source.uid);
    expect(state().selection).toEqual({ kind: "metadata" });
  });

  it("does not move the user when a DIFFERENT source is removed", () => {
    const first = createSource("items-static");
    const second = createSource("accounts");
    state().addSource(first);
    state().addSource(second); // selection is `second`
    state().removeSource(first.uid);
    expect(state().selection).toEqual({ kind: "source", uid: second.uid });
  });
});

describe("dirty tracking", () => {
  it("is set by every document mutation", () => {
    const source = createSource("items-static");

    state().patchMetadata({ name: "P" });
    expect(state().dirty).toBe(true);

    store = createDesignerStore();
    state().addSource(source);
    expect(state().dirty).toBe(true);

    store = createDesignerStore();
    state().addSource(source);
    state().markSaved("P");
    state().replaceSource({ ...source, name: "x" });
    expect(state().dirty).toBe(true);

    store = createDesignerStore();
    state().addSource(source);
    state().markSaved("P");
    state().removeSource(source.uid);
    expect(state().dirty).toBe(true);
  });

  it("is NOT set by select — moving around is not an edit", () => {
    const source = createSource("items-static");
    state().addSource(source);
    state().markSaved("P");

    state().select({ kind: "metadata" });
    expect(state().dirty).toBe(false);
  });

  it("is cleared by markSaved, which also records the project name", () => {
    state().patchMetadata({ name: "P" });
    state().markSaved("My project");
    expect(state().dirty).toBe(false);
    expect(state().projectName).toBe("My project");
  });
});

describe("patchMetadata", () => {
  it("merges into the existing metadata rather than replacing it", () => {
    state().patchMetadata({ name: "P" });
    state().patchMetadata({ author: "A" });
    expect(state().definition.metadata.name).toBe("P");
    expect(state().definition.metadata.author).toBe("A");
  });
});

describe("load", () => {
  it("replaces the document and adopts the project name, clean", () => {
    const definition = emptyDefinition();
    definition.metadata.name = "Opened";
    state().patchMetadata({ name: "scratch" });

    state().load(definition, "Opened");

    expect(state().definition.metadata.name).toBe("Opened");
    expect(state().projectName).toBe("Opened");
    expect(state().dirty).toBe(false);
  });

  it("returns to the metadata page, since the old selection cannot survive", () => {
    state().addSource(createSource("items-static"));
    state().load(emptyDefinition(), null);
    expect(state().selection).toEqual({ kind: "metadata" });
  });
});

describe("reset", () => {
  it("clears the document, selection, name and dirty flag", () => {
    state().addSource(createSource("items-static"));
    state().markSaved("P");
    state().reset();

    expect(state().definition.sources).toEqual([]);
    expect(state().selection).toEqual({ kind: "metadata" });
    expect(state().projectName).toBeNull();
    expect(state().dirty).toBe(false);
  });

  it("KEEPS hydrated — New must not suppress autosave", () => {
    state().setHydrated();
    state().reset();
    expect(state().hydrated).toBe(true);
  });
});

describe("selectSelectedSource", () => {
  it("returns the selected source by uid", () => {
    const source = createSource("items-static");
    state().addSource(source);
    expect(selectSelectedSource(state())).toEqual(source);
  });

  it("returns undefined on the metadata page", () => {
    expect(selectSelectedSource(state())).toBeUndefined();
  });

  it("returns undefined when the selected uid no longer exists", () => {
    state().select({ kind: "source", uid: "gone" });
    expect(selectSelectedSource(state())).toBeUndefined();
  });
});

describe("selectXml", () => {
  it("serializes the current definition", () => {
    state().patchMetadata({ name: "P" });
    expect(selectXml(state())).toBe(buildDefinition(state().definition));
  });

  it("returns the identical string while the definition is unchanged", () => {
    state().patchMetadata({ name: "P" });
    // Object.is-stable, which is what makes it safe as a Zustand selector.
    expect(selectXml(state())).toBe(selectXml(state()));
  });

  it("recomputes when the definition changes", () => {
    state().patchMetadata({ name: "First" });
    const before = selectXml(state());
    state().patchMetadata({ name: "Second" });
    expect(selectXml(state())).not.toBe(before);
    expect(selectXml(state())).toContain("Second");
  });

  it("is not fooled by a selection change, which leaves the document alone", () => {
    const source = createSource("items-static");
    state().addSource(source);
    const before = selectXml(state());
    state().select({ kind: "metadata" });
    expect(selectXml(state())).toBe(before);
  });
});
