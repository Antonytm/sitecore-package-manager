"use client";

// Build → Preview — the whole package, before generating it.
//
// The per-source PREVIEW tab answers "what does THIS source contribute". This answers the
// question that actually matters before shipping: what ends up in the zip. That is not the
// sum of the sources, because the generator's `Uniq` sink collapses entries by key — the
// same item listed by two sources is packaged once. Showing the sum would overstate the
// package and hide the overlap, so the duplicate count is part of the answer here.
//
// One source failing does not fail the preview. "Your third source has a bad root" is far
// more useful than one red line with nothing behind it, so each source carries its own
// error and the rest still resolve.

import { useEffect, useRef, useState } from "react";
import { mdiAlertOutline, mdiPlayOutline, mdiRefresh, mdiStopCircleOutline } from "@mdi/js";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Button } from "@/src/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/dialog";
import { Icon } from "@/src/components/ui/icon";
import { Spinner } from "@/src/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/src/components/ui/table";
import { FILTER_LABELS } from "@/src/core/filters";
import type { PackageDefinition } from "@/src/core/model";
import { resolveDefinition } from "@/src/xmc/resolve";
import type { PackagePreview } from "@/src/xmc/resolve";
import { SOURCE_LABELS, UNNAMED, behaviourLabel, isReadOnlyKind, sourceLabel } from "../sources";
import { useSession } from "../store/session";

interface Props {
  open: boolean;
  definition: PackageDefinition;
  onClose: () => void;
}

/** Everything a run could not fully answer, gathered into one line per reason. */
function caveats(preview: PackagePreview): string[] {
  const lines: string[] = [];

  const unapplied = new Set(preview.sources.flatMap((s) => s.unevaluated));
  if (unapplied.size > 0) {
    lines.push(
      "Could not apply the " +
        [...unapplied].map((k) => FILTER_LABELS[k]).join(", ") +
        " filter" + (unapplied.size === 1 ? "" : "s") +
        " — this environment's Authoring API did not return the information they test, so " +
        "the list is wider than the package will be.",
    );
  }

  const kept = preview.sources.filter((s) => isReadOnlyKind(s.kind) && s.contributed > 0);
  if (kept.length > 0) {
    lines.push(
      "File and security-account entries are listed because they are part of the " +
        "definition and are saved back unchanged, but SitecoreAI cannot install them.",
    );
  }

  return lines;
}

export function PackagePreviewDialog({ open, definition, onClose }: Props) {
  const ctx = useSession((s) => s.ctx);

  const [preview, setPreview] = useState<PackagePreview | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  const run = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => run.current?.abort(), []);

  async function resolve() {
    if (!ctx) return;
    setError(undefined);
    setNote(undefined);
    const controller = new AbortController();
    run.current = controller;
    setBusy("Resolving sources…");
    try {
      setPreview(
        await resolveDefinition(ctx, definition, {
          signal: controller.signal,
          onProgress: (scanned) => setBusy("Scanned " + scanned + " items…"),
        }),
      );
    } catch (e: unknown) {
      if (controller.signal.aborted) setNote("Stopped. Nothing was resolved.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      run.current = undefined;
      setBusy(undefined);
    }
  }

  const nameOf = new Map(definition.sources.map((s) => [s.uid, sourceLabel(s)]));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Package contents</DialogTitle>
          <DialogDescription>
            Every source resolved against live content, with duplicate entries removed the
            way generating the package removes them.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" disabled={!!busy || !ctx} onClick={resolve}>
              <Icon path={preview ? mdiRefresh : mdiPlayOutline} />
              {preview ? "Re-run" : "Run preview"}
            </Button>

            {busy && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" /> {busy}
                {/* "Stop", not "Cancel" — the footer's Close is right below and would
                    dismiss the whole dialog. */}
                <Button variant="ghost" size="sm" onClick={() => run.current?.abort()}>
                  <Icon path={mdiStopCircleOutline} /> Stop
                </Button>
              </span>
            )}

            {!preview && !busy && (
              <span className="text-sm text-muted-foreground">
                {definition.sources.length === 0
                  ? "This package has no sources yet."
                  : "Resolving walks the content tree, so it runs only when you ask."}
              </span>
            )}
          </div>

          {error && <p className="shrink-0 text-sm text-danger-fg">{error}</p>}
          {note && <p className="shrink-0 text-sm text-muted-foreground">{note}</p>}

          {preview && (
            <>
              {caveats(preview).map((line) => (
                <Alert key={line} variant="warning" className="shrink-0">
                  <AlertDescription>{line}</AlertDescription>
                </Alert>
              ))}

              <p className="shrink-0 text-sm text-muted-foreground">
                <strong>{preview.entries.length}</strong>{" "}
                {preview.entries.length === 1 ? "entry" : "entries"} from{" "}
                {preview.sources.length}{" "}
                {preview.sources.length === 1 ? "source" : "sources"}
                {preview.duplicates > 0
                  ? " — " + preview.duplicates + " duplicate" +
                    (preview.duplicates === 1 ? "" : "s") + " removed"
                  : ""}
                .
              </p>

              <div className="shrink-0 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead className="w-40">Kind</TableHead>
                      <TableHead className="w-28">Entries</TableHead>
                      <TableHead className="w-48">Installation options</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.sources.map((s) => (
                      <TableRow key={s.uid}>
                        <TableCell>
                          {nameOf.get(s.uid) ?? UNNAMED}
                          {s.error && (
                            <span className="flex items-center gap-1 text-xs text-danger-fg">
                              <Icon path={mdiAlertOutline} className="size-3.5 shrink-0" />
                              {s.error}
                            </span>
                          )}
                          {s.note && (
                            <span className="block text-xs text-muted-foreground">{s.note}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{SOURCE_LABELS[s.kind]}</TableCell>
                        <TableCell className="text-xs">
                          {s.contributed}
                          {s.resolved !== s.contributed && (
                            <span className="text-muted-foreground">
                              {" "}
                              (of {s.resolved})
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{behaviourLabel(s.behaviour)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="min-h-40 flex-1 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Entry key</TableHead>
                      <TableHead className="w-48">Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.entries.map((entry) => (
                      <TableRow key={entry.key}>
                        <TableCell className="font-mono text-xs">{entry.key}</TableCell>
                        <TableCell className="text-xs">
                          {nameOf.get(entry.sourceUid) ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                    {preview.entries.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={2} className="text-muted-foreground">
                          Nothing resolved. The package would be empty.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
