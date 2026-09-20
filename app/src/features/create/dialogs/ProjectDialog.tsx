"use client";

// Project / Save project — the project-file browser (legacy Screen 11).
//
// The legacy dialogs shared one chrome over the server's Data/packages folder: a toolbar
// (Refresh, Upload, Download, Delete), a list of project files, and a File name field.
// There is no server folder on SitecoreAI, so the list is backed by browser storage, and
// Upload / Download become import and export of the same definition XML.

import { useCallback, useEffect, useRef, useState } from "react";
import { mdiDelete, mdiDownload, mdiRefresh, mdiUpload } from "@mdi/js";
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
import { Input } from "@/src/components/ui/input";
import { Icon } from "@/src/components/ui/icon";
import { deleteDefinition, listDefinitions, readDefinition } from "@/src/storage/definitions";
import type { StoredDefinition } from "@/src/storage/definitions";

export type ProjectDialogMode = "open" | "save";

interface Props {
  open: boolean;
  mode: ProjectDialogMode;
  /** Pre-fills the File name field when saving. */
  initialName?: string;
  onCancel: () => void;
  /** Open: the chosen project's XML. Save: just the name to save under. */
  onOpenProject?: (name: string, xml: string) => void;
  onSaveProject?: (name: string) => void;
  /** Import a definition file from disk (the legacy Upload button). */
  onUpload?: (name: string, xml: string) => void;
  /** The current definition, so Download can export it when nothing is selected. */
  currentXml?: string;
}

export function ProjectDialog({
  open,
  mode,
  initialName = "",
  onCancel,
  onOpenProject,
  onSaveProject,
  onUpload,
  currentXml,
}: Props) {
  const [projects, setProjects] = useState<StoredDefinition[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileName, setFileName] = useState(initialName);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => setProjects(listDefinitions()), []);

  useEffect(() => {
    if (open) {
      refresh();
      setFileName(initialName);
      setSelected(null);
    }
  }, [open, initialName, refresh]);

  function choose(name: string) {
    setSelected(name);
    setFileName(name);
  }

  function download() {
    const xml = selected ? readDefinition(selected) : currentXml;
    const name = selected ?? fileName ?? "package-definition";
    if (!xml) return;
    // The designer's downloaded project file ends with a trailing newline.
    const blob = new Blob([xml + "\r\n"], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name.endsWith(".xml") ? name : name + ".xml";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function upload(file: File) {
    const text = await file.text();
    onUpload?.(file.name.replace(/\.xml$/i, ""), text);
  }

  const canConfirm = mode === "open" ? selected !== null : fileName.trim() !== "";

  function confirm() {
    if (mode === "open") {
      if (!selected) return;
      const xml = readDefinition(selected);
      if (xml) onOpenProject?.(selected, xml);
      return;
    }
    onSaveProject?.(fileName.trim());
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "open" ? "Project" : "Save project"}</DialogTitle>
          <DialogDescription>
            {mode === "open"
              ? "Select a project to open."
              : "Enter a name for the project file."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex shrink-0 items-center gap-1 rounded-md border bg-neutral-bg p-1">
            <Button variant="ghost" size="sm" onClick={refresh}>
              <Icon path={mdiRefresh} /> Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>
              <Icon path={mdiUpload} /> Upload
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!selected && !currentXml}
              onClick={download}
            >
              <Icon path={mdiDownload} /> Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                deleteDefinition(selected);
                setSelected(null);
                refresh();
              }}
            >
              <Icon path={mdiDelete} className="text-danger-fg" /> Delete
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".xml,application/xml,text/xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = "";
              }}
            />
          </div>

          <ul className="min-h-40 flex-1 overflow-auto rounded-md border p-1 text-sm">
            {projects.length === 0 && (
              <li className="p-3 text-muted-foreground">
                No saved projects yet. Save one, or upload a definition file.
              </li>
            )}
            {projects.map((project) => (
              <li key={project.name}>
                <button
                  type="button"
                  onClick={() => choose(project.name)}
                  onDoubleClick={() => mode === "open" && choose(project.name)}
                  className={
                    "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-neutral-bg " +
                    (selected === project.name ? "bg-primary-bg font-medium" : "")
                  }
                >
                  <span className="truncate">{project.name}</span>
                  {project.savedAt && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(project.savedAt).toLocaleString()}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <div className="flex shrink-0 items-center gap-3">
            <label htmlFor="project-name" className="shrink-0 text-sm font-medium">
              File name:
            </label>
            <Input
              id="project-name"
              value={fileName}
              readOnly={mode === "open"}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) {
                  e.preventDefault();
                  confirm();
                }
              }}
            />
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!canConfirm} onClick={confirm}>
            {mode === "open" ? "Open" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
