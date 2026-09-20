"use client";

// Select Root Item — the dynamic item source's first step (legacy Screen 5a).
//
// "Select the database and the item where you want to start the search."
//
// Single-select, unlike the static picker: a dynamic source stores exactly one root and
// re-walks its descendants at generation time.

import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { listDatabases } from "@/src/xmc/browse";
import type { ItemNode } from "@/src/xmc/browse";
import { ItemTree } from "../ItemTree";

interface Props {
  open: boolean;
  /** Scopes tree expansion in the session store; each caller passes its own. */
  treeId: string;
  title?: string;
  /** Where the tree starts — `/sitecore/templates` when picking templates. */
  rootPath?: string;
  initialDatabase?: string;
  /** Hide the database dropdown for pickers that are not database-scoped. */
  showDatabase?: boolean;
  onCancel: () => void;
  onConfirm: (node: ItemNode, database: string) => void;
}

export function SelectRootItemDialog({
  open,
  treeId,
  title = "Select Root Item",
  rootPath,
  initialDatabase = "master",
  showDatabase = true,
  onCancel,
  onConfirm,
}: Props) {
  const [database, setDatabase] = useState(initialDatabase);
  const [selected, setSelected] = useState<ItemNode | undefined>();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Select the database and the item where you want to start the search.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {showDatabase && (
            <div className="flex shrink-0 items-center gap-3">
              <label htmlFor="root-db" className="text-sm font-medium">
                Database:
              </label>
              <Select value={database} onValueChange={setDatabase}>
                <SelectTrigger id="root-db" className="w-60">
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
          )}

          <div className="min-h-40 flex-1 overflow-auto rounded-md border">
            <ItemTree
              treeId={treeId}
              rootPath={rootPath}
              selectedId={selected?.id}
              onSelect={setSelected}
            />
          </div>

          <p className="shrink-0 text-xs text-muted-foreground">
            {selected ? selected.path : "No item selected."}
          </p>
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!selected} onClick={() => selected && onConfirm(selected, database)}>
            Next
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
