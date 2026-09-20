"use client";

// features/create — the Create package experience.
//
// Mirrors the legacy Package Designer documented in wiki/articles/package-designer-ui.md:
// a ribbon across the top, a two-page left nav (Metadata / Sources), and a detail pane.
//
// This phase authors and saves the package DEFINITION. Building the .zip and installing it
// come later; the ribbon's Build and Install buttons are present but disabled.
//
// State lives in ./store — the document in `designer`, the Sitecore session and the
// ephemeral UI in `session`. What is left here is layout, the project-file commands that
// need `storage/`, and the one effect that restores the autosaved draft and resumes
// autosaving it.

import { useEffect } from "react";
import { mdiAlertCircleOutline, mdiCheckCircleOutline } from "@mdi/js";
import { Icon } from "@/src/components/ui/icon";
import { Spinner } from "@/src/components/ui/spinner";
import { parseDefinition } from "@/src/core/definition";
import { saveDefinition } from "@/src/storage/definitions";
import { MetadataPanel } from "./MetadataPanel";
import { Ribbon } from "./Ribbon";
import { SourceDetail } from "./SourceDetail";
import { SourceList } from "./SourceList";
import { GeneratePackageDialog } from "./dialogs/GeneratePackageDialog";
import { PackagePreviewDialog } from "./dialogs/PackagePreviewDialog";
import { ProjectDialog } from "./dialogs/ProjectDialog";
import { restoreDraft, startDraftAutosave } from "./store/autosave";
import { designerStore } from "./store/designer";
import { useDefinitionXml, useDesigner, useSelectedSource } from "./store/hooks";
import { useSession, useSessionBootstrap } from "./store/session";

export function PackageDesigner() {
  useSessionBootstrap();

  const hydrated = useDesigner((s) => s.hydrated);
  const projectName = useDesigner((s) => s.projectName);
  const dirty = useDesigner((s) => s.dirty);
  const selection = useDesigner((s) => s.selection);
  const metadataName = useDesigner((s) => s.definition.metadata.name);
  const load = useDesigner((s) => s.load);
  const markSaved = useDesigner((s) => s.markSaved);
  const selectedSource = useSelectedSource();
  // The whole document, for the package-wide preview. This component already re-renders on
  // every edit (it derives the autosave XML), so the extra subscription costs nothing.
  const definition = useDesigner((s) => s.definition);
  const xml = useDefinitionXml();

  const contextId = useSession((s) => s.contextId);
  const contextLoaded = useSession((s) => s.contextLoaded);
  const appContext = useSession((s) => s.appContext);
  const connectionError = useSession((s) => s.connectionError);
  const autosaveError = useSession((s) => s.autosaveError);
  const status = useSession((s) => s.status);
  const setStatus = useSession((s) => s.setStatus);
  const setAutosaveError = useSession((s) => s.setAutosaveError);
  const projectDialog = useSession((s) =>
    s.activeDialog?.kind === "project" ? s.activeDialog.mode : null,
  );
  const openDialog = useSession((s) => s.openDialog);
  const closeDialog = useSession((s) => s.closeDialog);
  const packagePreview = useSession((s) => s.activeDialog?.kind === "package-preview");
  const generating = useSession((s) => s.activeDialog?.kind === "generate");

  // Restore the stored draft, then keep writing it back. The order matters: autosave
  // refuses to run until the store is hydrated, so the empty initial document cannot
  // overwrite the draft we are about to load. Returning the unsubscribe makes React
  // StrictMode's dev double-invoke harmless.
  useEffect(() => {
    restoreDraft(designerStore);
    return startDraftAutosave(designerStore, { onError: setAutosaveError });
  }, [setAutosaveError]);

  // Status messages are incidental confirmations; clear them after a moment.
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(undefined), 4000);
    return () => clearTimeout(timer);
  }, [status, setStatus]);

  // Connected to the host, but with no tenant to talk to — worth calling out up front
  // rather than letting every picker fail on its own.
  const noContext = contextLoaded && !connectionError && !contextId;

  function save(name: string) {
    try {
      saveDefinition(name, xml);
      markSaved(name);
      setStatus('Saved "' + name + '".');
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    closeDialog();
  }

  if (!hydrated) {
    return (
      <div className="flex h-dvh items-center justify-center gap-2 text-muted-foreground">
        <Spinner /> Loading the designer…
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Package Designer</h1>
        <p className="truncate text-sm text-muted-foreground">
          {projectName ?? "Untitled project"}
          {dirty && " — unsaved changes"}
        </p>
      </header>

      <Ribbon
        onOpen={() => openDialog({ kind: "project", mode: "open" })}
        onSave={() =>
          projectName ? save(projectName) : openDialog({ kind: "project", mode: "save" })
        }
        onSaveAs={() => openDialog({ kind: "project", mode: "save" })}
      />

      {(connectionError || noContext || autosaveError || status) && (
        <div className="flex shrink-0 flex-col gap-1 border-b px-4 py-2 text-sm">
          {connectionError && (
            <p className="flex items-center gap-2 text-danger-fg">
              <Icon path={mdiAlertCircleOutline} className="size-4" />
              Not connected to Sitecore — the pickers need the app to run inside the Cloud Portal.
            </p>
          )}
          {noContext && (
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-danger-fg">
                <Icon path={mdiAlertCircleOutline} className="size-4" />
                No Sitecore context id — item, template and account pickers cannot reach your
                tenant. Check that the app registration grants access to an XM Cloud resource.
              </p>
              {/* On-screen so the real payload can be read without opening DevTools: the
                  context id's location is the one thing the SDK types do not pin down. */}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Show what the host returned for application.context
                </summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-neutral-bg p-2">
                  {JSON.stringify(appContext, null, 2)}
                </pre>
              </details>
            </div>
          )}
          {autosaveError && (
            <p className="flex items-center gap-2 text-danger-fg">
              <Icon path={mdiAlertCircleOutline} className="size-4" />
              {autosaveError.message} — your work is not being autosaved.
            </p>
          )}
          {status && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Icon path={mdiCheckCircleOutline} className="size-4" />
              {status}
            </p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <SourceList />

        <main className="min-w-0 flex-1 overflow-auto">
          {selection.kind === "metadata" && <MetadataPanel />}

          {selection.kind === "source" && selectedSource && (
            // Keyed by uid so switching sources resets the panel's own transient state —
            // the entry-row selection in particular used to survive and then act on the
            // wrong source.
            <SourceDetail key={selectedSource.uid} source={selectedSource} />
          )}
        </main>
      </div>

      {projectDialog && (
        <ProjectDialog
          open
          mode={projectDialog}
          initialName={projectName ?? metadataName}
          currentXml={xml}
          onCancel={closeDialog}
          onSaveProject={save}
          onOpenProject={(name, openedXml) => {
            try {
              load(parseDefinition(openedXml), name);
              setStatus('Opened "' + name + '".');
            } catch {
              setStatus("That project file could not be read.");
            }
            closeDialog();
          }}
          onUpload={(name, uploadedXml) => {
            try {
              load(parseDefinition(uploadedXml), null);
              setStatus('Imported "' + name + '". Use Save as to keep it.');
            } catch {
              setStatus("That file is not a package definition.");
            }
            closeDialog();
          }}
        />
      )}

      {packagePreview && (
        <PackagePreviewDialog open definition={definition} onClose={closeDialog} />
      )}

      {generating && (
        <GeneratePackageDialog open definition={definition} onClose={closeDialog} />
      )}
    </div>
  );
}
