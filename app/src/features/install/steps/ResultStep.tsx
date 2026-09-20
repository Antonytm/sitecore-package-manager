"use client";

// Legacy Screen 10. On failure the legacy wizard offers "Retry the installation"; here Retry
// returns to the plan step rather than re-running blind, because the plan is a snapshot and
// whatever failed may have changed the target.

import { Alert } from "@/src/components/ui/alert";
import { Button } from "@/src/components/ui/button";
import { useWizard } from "../store/hooks";
import { wizardStore } from "../store/wizard";
import { resultDetail, resultHeadline } from "../lib/describe";

export function ResultStep() {
  const result = useWizard((s) => s.result);
  const log = useWizard((s) => s.log);
  const failed = (result?.failed.length ?? 0) > 0;

  return (
    <div className="space-y-4 p-6">
      <p className="font-medium">{resultHeadline(result)}</p>

      {resultDetail(result).map((line) => (
        <Alert key={line} variant={failed ? "danger" : "warning"}>
          {line}
        </Alert>
      ))}

      {result?.fileName && (
        <p className="text-xs text-muted-foreground">Transfer file: {result.fileName}</p>
      )}

      {log.length > 0 && (
        <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">{log.join("\n")}</pre>
      )}

      {failed && (
        <Button
          variant="outline"
          onClick={() => {
            // Back to the plan, which recomputes — the target may have moved.
            const w = wizardStore.getState();
            w.clearPlan();
            w.goTo("plan");
          }}
        >
          Retry the installation
        </Button>
      )}
    </div>
  );
}
