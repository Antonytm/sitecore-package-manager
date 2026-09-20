"use client";

// Legacy Screens 2-5 collapse to one: SitecoreAI has no server packages folder to browse, so
// "Choose package" has nothing to choose from and only the upload path remains.
//
// The hidden-input pattern is the one ProjectDialog already uses; the difference is that a
// package is binary, so this reads an ArrayBuffer rather than text.

import { useRef } from "react";
import { mdiUpload } from "@mdi/js";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Alert } from "@/src/components/ui/alert";
import { useWizard } from "../store/hooks";
import { wizardStore } from "../store/wizard";
import { readPackageFile } from "../lib/readfile";
import { packageTitle } from "../lib/describe";

export function SelectPackageStep() {
  const input = useRef<HTMLInputElement>(null);
  const fileName = useWizard((s) => s.fileName);
  const fileError = useWizard((s) => s.fileError);
  const pkg = useWizard((s) => s.pkg);
  const busy = useWizard((s) => s.busy);

  async function choose(file: File) {
    const actions = wizardStore.getState();
    actions.setBusy("Reading " + file.name + "…");
    const outcome = await readPackageFile(file);
    actions.setBusy(undefined);
    if (outcome.pkg) actions.loadPackage(file.name, outcome.pkg);
    else actions.failPackage(file.name, outcome.error ?? "Unknown error");
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Name:</span>
        <span className="min-w-48 rounded border px-3 py-1.5 text-sm">
          {fileName ?? <span className="text-muted-foreground">No package chosen</span>}
        </span>
        <Button variant="outline" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
          <Icon path={mdiUpload} size="sm" /> Upload package
        </Button>
        <input
          ref={input}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset so choosing the same file twice still fires a change event.
            e.target.value = "";
            if (file) void choose(file);
          }}
        />
      </div>

      {fileError && <Alert variant="danger">{fileError}</Alert>}

      {pkg && (
        <p className="text-sm text-muted-foreground">
          {packageTitle(pkg)} — {pkg.items.length} item{pkg.items.length === 1 ? "" : "s"}
          {pkg.sources.length > 0 ? ", " + pkg.sources.length + " source(s)" : ""}
        </p>
      )}
    </div>
  );
}
