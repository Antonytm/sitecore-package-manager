"use client";

// The ribbon (legacy Screen 2). Groups and labels are kept verbatim:
//
//   Project | New · Open · Save · Save as
//   Add     | Items dynamically · Items statically
//   Build   | Generate ZIP · Preview
//   Install | Launch wizard
//
// Build and Install belong to later phases; their buttons are rendered disabled with a
// tooltip saying so, rather than hidden, so the toolbar stays recognisable.
//
// The file and security-account kinds are absent from Add on purpose — see ADD_ORDER in
// sources.ts.
//
// LAYOUT: the original is a two-tier Office-style ribbon, and that is what makes it fit on
// one line. Commands are large (icon above label) by default, but a group can stack two
// SMALL commands in a single column — the real designer does this with Save/Save as and
// with Items statically/Files statically. Laying every command out as one flat horizontal
// row instead is what forced a horizontal scrollbar, which cost a row of vertical space
// and hid half the commands.

import {
  mdiContentSave,
  mdiContentSaveEdit,
  mdiFilePlusOutline,
  mdiFolderOpenOutline,
  mdiPackageVariantClosed,
  mdiRocketLaunchOutline,
  mdiTrashCanOutline,
  mdiZipBoxOutline,
} from "@mdi/js";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Separator } from "@/src/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/src/components/ui/tooltip";
import {
  ADD_ORDER,
  SOURCE_ICONS,
  SOURCE_LABELS,
  createSource,
  isDynamic,
  isReadOnlyKind,
} from "./sources";
import { EnvironmentBar } from "@/src/features/shared/EnvironmentBar";
import { useDesigner, useSelectedSource } from "./store/hooks";
import { useSession } from "./store/session";

interface Props {
  /** Project commands that need the shell's storage wiring; the rest act on the store. */
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
}

/** A ribbon group: its commands in a row, its name centred underneath. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col justify-between px-2">
      <div className="flex items-start justify-center gap-0.5">{children}</div>
      <span className="pt-1 text-center text-[11px] leading-none text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

interface CommandProps {
  icon: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Tints the icon, for a destructive command like Remove source. */
  iconClassName?: string;
}

/** A primary command: icon above label, as the legacy ribbon renders most buttons. */
function Large({ icon, label, onClick, disabled, iconClassName }: CommandProps) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="h-auto min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-xs font-normal"
    >
      <Icon path={icon} className={iconClassName} />
      <span className="leading-none">{label}</span>
    </Button>
  );
}

/**
 * A secondary command, icon beside label. Two of these stack in one column, which is how
 * the original keeps long command names from widening a group.
 */
function Small({ icon, label, onClick, disabled }: CommandProps) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      // The button's base style forces every descendant svg to 1.375rem; `!` is the only
      // way to get a genuinely small icon here.
      className="h-auto min-w-0 justify-start gap-1.5 rounded-md px-2 py-1 text-xs font-normal [&_svg]:!size-4"
    >
      <Icon path={icon} />
      <span className="leading-none">{label}</span>
    </Button>
  );
}

/** The column that holds a pair of {@link Small} commands. */
function Stack({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-0.5">{children}</div>;
}

/** A ribbon command that is deliberately inert until a later phase ships it. */
function ComingSoon({ icon, label }: { icon: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span wrapper: a disabled button does not emit the events the tooltip needs */}
        <span tabIndex={0}>
          <Large icon={icon} label={label} disabled />
        </span>
      </TooltipTrigger>
      <TooltipContent>Building and installing packages comes in a later phase.</TooltipContent>
    </Tooltip>
  );
}

export function Ribbon({ onOpen, onSave, onSaveAs }: Props) {
  const router = useRouter();
  const reset = useDesigner((s) => s.reset);
  const addSource = useDesigner((s) => s.addSource);
  const removeSource = useDesigner((s) => s.removeSource);
  const dirty = useDesigner((s) => s.dirty);
  const projectName = useDesigner((s) => s.projectName);
  const setStatus = useSession((s) => s.setStatus);
  const openDialog = useSession((s) => s.openDialog);
  const sourceCount = useDesigner((s) => s.definition.sources.length);
  const selectedSource = useSelectedSource();
  const canSave = dirty || projectName === null;

  return (
    <TooltipProvider>
      {/* overflow-x-auto is a safety net for a very narrow window; at normal widths the
          two-tier layout fits without it. */}
      <div className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b bg-backgrounds px-2 py-1">
        <Group label="Project">
          <Large
            icon={mdiFilePlusOutline}
            label="New"
            onClick={() => {
              reset();
              setStatus("Started a new project.");
            }}
          />
          <Large icon={mdiFolderOpenOutline} label="Open" onClick={onOpen} />
          <Stack>
            <Small icon={mdiContentSave} label="Save" onClick={onSave} disabled={!canSave} />
            <Small icon={mdiContentSaveEdit} label="Save as" onClick={onSaveAs} />
          </Stack>
        </Group>

        <Separator orientation="vertical" className="h-auto" />

        <Group label="Add">
          {ADD_ORDER.map((kind) => (
            <Large
              key={kind}
              icon={SOURCE_ICONS[kind]}
              label={SOURCE_LABELS[kind]}
              onClick={() => addSource(createSource(kind))}
            />
          ))}
        </Group>

        <Separator orientation="vertical" className="h-auto" />

        <Group label="Build">
          {/* Generating resolves every source against live content, so with no sources
              there is nothing to build — the button says so by being disabled. */}
          <Large
            icon={mdiZipBoxOutline}
            label="Generate ZIP"
            disabled={sourceCount === 0}
            onClick={() => openDialog({ kind: "generate" })}
          />
          {/* Preview resolves every source against live content; with no sources there is
              nothing to resolve, so the button says so by being disabled. */}
          <Large
            icon={mdiPackageVariantClosed}
            label="Preview"
            disabled={sourceCount === 0}
            onClick={() => openDialog({ kind: "package-preview" })}
          />
        </Group>

        <Separator orientation="vertical" className="h-auto" />

        <Group label="Install">
          {/* The legacy designer's Launch-wizard button: jump straight to installing. */}
          <Large
            icon={mdiRocketLaunchOutline}
            label="Launch wizard"
            onClick={() => router.push("/standalone-extension/install")}
          />
        </Group>

        {selectedSource && (
          <>
            <Separator orientation="vertical" className="h-auto" />
            {/* "Source entries" names the group after the tab its commands act on, so a
                source with no ENTRIES tab — dynamic, or read-only — is just "Source". */}
            <Group
              label={
                isDynamic(selectedSource.kind) || isReadOnlyKind(selectedSource.kind)
                  ? "Source"
                  : "Source entries"
              }
            >
              <Large
                icon={mdiTrashCanOutline}
                label="Remove source"
                onClick={() => removeSource(selectedSource.uid)}
                iconClassName="text-danger-fg"
              />
            </Group>
          </>
        )}

        {/* Right edge. The designer used to spend a whole header row on the project name,
            restating a title the Cloud Portal's own chrome already shows above the iframe.
            The ribbon is two-tier and had the vertical room going spare, so both lines live
            here instead and the row is gone. */}
        <div className="ml-auto flex shrink-0 flex-col items-end justify-between gap-1 py-0.5 pl-2">
          <p className="max-w-[20rem] truncate text-sm">
            {projectName ?? "Untitled project"}
            {dirty && <span className="text-muted-foreground"> — unsaved changes</span>}
          </p>
          <EnvironmentBar className="-mr-1.5" />
        </div>
      </div>
    </TooltipProvider>
  );
}
