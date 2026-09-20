"use client";

// ENTRIES — the explicit list a static source contributes (legacy Screen 10).
//
// The SOURCE ribbon's Entries group acts on this tab: Add items, Remove, Remove obsolete
// and Sort. Remove obsolete needs to check each entry against the live tree, so it lives
// here where the XMC context is available.

import { useState } from "react";
import { mdiClose } from "@mdi/js";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Spinner } from "@/src/components/ui/spinner";
import { Checkbox } from "@/src/components/ui/checkbox";
import { Label } from "@/src/components/ui/label";
import { formatAccountRef, formatItemRef } from "@/src/core/definition";
import type { AccountSource, StaticFileSource, StaticItemSource } from "@/src/core/model";
import { getItem } from "@/src/xmc/browse";
import { useSession } from "../store/session";

type StaticSource = StaticItemSource | StaticFileSource | AccountSource;

interface Props {
  source: StaticSource;
  onChange: (source: StaticSource) => void;
  onAddItems: () => void;
}

/** One display row per entry, whatever the source kind stores underneath. */
function rowsFor(source: StaticSource): Array<{ key: string; text: string }> {
  switch (source.kind) {
    case "items-static":
      return source.entries.map((e) => ({ key: e.id, text: formatItemRef(e) }));
    case "files-static":
      return source.entries.map((e) => ({ key: e, text: e }));
    case "accounts":
      return source.entries.map((e) => ({ key: formatAccountRef(e), text: formatAccountRef(e) }));
  }
}

export function EntriesTab({ source, onChange, onAddItems }: Props) {
  const ctx = useSession((s) => s.ctx);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const rows = rowsFor(source);

  function removeKeys(keys: Set<string>) {
    if (keys.size === 0) return;
    switch (source.kind) {
      case "items-static":
        onChange({ ...source, entries: source.entries.filter((e) => !keys.has(e.id)) });
        break;
      case "files-static":
        onChange({ ...source, entries: source.entries.filter((e) => !keys.has(e)) });
        break;
      case "accounts":
        onChange({
          ...source,
          entries: source.entries.filter((e) => !keys.has(formatAccountRef(e))),
        });
        break;
    }
    setSelected(new Set());
  }

  function sort() {
    switch (source.kind) {
      case "items-static":
        onChange({
          ...source,
          entries: [...source.entries].sort((a, b) =>
            formatItemRef(a).localeCompare(formatItemRef(b)),
          ),
        });
        break;
      case "files-static":
        onChange({ ...source, entries: [...source.entries].sort((a, b) => a.localeCompare(b)) });
        break;
      case "accounts":
        onChange({
          ...source,
          entries: [...source.entries].sort((a, b) =>
            formatAccountRef(a).localeCompare(formatAccountRef(b)),
          ),
        });
        break;
    }
  }

  /** Drop entries whose item no longer exists. Only meaningful for item sources. */
  async function removeObsolete() {
    if (source.kind !== "items-static" || !ctx) return;
    setChecking(true);
    setNote(undefined);
    try {
      const keep: typeof source.entries = [];
      let dropped = 0;
      for (const entry of source.entries) {
        const found = await getItem(ctx, { itemId: entry.id });
        if (found) keep.push(entry);
        else dropped += 1;
      }
      onChange({ ...source, entries: keep });
      setNote(dropped === 0 ? "No obsolete entries." : "Removed " + dropped + " obsolete entries.");
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onAddItems}>
          Add items
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={selected.size === 0}
          onClick={() => removeKeys(selected)}
        >
          Remove
        </Button>
        {source.kind === "items-static" && (
          <Button variant="outline" size="sm" disabled={checking} onClick={removeObsolete}>
            {checking && <Spinner className="size-4" />} Remove obsolete
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={sort}>
          Sort
        </Button>
        {source.kind === "items-static" && (
          <div className="ml-auto flex items-center gap-2">
            <Checkbox
              id="skip-versions"
              checked={source.skipVersions}
              onCheckedChange={(c) => onChange({ ...source, skipVersions: c === true })}
            />
            <Label htmlFor="skip-versions">Latest version only</Label>
          </div>
        )}
      </div>

      {note && <p className="text-sm text-muted-foreground">{note}</p>}

      <div className="rounded-md border">
        <div className="flex items-center justify-between border-b bg-neutral-bg px-3 py-2 text-sm font-medium">
          <span>{rows.length} entries</span>
          {selected.size > 0 && <span>{selected.size} selected</span>}
        </div>
        <ul className="max-h-[26rem] overflow-auto p-1 text-xs">
          {rows.length === 0 && (
            <li className="p-3 text-muted-foreground">
              This source is empty. Use Add items to pick what it should contribute.
            </li>
          )}
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-neutral-bg">
              <Checkbox
                checked={selected.has(row.key)}
                aria-label={"Select " + row.text}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked === true) next.add(row.key);
                    else next.delete(row.key);
                    return next;
                  })
                }
              />
              <span className="flex-1 truncate font-mono">{row.text}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={"Remove " + row.text}
                onClick={() => removeKeys(new Set([row.key]))}
              >
                <Icon path={mdiClose} className="text-danger-fg" />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
