"use client";

// features/create/store/session — everything that is NOT the document.
//
// The live Sitecore connection, the banner messages, and the ephemeral UI (which modal is
// open, which tab each source is on, which tree nodes are expanded). None of it is
// persisted and none of it belongs in a saved project.
//
// Two things this fixes by existing:
//
//   * `ctx` was rebuilt by a useMemo in PackageDesigner and then prop-drilled through
//     SourceDetail into every tab, dialog and TreeNode — several hops never dereferenced
//     it, they only passed it on. `createXmcContext` returns a fresh object each call and
//     `ctx` is an effect dependency in ItemTree, SearchRootTab and AccountsDialog, so a
//     new identity per render would refetch the tree. Holding it here makes it stable.
//   * The designer and the hub page each ran their own `application.context` query into
//     their own state. Now there is one session.

import { useEffect } from "react";
import { create } from "zustand";
import type { ApplicationContext, ClientSDK } from "@sitecore-marketplace-sdk/client";
import { listLanguages } from "@/src/xmc/browse";
import type { LanguageInfo } from "@/src/xmc/browse";
import type { PreviewEntry } from "@/src/xmc/resolve";
import type { FilterKey } from "@/src/core/filters";
import { contextIdOf, createXmcContext } from "@/src/xmc/client";
import { describeEnvironment, narrowHostState } from "@/src/xmc/environment";
import type { EnvironmentInfo } from "@/src/xmc/environment";
import type { XmcContext } from "@/src/xmc/client";
import { useMarketplaceClient } from "@/src/utils/hooks/useMarketplaceClient";
import type { ProjectDialogMode } from "../dialogs/ProjectDialog";

/**
 * Which modal is open.
 *
 * A union rather than one boolean per dialog: they are mutually exclusive on screen, and
 * separate flags make it representable for two to be open at once.
 */
export type ActiveDialog =
  | { kind: "project"; mode: ProjectDialogMode }
  | { kind: "entries" }
  | { kind: "template-picker" }
  | { kind: "root-picker" }
  | { kind: "package-preview" }
  | { kind: "generate" }
  | null;

/**
 * What a source's PREVIEW tab last resolved to.
 *
 * Held here rather than in the tab because the tab does not survive: `SourceDetail` is
 * keyed by source uid, and Radix unmounts an inactive `TabsContent` — so switching source
 * or tab would re-fire a walk that can be thousands of requests long.
 */
export interface PreviewResult {
  /** Fingerprint of the query this came from; a filter edit makes it stale, not wrong. */
  key: string;
  entries: PreviewEntry[];
  scanned: number;
  truncated: boolean;
  unevaluated: FilterKey[];
  note?: string;
  /** When it ran, so a stale result can say how old it is. */
  at: number;
}

/** Per-tree UI, keyed by a caller-supplied tree id. */
export interface TreeUi {
  expanded: string[];
}

export interface SessionState {
  client?: ClientSDK;
  appContext?: ApplicationContext;
  /**
   * Which SitecoreAI project/environment this session is pointed at, resolved once.
   *
   * Derived rather than raw: `host.state` carries a `userInfo` block (email, name, auth
   * subject) that this app has no use for, and `narrowHostState` drops it before anything
   * is stored. Nothing downstream can render or copy what was never kept.
   */
  environment?: EnvironmentInfo;
  contextId?: string;
  ctx?: XmcContext;
  languages: LanguageInfo[];
  /** True once application.context has been answered, successfully or not. */
  contextLoaded: boolean;
  connectionError?: Error;
  autosaveError?: Error;
  status?: string;
  activeDialog: ActiveDialog;
  /** Active detail tab, keyed by source uid so switching sources cannot carry one over. */
  activeTab: Record<string, string>;
  trees: Record<string, TreeUi>;
  /** Last resolved preview per source uid. Never persisted — it describes live content. */
  previews: Record<string, PreviewResult>;
}

export interface SessionActions {
  connect(client: ClientSDK): Promise<void>;
  setConnectionError(error: Error | undefined): void;
  setAutosaveError(error: Error | undefined): void;
  setStatus(status: string | undefined): void;
  openDialog(dialog: NonNullable<ActiveDialog>): void;
  closeDialog(): void;
  setActiveTab(uid: string, tab: string): void;
  setPreview(uid: string, result: PreviewResult): void;
  toggleTreeNode(treeId: string, nodeId: string): void;
  setTreeNodeExpanded(treeId: string, nodeId: string, expanded: boolean): void;
}

export type SessionStore = SessionState & SessionActions;

export const useSession = create<SessionStore>()((set, get) => ({
  languages: [],
  contextLoaded: false,
  activeDialog: null,
  activeTab: {},
  trees: {},
  previews: {},

  connect: async (client) => {
    // Both pages call this from an effect, and React StrictMode double-invokes in dev.
    if (get().client === client) return;
    set({ client });

    let appContext: ApplicationContext | undefined;
    try {
      const result = await client.query("application.context");
      appContext = result.data;
    } catch (error) {
      set({
        contextLoaded: true,
        connectionError: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    // `HostState<'portal'>` is typed `null`, but a standalone extension really is answered
    // with a populated `xmCloudTenantInfo` — that is where the project and environment
    // NAMES come from, and the type is what would have stopped us asking. Non-fatal: the
    // resolver falls back to `tenantDisplayName` when this yields nothing.
    let host;
    try {
      const state = await client.query("host.state");
      host = narrowHostState(state?.data);
    } catch {
      host = undefined;
    }

    const contextId = contextIdOf(appContext);
    if (!contextId) {
      // Not fatal on its own, but every picker will fail without it, so leave a breadcrumb
      // next to the raw payload the banner renders.
      console.warn("[package-manager] no Sitecore context id in application.context", appContext);
    }

    const ctx = createXmcContext(client, { contextId });
    set({
      appContext,
      environment: describeEnvironment(appContext, host),
      contextId,
      ctx,
      contextLoaded: true,
    });

    // Languages drive the language filter's checkbox list; failure is non-fatal.
    try {
      set({ languages: await listLanguages(ctx) });
    } catch {
      set({ languages: [] });
    }
  },

  setConnectionError: (connectionError) => set({ connectionError }),
  setAutosaveError: (autosaveError) => set({ autosaveError }),
  setStatus: (status) => set({ status }),

  openDialog: (activeDialog) => set({ activeDialog }),
  closeDialog: () => set({ activeDialog: null }),

  setActiveTab: (uid, tab) => set((s) => ({ activeTab: { ...s.activeTab, [uid]: tab } })),

  setPreview: (uid, result) => set((s) => ({ previews: { ...s.previews, [uid]: result } })),

  toggleTreeNode: (treeId, nodeId) => {
    const expanded = get().trees[treeId]?.expanded ?? [];
    get().setTreeNodeExpanded(treeId, nodeId, !expanded.includes(nodeId));
  },

  setTreeNodeExpanded: (treeId, nodeId, expanded) =>
    set((s) => {
      const current = s.trees[treeId]?.expanded ?? [];
      // Return the same state when nothing changes, so subscribers do not re-render on a
      // no-op (the root auto-expands on every load, for one).
      if (current.includes(nodeId) === expanded) return s;
      return {
        trees: {
          ...s.trees,
          [treeId]: {
            expanded: expanded
              ? [...current, nodeId]
              : current.filter((id) => id !== nodeId),
          },
        },
      };
    }),
}));

/**
 * Establish the session once the Marketplace SDK client is up.
 *
 * Called by both the hub page and the designer; `connect` short-circuits on the second
 * caller, so whichever mounts first wins and the other reuses the result.
 */
export function useSessionBootstrap(): void {
  const { client, error, isInitialized } = useMarketplaceClient();
  const connect = useSession((s) => s.connect);
  const setConnectionError = useSession((s) => s.setConnectionError);

  useEffect(() => {
    if (error) setConnectionError(error);
  }, [error, setConnectionError]);

  useEffect(() => {
    if (!isInitialized || !client) return;
    void connect(client);
  }, [client, isInitialized, connect]);
}

/** Whether a tree node is expanded. Kept here so callers do not reach into `trees`. */
export function isTreeNodeExpanded(
  state: SessionState,
  treeId: string,
  nodeId: string,
): boolean {
  return state.trees[treeId]?.expanded.includes(nodeId) ?? false;
}
