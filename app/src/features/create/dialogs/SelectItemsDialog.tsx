"use client";

// Select Items — the static item picker (legacy Screen 4).
//
// "Select the database and the items and subtrees that you want to include."
//
// The static trait that matters: **Add with Subitems walks the subtree now**, at design
// time, and stores one explicit entry per descendant. That is what makes a static source
// a snapshot that will not pick up items created later.

import { useEffect, useRef, useState } from "react";
import { mdiClose, mdiFileOutline, mdiFileTreeOutline, mdiStopCircleOutline } from "@mdi/js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/dialog";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Spinner } from "@/src/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { formatItemRef } from "@/src/core/definition";
import type { ItemRef } from "@/src/core/model";
import { enumerateSubtree, listDatabases, toItemRef } from "@/src/xmc/browse";
import type { ItemNode } from "@/src/xmc/browse";
import { ItemTree } from "../ItemTree";
import { useSession } from "../store/session";

interface Props {
  open: boolean;
  /** Entries already on the source, so re-opening the dialog keeps them. */
  initialEntries?: ItemRef[];
  initialDatabase?: string;
  onCancel: () => void;
  onConfirm: (entries: ItemRef[], database: string) => void;
}

export function SelectItemsDialog({
  open,
  initialEntries = [],
  initialDatabase = "master",
  onCancel,
  onConfirm,
}: Props) {
  const ctx = useSession((s) => s.ctx);
  const [database, setDatabase] = useState(initialDatabase);
  const [selected, setSelected] = useState<ItemNode | undefined>();
  const [entries, setEntries] = useState<ItemRef[]>(initialEntries);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  // Held in a ref rather than state: aborting must not wait for a re-render, and the
  // unmount cleanup below has to reach the controller of a walk still in flight.
  const walk = useRef<AbortController | undefined>(undefined);

  // Closing the dialog mid-walk stops it. Without this the loop would keep issuing
  // requests against a component nobody can see any more.
  useEffect(() => () => walk.current?.abort(), []);

  /** Add refs, skipping any whose id is already present (the generator de-dupes too). */
  function addRefs(refs: ItemRef[]) {
    setEntries((current) => {
      const seen = new Set(current.map((e) => e.id));
      return [...current, ...refs.filter((r) => !seen.has(r.id))];
    });
  }

  function addItem() {
    if (selected) addRefs([toItemRef(selected, database)]);
  }

  async function addWithSubitems() {
    if (!selected || !ctx) return;
    setError(undefined);
    setNote(undefined);
    const controller = new AbortController();
    walk.current = controller;
    setBusy("Expanding subtree…");
    try {
      const nodes = await enumerateSubtree(ctx, { itemId: selected.id }, {
        signal: controller.signal,
        onProgress: (count) => setBusy("Expanding subtree — " + count + " items…"),
      });
      addRefs(nodes.map((n) => toItemRef(n, database)));
    } catch (e: unknown) {
      // A walk the user stopped is not a failure, and the partial result is discarded —
      // so say plainly that nothing was added rather than showing an error.
      if (controller.signal.aborted) setNote("Expansion stopped. Nothing was added.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      walk.current = undefined;
      setBusy(undefined);
    }
  }

  function removeEntry(id: string) {
    setEntries((current) => current.filter((e) => e.id !== id));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Select Items</DialogTitle>
          <DialogDescription>
            Select the database and the items and subtrees that you want to include.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex shrink-0 items-center gap-3">
            <label htmlFor="db" className="text-sm font-medium">
              Database:
            </label>
            <Select value={database} onValueChange={setDatabase}>
              <SelectTrigger id="db" className="w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {listDatabases().map((db) => (
                  <SelectItem key={db} value={db}>
                    {db}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-h-40 flex-1 overflow-auto rounded-md border">
            <ItemTree treeId="select-items" selectedId={selected?.id} onSelect={setSelected} />
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={!selected || !!busy} onClick={addWithSubitems}>
              <Icon path={mdiFileTreeOutline} /> Add with Subitems
            </Button>
            <Button variant="outline" size="sm" disabled={!selected || !!busy} onClick={addItem}>
              <Icon path={mdiFileOutline} /> Add Item
            </Button>
            {busy && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" /> {busy}
                {/* "Stop", not "Cancel" — the dialog's own Cancel button is right below
                    it and closes the whole dialog. */}
                <Button variant="ghost" size="sm" onClick={() => walk.current?.abort()}>
                  <Icon path={mdiStopCircleOutline} /> Stop
                </Button>
              </span>
            )}
          </div>

          {error && <p className="shrink-0 text-sm text-danger-fg">{error}</p>}
          {note && <p className="shrink-0 text-sm text-muted-foreground">{note}</p>}

          <div className="shrink-0 rounded-md border">
            <div className="border-b bg-neutral-bg px-3 py-2 text-sm font-medium">
              Selected items: {entries.length}
            </div>
            <ul className="max-h-40 overflow-auto p-1 text-xs">
              {entries.length === 0 && (
                <li className="p-2 text-muted-foreground">
                  Nothing selected yet. Pick an item in the tree, then Add Item or Add with Subitems.
                </li>
              )}
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-neutral-bg"
                >
                  <span className="truncate font-mono">{formatItemRef(entry)}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={"Remove " + entry.id}
                    onClick={() => removeEntry(entry.id)}
                  >
                    <Icon path={mdiClose} className="text-danger-fg" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!!busy} onClick={() => onConfirm(entries, database)}>
            Next
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
