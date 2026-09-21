"use client";

// The one line that says WHERE you are: which SitecoreAI project/environment this session
// writes to, and which page is hosting the iframe.
//
// It earns its place because installing is irreversible — a `.raif` chunk creates items at
// fixed GUIDs on a live tenant and there is no uninstall — so "which environment is this?"
// must be answerable without opening the portal's own dropdown.
//
// Neutral styling throughout, on purpose. A local host is a NORMAL state for a developer,
// not a fault; the bar reports which environment and host are in use and leaves the judging
// alone. `danger` stays reserved for the connection errors the designer already renders.

import { useEffect, useState } from "react";
import { mdiCubeOutline, mdiMonitorDashboard } from "@mdi/js";
import { Badge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/src/components/ui/popover";
import { Spinner } from "@/src/components/ui/spinner";
import { describeEmbedding, readEmbeddingProbe } from "@/src/lib/embedding";
import type { EmbeddingInfo } from "@/src/lib/embedding";
import { useSession } from "@/src/features/create/store/session";

/** One label/value row in the popover. Values are selectable so an id can be copied out. */
function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all select-all">{value}</span>
    </div>
  );
}

export function EnvironmentBar({ className }: { className?: string }) {
  const environment = useSession((s) => s.environment);
  const contextLoaded = useSession((s) => s.contextLoaded);
  const connectionError = useSession((s) => s.connectionError);
  const database = useSession((s) => s.ctx?.database);

  // Must not run at module load: these modules are evaluated during Next's prerender, where
  // `window` does not exist — the same constraint store/autosave.ts documents.
  const [embedding, setEmbedding] = useState<EmbeddingInfo>();
  useEffect(() => setEmbedding(describeEmbedding(readEmbeddingProbe())), []);

  if (!contextLoaded && !connectionError) {
    return (
      <span className={"flex items-center gap-1.5 text-xs text-muted-foreground " + (className ?? "")}>
        <Spinner className="size-3" /> connecting…
      </span>
    );
  }

  const envLabel = connectionError ? "not connected" : (environment?.label ?? "environment unknown");

  return (
    <Popover>
      <PopoverTrigger
        className={
          "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs hover:bg-neutral-bg " +
          (className ?? "")
        }
      >
        <Icon path={mdiCubeOutline} className="!size-3.5 text-muted-foreground" />
        <span className="max-w-[18rem] truncate font-medium">{envLabel}</span>
        {environment?.environmentType && (
          <Badge size="sm" colorScheme="neutral" className="text-[11px]">
            {environment.environmentType}
          </Badge>
        )}
        {embedding && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="max-w-[16rem] truncate text-muted-foreground">{embedding.label}</span>
          </>
        )}
      </PopoverTrigger>

      <PopoverContent align="end" className="w-96 text-xs">
        <p className="mb-1 flex items-center gap-1.5 font-semibold">
          <Icon path={mdiCubeOutline} className="!size-4" /> SitecoreAI environment
        </p>
        <Row label="Project" value={environment?.project} />
        <Row label="Environment" value={environment?.environment} />
        <Row label="Type" value={environment?.environmentType} />
        <Row label="Region" value={environment?.regionCode} />
        <Row label="Database" value={database} />
        <Row label="Tenant id" value={environment?.tenantId} />
        <Row label="Tenant name" value={environment?.tenantName} />
        <Row label="Organization" value={environment?.organizationId} />
        <Row label="Project id" value={environment?.projectId} />
        <Row label="Environment id" value={environment?.environmentId} />
        <Row label="Context id" value={environment?.contextId} />
        {/* Naming the source turns a wrong label into something diagnosable rather than
            mysterious — the three sources disagree in shape and availability. */}
        <Row label="Resolved from" value={environment?.source} />

        <p className="mt-2 mb-1 flex items-center gap-1.5 border-t pt-2 font-semibold">
          <Icon path={mdiMonitorDashboard} className="!size-4" /> Host
        </p>
        <Row label="Hosting page" value={embedding?.hostOrigin ?? "not detected"} />
        <Row label="This app" value={embedding?.appOrigin} />
        <Row label="Detected via" value={embedding?.detectedVia} />
        {embedding?.kind === "portal" && embedding.appIsLocal && (
          <p className="mt-1 text-muted-foreground">
            Running a local build inside the real Cloud Portal.
          </p>
        )}
        {embedding?.kind === "not-embedded" && (
          <p className="mt-1 text-muted-foreground">
            Opened directly rather than through the portal, so the SDK has no host to talk to.
          </p>
        )}

        {connectionError && (
          <p className="mt-2 border-t pt-2 text-danger-fg">{String(connectionError.message)}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
