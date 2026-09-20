"use client";

// The left nav (legacy Screen 2): exactly two pages, Metadata and Sources, with each
// added source listed beneath Sources and iconed by kind.

import { mdiCogOutline, mdiPlusBoxMultipleOutline } from "@mdi/js";
import { Icon } from "@/src/components/ui/icon";
import { cn } from "@/src/lib/utils";
import { SOURCE_ICONS, SOURCE_LABELS, entryCount, sourceLabel } from "./sources";
import { useDesigner } from "./store/hooks";

export function SourceList() {
  // Both selectors return values straight off the store, so they are Object.is-stable and
  // need no useShallow.
  const sources = useDesigner((s) => s.definition.sources);
  const selection = useDesigner((s) => s.selection);
  const onSelect = useDesigner((s) => s.select);
  return (
    <nav className="h-full w-64 shrink-0 overflow-auto border-r bg-backgrounds p-2 text-sm">
      <button
        type="button"
        onClick={() => onSelect({ kind: "metadata" })}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-bg",
          selection.kind === "metadata" && "bg-primary-bg font-semibold",
        )}
      >
        <Icon path={mdiCogOutline} className="size-4" />
        Metadata
      </button>

      <div className="mt-2 flex items-center gap-2 px-2 py-1.5 font-semibold">
        <Icon path={mdiPlusBoxMultipleOutline} className="size-4" />
        Sources
      </div>

      <ul className="space-y-0.5">
        {sources.length === 0 && (
          <li className="px-2 py-1.5 pl-8 text-xs text-muted-foreground">
            No sources yet. Use the Add group above.
          </li>
        )}
        {sources.map((source) => {
          const active = selection.kind === "source" && selection.uid === source.uid;
          const count = entryCount(source);
          return (
            <li key={source.uid}>
              <button
                type="button"
                onClick={() => onSelect({ kind: "source", uid: source.uid })}
                title={SOURCE_LABELS[source.kind]}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-left hover:bg-neutral-bg",
                  active && "bg-primary-bg font-medium",
                )}
              >
                <Icon path={SOURCE_ICONS[source.kind]} className="size-4 shrink-0" />
                <span className="flex-1 truncate">{sourceLabel(source)}</span>
                {count !== undefined && (
                  <span className="shrink-0 text-xs text-muted-foreground">{count}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
