"use client";

// "What will change" — the screen the legacy wizard does not have.
//
// Sitecore could afford to commit from Verify because it wrote an installation history and
// could uninstall. We cannot, and a chunk is consumed as one unit, so this is the only
// compensating control in the design. It is read-only.

import { Alert } from "@/src/components/ui/alert";
import { Spinner } from "@/src/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/src/components/ui/table";
import { useSession } from "@/src/features/create/store/session";
import { useWizard } from "../store/hooks";
import {
  alwaysCaveats,
  dispositionLabel,
  NOT_CONNECTED,
  notApplied,
  planSummary,
} from "../lib/describe";

/** Long packages are summarised rather than dumped — the caveats matter more than row 400. */
const MAX_ROWS = 200;

export function PlanStep() {
  const plan = useWizard((s) => s.plan);
  const planError = useWizard((s) => s.planError);
  const pkg = useWizard((s) => s.pkg);
  const busy = useWizard((s) => s.busy);
  const ctx = useSession((s) => s.ctx);

  if (!ctx) {
    return (
      <div className="p-6">
        <Alert variant="danger">{NOT_CONNECTED}</Alert>
      </div>
    );
  }

  if (planError) {
    return (
      <div className="p-6">
        <Alert variant="danger">{planError}</Alert>
      </div>
    );
  }

  if (!plan || busy) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner className="size-4" /> {busy ?? "Working out what this package will change…"}
      </p>
    );
  }

  const rows = plan.entries.slice(0, MAX_ROWS);
  const hidden = plan.entries.length - rows.length;

  return (
    <div className="space-y-4 p-6">
      <p className="font-medium">{planSummary(plan)}</p>

      {alwaysCaveats(plan).map((line) => (
        <Alert key={line} variant="warning">
          {line}
        </Alert>
      ))}
      {notApplied(pkg).map((line) => (
        <Alert key={line} variant="warning">
          {line}
        </Alert>
      ))}

      <div className="max-h-80 overflow-auto rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Action</TableHead>
              <TableHead>Path</TableHead>
              <TableHead className="w-64">Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry) => (
              <TableRow key={entry.item.id}>
                <TableCell
                  className={
                    entry.disposition === "blocked"
                      ? "text-danger-fg"
                      : entry.disposition === "update"
                        ? "text-muted-foreground"
                        : ""
                  }
                >
                  {dispositionLabel(entry)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {entry.existingPath || entry.item.path || entry.item.name}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {entry.reason ?? ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">…and {hidden} more not shown.</p>
      )}
    </div>
  );
}
