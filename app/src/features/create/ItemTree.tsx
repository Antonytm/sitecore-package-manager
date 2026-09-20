"use client";

// features/create/ItemTree — the live Sitecore content tree used by both item pickers.
//
// Lazy: a node's children are fetched the first time it is expanded, which is what makes
// browsing a large content tree viable over the Authoring API. Selection is single-node,
// matching the legacy Select Items / Select Root Item dialogs.
//
// Expansion lives in the session store, keyed by `treeId`. That keying is the whole point:
// the pickers are separate trees and must not share one expansion set. Fetched children
// stay local — they are a remote cache scoped to a mounted node, not UI state anyone else
// reads.

import { useCallback, useEffect, useState } from "react";
import { mdiChevronDown, mdiChevronRight, mdiFileOutline, mdiFolderOutline } from "@mdi/js";
import { Icon } from "@/src/components/ui/icon";
import { Spinner } from "@/src/components/ui/spinner";
import { cn } from "@/src/lib/utils";
import { getChildren, getItem, TREE_ROOT_PATH } from "@/src/xmc/browse";
import { AuthoringError } from "@/src/xmc/authoring";
import type { ItemNode } from "@/src/xmc/browse";
import { isTreeNodeExpanded, useSession } from "./store/session";

interface TreeProps {
  /**
   * Which tree this is. Scopes expansion in the session store, so two pickers open in turn
   * keep their own state instead of fighting over one.
   */
  treeId: string;
  /** Where the tree starts. Defaults to `/sitecore`, as the legacy picker does. */
  rootPath?: string;
  selectedId?: string;
  onSelect: (node: ItemNode) => void;
}

export function ItemTree({ treeId, rootPath = TREE_ROOT_PATH, selectedId, onSelect }: TreeProps) {
  const ctx = useSession((s) => s.ctx);
  const setExpanded = useSession((s) => s.setTreeNodeExpanded);
  const [root, setRoot] = useState<ItemNode | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [detail, setDetail] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    getItem(ctx, { path: rootPath })
      .then((node) => {
        if (cancelled) return;
        setRoot(node);
        if (node) {
          // The root starts open, as it always has.
          setExpanded(treeId, node.id, true);
        } else {
          setError("Could not find " + rootPath);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        // An unreadable response is a shape problem, not a content problem — show what
        // came back so it can be diagnosed without opening DevTools.
        setDetail(e instanceof AuthoringError ? e.received : undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, rootPath, treeId, setExpanded]);

  if (!ctx) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Connecting to Sitecore…
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Loading content tree…
      </div>
    );
  }
  if (error || !root) {
    return (
      <div className="space-y-2 p-4 text-sm">
        <p className="text-danger-fg">{error ?? "The content tree is unavailable."}</p>
        {detail && (
          <pre className="overflow-auto rounded-md bg-neutral-bg p-2 text-xs">
            response shape: {detail}
          </pre>
        )}
        <p className="text-xs text-muted-foreground">
          The full response is logged to the browser console as{" "}
          <code>[package-manager] unreadable Authoring API response</code>.
        </p>
      </div>
    );
  }

  return (
    <div role="tree" className="overflow-auto p-1 text-sm">
      <TreeNode
        treeId={treeId}
        node={root}
        depth={0}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </div>
  );
}

interface NodeProps {
  treeId: string;
  node: ItemNode;
  depth: number;
  selectedId?: string;
  onSelect: (node: ItemNode) => void;
}

function TreeNode({ treeId, node, depth, selectedId, onSelect }: NodeProps) {
  const ctx = useSession((s) => s.ctx);
  const expanded = useSession((s) => isTreeNodeExpanded(s, treeId, node.id));
  const toggle = useSession((s) => s.toggleTreeNode);
  const setExpanded = useSession((s) => s.setTreeNodeExpanded);
  const [children, setChildren] = useState<ItemNode[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    if (!ctx || children || loading) return;
    setLoading(true);
    try {
      setChildren(await getChildren(ctx, { itemId: node.id }));
      setError(undefined);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [children, loading, ctx, node.id]);

  // Fetch children when a node is expanded, including the auto-expanded root.
  useEffect(() => {
    if (expanded) void load();
  }, [expanded, load]);

  const isSelected = selectedId === node.id;

  return (
    <div>
      <div
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={node.hasChildren ? expanded : undefined}
        tabIndex={0}
        onClick={() => onSelect(node)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(node);
          } else if (e.key === "ArrowRight" && node.hasChildren) {
            setExpanded(treeId, node.id, true);
          } else if (e.key === "ArrowLeft") {
            setExpanded(treeId, node.id, false);
          }
        }}
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 outline-none",
          "hover:bg-neutral-bg focus-visible:ring-primary/50 focus-visible:ring-2",
          isSelected && "bg-primary-bg font-medium",
        )}
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <button
          type="button"
          aria-label={expanded ? "Collapse " + node.name : "Expand " + node.name}
          className={cn("shrink-0 rounded-sm", !node.hasChildren && "invisible")}
          onClick={(e) => {
            e.stopPropagation();
            toggle(treeId, node.id);
          }}
          tabIndex={-1}
        >
          <Icon path={expanded ? mdiChevronDown : mdiChevronRight} className="size-4" />
        </button>
        <Icon
          path={node.hasChildren ? mdiFolderOutline : mdiFileOutline}
          className="size-4 shrink-0 text-neutral-fg"
        />
        <span className="truncate">{node.name}</span>
      </div>

      {expanded && (
        <div role="group">
          {loading && (
            <div
              className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: (depth + 1) * 16 + 24 }}
            >
              <Spinner className="size-3" /> Loading…
            </div>
          )}
          {error && (
            <div
              className="py-1 text-xs text-danger-fg"
              style={{ paddingLeft: (depth + 1) * 16 + 24 }}
            >
              {error}
            </div>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.id}
              treeId={treeId}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
