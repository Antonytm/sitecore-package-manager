"use client";

// SEARCH ROOT — a dynamic source's root, re-pickable after creation (legacy Screen 10).
//
// The file-source counterpart was removed with the file kinds: SitecoreAI has no server
// file system to browse, so there is nothing for a folder picker to show.

import { useEffect, useState } from "react";
import { Button } from "@/src/components/ui/button";
import { Checkbox } from "@/src/components/ui/checkbox";
import { Label } from "@/src/components/ui/label";
import { Spinner } from "@/src/components/ui/spinner";
import type { DynamicItemSource } from "@/src/core/model";
import { getItem } from "@/src/xmc/browse";
import { SelectRootItemDialog } from "../dialogs/SelectRootItemDialog";
import { useSession } from "../store/session";

interface ItemProps {
  source: DynamicItemSource;
  onChange: (source: DynamicItemSource) => void;
}

export function ItemSearchRootTab({ source, onChange }: ItemProps) {
  const ctx = useSession((s) => s.ctx);
  const picking = useSession((s) => s.activeDialog?.kind === "root-picker");
  const openDialog = useSession((s) => s.openDialog);
  const closeDialog = useSession((s) => s.closeDialog);
  // The resolved path is a remote lookup cached for display, not shared state.
  const [path, setPath] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  // Resolve the stored root id back to a readable path for display.
  useEffect(() => {
    if (!ctx || !source.root) {
      setPath(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getItem(ctx, { itemId: source.root })
      .then((node) => !cancelled && setPath(node?.path))
      .catch(() => !cancelled && setPath(undefined))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ctx, source.root]);

  return (
    <div className="max-w-2xl space-y-4 p-6">
      <p className="text-sm text-muted-foreground">
        Descendants of this item are re-resolved every time the package is generated, so a
        dynamic source picks up items added later.
      </p>

      <div className="space-y-1">
        <span className="text-sm font-medium">Database:</span>{" "}
        <span className="font-mono text-sm">{source.database || "—"}</span>
      </div>

      <div className="space-y-1">
        <span className="text-sm font-medium">Root item:</span>{" "}
        {loading ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Resolving…
          </span>
        ) : (
          <span className="font-mono text-sm">{path ?? source.root ?? "Not set"}</span>
        )}
      </div>

      <Button variant="outline" onClick={() => openDialog({ kind: "root-picker" })}>
        Change search root
      </Button>

      <div className="flex items-center gap-2 pt-2">
        <Checkbox
          id="dyn-skip-versions"
          checked={source.skipVersions}
          onCheckedChange={(c) => onChange({ ...source, skipVersions: c === true })}
        />
        <Label htmlFor="dyn-skip-versions">Latest version only</Label>
      </div>

      {picking && (
        <SelectRootItemDialog
          open
          treeId="search-root"
          initialDatabase={source.database}
          onCancel={closeDialog}
          onConfirm={(node, database) => {
            onChange({ ...source, root: node.id, database });
            closeDialog();
          }}
        />
      )}
    </div>
  );
}
