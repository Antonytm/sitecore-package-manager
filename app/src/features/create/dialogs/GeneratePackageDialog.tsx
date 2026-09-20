"use client";

// Generate ZIP — the last step of the Create flow, and the only one that produces a file.
//
// Two steps, matching the legacy designer (wiki/articles/package-designer-ui.md:365-387):
// name the package, then build it and take the download. The legacy tool wrote to the
// server's Data/packages and offered a download from there; SitecoreAI has no such folder,
// so the zip is built in the browser and handed straight to you.
//
// The build can refuse. Where Preview degrades and reports — a filter it could not evaluate
// only makes the list wider — a package missing field identities or standard-values
// information would install perfectly and be WRONG, and be discovered weeks later. So a
// refusal here names exactly what the Authoring API would not supply, and builds nothing.

import { useEffect, useRef, useState } from "react";
import {
  mdiAlertOutline,
  mdiDownloadOutline,
  mdiPackageVariantClosed,
  mdiStopCircleOutline,
} from "@mdi/js";
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
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Spinner } from "@/src/components/ui/spinner";
import type { PackageDefinition } from "@/src/core/model";
import { writePackage } from "@/src/core/package";
import { ExportBlocked, exportDefinition } from "@/src/xmc/export";
import { downloadBytes, packageFileName } from "../lib/download";
import {
  defaultPackageName,
  generationCaveats,
  generationSummary,
  toPackageModel,
} from "../lib/generate";
import { useSession } from "../store/session";

interface Props {
  open: boolean;
  definition: PackageDefinition;
  onClose: () => void;
}

interface Built {
  bytes: Uint8Array;
  summary: string;
  caveats: string[];
}

export function GeneratePackageDialog({ open, definition, onClose }: Props) {
  const ctx = useSession((s) => s.ctx);

  const [name, setName] = useState(() => defaultPackageName(definition));
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [built, setBuilt] = useState<Built | undefined>();
  // What the schema DOES offer, shown under a refusal so it is actionable rather than a
  // dead end — this is the listing that says which names to ask for instead.
  const [schema, setSchema] = useState<string[] | undefined>();

  const run = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => run.current?.abort(), []);

  async function generate() {
    if (!ctx) return;
    setError(undefined);
    setNote(undefined);
    setBuilt(undefined);
    setSchema(undefined);
    const controller = new AbortController();
    run.current = controller;
    setBusy("Resolving sources…");
    try {
      const exported = await exportDefinition(ctx, definition, {
        signal: controller.signal,
        onProgress: (done, total) =>
          setBusy(total > 0 ? "Read " + done + " of " + total + " items…" : "Resolving sources…"),
      });
      controller.signal.throwIfAborted();

      setBusy("Building the zip…");
      const bytes = await writePackage(toPackageModel(definition, exported.items));

      setBuilt({
        bytes,
        summary: generationSummary(exported),
        caveats: generationCaveats(exported, definition),
      });
    } catch (e: unknown) {
      if (controller.signal.aborted) setNote("Stopped. Nothing was built.");
      else if (e instanceof ExportBlocked) {
        setError(e.message);
        setSchema(e.report.schemaNotes);
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      run.current = undefined;
      setBusy(undefined);
    }
  }

  function save() {
    if (!built) return;
    const result = downloadBytes(built.bytes, packageFileName(name), "application/zip");
    if (!result.ok) setError(result.reason);
    else setNote("Saved " + packageFileName(name) + ".");
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Generate ZIP</DialogTitle>
          <DialogDescription>
            Every source is resolved against live content and written into a classic
            two-layer package, ready to install.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="max-w-md space-y-2">
            <Label htmlFor="package-name">Package name:</Label>
            <Input
              id="package-name"
              value={name}
              disabled={!!busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" disabled={!!busy || !ctx} onClick={generate}>
              <Icon path={mdiPackageVariantClosed} />
              {built ? "Rebuild" : "Build package"}
            </Button>

            {busy && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" /> {busy}
                {/* "Stop", not "Cancel" — the footer's Close would dismiss the dialog. */}
                <Button variant="ghost" size="sm" onClick={() => run.current?.abort()}>
                  <Icon path={mdiStopCircleOutline} /> Stop
                </Button>
              </span>
            )}

            {!busy && !built && (
              <span className="text-sm text-muted-foreground">
                Building reads every field of every item, so it runs only when you ask.
              </span>
            )}
          </div>

          {error && (
            <Alert variant="danger" className="shrink-0">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {schema && (
            <div className="shrink-0 space-y-1 rounded-md border p-3">
              <p className="text-xs font-medium">What this environment&rsquo;s schema offers</p>
              {schema.map((line) => (
                <p key={line} className="break-words font-mono text-[11px] text-muted-foreground">
                  {line}
                </p>
              ))}
              <p className="text-xs text-muted-foreground">
                Send this listing along and the selections can be corrected to match.
              </p>
            </div>
          )}

          {note && <p className="shrink-0 text-sm text-muted-foreground">{note}</p>}

          {built && (
            <>
              <p className="shrink-0 text-sm text-muted-foreground">{built.summary}</p>

              {built.caveats.map((line) => (
                <Alert key={line} variant="warning" className="shrink-0">
                  <AlertDescription>{line}</AlertDescription>
                </Alert>
              ))}

              <p className="flex shrink-0 items-start gap-2 text-xs text-muted-foreground">
                <Icon path={mdiAlertOutline} className="mt-0.5 size-3.5 shrink-0" />
                A dynamic source is resolved again at this moment, so the package is a
                snapshot of the content as it is now.
              </p>
            </>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={!built} onClick={save}>
            <Icon path={mdiDownloadOutline} /> Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
