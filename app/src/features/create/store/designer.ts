// features/create/store/designer — the designer's document state.
//
// The package definition being edited, what the left nav has selected, and whether there
// are unsaved changes. This is the half of the designer's state that is PERSISTED and
// PURE: plain data, no live handles.
//
// Built with `zustand/vanilla` and deliberately NOT bound to React here — this module
// imports neither `react` nor the Marketplace SDK, so the whole reducer surface runs under
// vitest's `environment: "node"` with no jsdom and no new devDependencies. The React
// binding lives in ./hooks; persistence lives in ./autosave.

import { createStore } from "zustand/vanilla";
import type { Mutate, StoreApi } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { buildDefinition, emptyDefinition } from "@/src/core/definition";
import type {
  PackageDefinition,
  PackageMetadata,
  SourceDefinition,
} from "@/src/core/model";

/** What the left nav has selected: the metadata page, or one source by uid. */
export type Selection = { kind: "metadata" } | { kind: "source"; uid: string };

export interface DesignerState {
  definition: PackageDefinition;
  selection: Selection;
  /** Name of the saved project this was opened from / last saved as, if any. */
  projectName: string | null;
  /** True when there are edits since the last explicit save. */
  dirty: boolean;
  /** False until the stored draft has been restored, so autosave cannot run over it. */
  hydrated: boolean;
}

export interface DesignerActions {
  reset(): void;
  load(definition: PackageDefinition, projectName: string | null): void;
  patchMetadata(patch: Partial<PackageMetadata>): void;
  addSource(source: SourceDefinition): void;
  replaceSource(source: SourceDefinition): void;
  removeSource(uid: string): void;
  select(selection: Selection): void;
  markSaved(projectName: string): void;
  setHydrated(): void;
}

export type DesignerStore = DesignerState & DesignerActions;

/**
 * The store's own type, carrying the subscribeWithSelector mutator.
 *
 * Widening this to a plain `StoreApi` would drop the two-argument `subscribe(selector,
 * listener)` overload that the autosave subscription depends on.
 */
export type DesignerStoreApi = Mutate<
  StoreApi<DesignerStore>,
  [["zustand/subscribeWithSelector", never]]
>;

function initialState(): DesignerState {
  return {
    definition: emptyDefinition(),
    selection: { kind: "metadata" },
    projectName: null,
    dirty: false,
    hydrated: false,
  };
}

/**
 * A fresh, independent store.
 *
 * The app uses the {@link designerStore} singleton below; tests call this so each case
 * starts from a clean document instead of inheriting the previous one's edits.
 */
export function createDesignerStore(): DesignerStoreApi {
  return createStore<DesignerStore>()(
    subscribeWithSelector((set) => ({
      ...initialState(),

      // `hydrated` is about the draft having been read, not about the document — New must
      // not put the designer back into a state where autosave is suppressed.
      reset: () => set((s) => ({ ...initialState(), hydrated: s.hydrated })),

      load: (definition, projectName) =>
        set({ definition, selection: { kind: "metadata" }, projectName, dirty: false }),

      patchMetadata: (patch) =>
        set((s) => ({
          dirty: true,
          definition: {
            ...s.definition,
            metadata: { ...s.definition.metadata, ...patch },
          },
        })),

      addSource: (source) =>
        set((s) => ({
          dirty: true,
          // Select the new source immediately — the legacy designer drops you into it.
          selection: { kind: "source", uid: source.uid },
          definition: {
            ...s.definition,
            sources: [...s.definition.sources, source],
          },
        })),

      replaceSource: (source) =>
        set((s) => ({
          dirty: true,
          definition: {
            ...s.definition,
            sources: s.definition.sources.map((x) => (x.uid === source.uid ? source : x)),
          },
        })),

      removeSource: (uid) =>
        set((s) => {
          // Only fall back to the metadata page when the source being removed is the one
          // on screen; removing a different one must not move the user.
          const wasSelected = s.selection.kind === "source" && s.selection.uid === uid;
          return {
            dirty: true,
            selection: wasSelected ? { kind: "metadata" } : s.selection,
            definition: {
              ...s.definition,
              sources: s.definition.sources.filter((x) => x.uid !== uid),
            },
          };
        }),

      // The one mutation that does NOT dirty the project: moving around is not an edit.
      select: (selection) => set({ selection }),

      markSaved: (projectName) => set({ projectName, dirty: false }),

      setHydrated: () => set({ hydrated: true }),
    })),
  );
}

/** The one store the app uses. */
export const designerStore = createDesignerStore();

// ── selectors ───────────────────────────────────────────────────────────────

/**
 * The current definition, serialized — what Save, Download and autosave all write.
 *
 * Memoized on the definition's identity because `buildDefinition` walks the whole document
 * and every metadata keystroke produces a new one. Returning a stable string also makes
 * this safe to use directly as a Zustand selector, which compares with Object.is.
 */
let lastDefinition: PackageDefinition | undefined;
let lastXml = "";
export function selectXml(state: DesignerState): string {
  if (state.definition !== lastDefinition) {
    lastDefinition = state.definition;
    lastXml = buildDefinition(state.definition);
  }
  return lastXml;
}

/** The source the left nav has selected, if any. */
export function selectSelectedSource(state: DesignerState): SourceDefinition | undefined {
  if (state.selection.kind !== "source") return undefined;
  const { uid } = state.selection;
  return state.definition.sources.find((s) => s.uid === uid);
}
