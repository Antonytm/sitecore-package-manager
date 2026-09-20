"use client";

// Legacy Screen 8 is a bare spinner. We show the per-item log as it happens instead: the
// same article requires a per-item log on the result, and collecting it live costs nothing
// and makes an abort informative rather than silent.

import { Progress } from "@/src/components/ui/progress";
import { Spinner } from "@/src/components/ui/spinner";
import { useWizard } from "../store/hooks";

export function InstallingStep() {
  const busy = useWizard((s) => s.busy);
  const progress = useWizard((s) => s.progress);
  const log = useWizard((s) => s.log);

  const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : undefined;

  return (
    <div className="space-y-4 p-6">
      <p className="flex items-center gap-2 text-sm">
        <Spinner className="size-4" /> {busy ?? "Installing…"}
      </p>
      {pct !== undefined && <Progress value={pct} />}
      {log.length > 0 && (
        <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}
