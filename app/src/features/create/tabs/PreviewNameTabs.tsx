"use client";

// PREVIEW and NAME — the two tabs every source has (legacy Screen 10).
//
// Preview is "a read-only listing of what the source resolves to (Entry Key / Installation
// options columns; for dynamic sources this re-runs the query)". For a STATIC source that
// is free: the entries ARE the contribution. A DYNAMIC source stores only a root and
// filters, so answering the question means going and looking — which is the one thing that
// makes a wrong filter visible before the package is built rather than after.
//
// That walk is one request per node with children, so it does NOT run on tab open. It runs
// when asked, reports progress, and can be stopped. The result is kept in the session
// store: this component is unmounted both by switching source (SourceDetail is keyed by
// uid) and by switching tab (Radix unmounts inactive TabsContent), and re-running a
// thousand requests on either would be indefensible.

import { useEffect, useRef, useState } from "react";
import { mdiAlertOutline, mdiPlayOutline, mdiRefresh, mdiStopCircleOutline } from "@mdi/js";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Spinner } from "@/src/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/src/components/ui/table";
import { formatAccountRef, formatItemRef } from "@/src/core/definition";
import { FILTER_LABELS } from "@/src/core/filters";
import type { DateFilter, SourceDefinition } from "@/src/core/model";
import { resolveSource } from "@/src/xmc/resolve";
import { SOURCE_LABELS, behaviourLabel, dynamicQueryKey, entryCount } from "../sources";
import { useSession } from "../store/session";

function describeDate(label: string, filter: DateFilter | undefined): string | undefined {
  if (!filter) return undefined;
  if (filter.mode === "within") return label + " within the past " + filter.days + " days";
  const from = filter.from ?? "any";
  const to = filter.to ?? "any";
  return label + " between " + from + " and " + to;
}

/** A readable rendering of everything the source's query says. */
function describeQuery(source: SourceDefinition): string[] {
  const lines: string[] = [];

  if (source.kind === "items-dynamic") {
    lines.push("Database: " + (source.database || "—"));
    lines.push("Root item: " + (source.root || "not set"));
    if (source.skipVersions) lines.push("Latest version only");
    const f = source.include;
    if (f.name?.pattern) lines.push('Name contains "' + f.name.pattern + '" (' + f.name.searchType + ")");
    const created = describeDate("Created", f.created);
    if (created) lines.push(created);
    const modified = describeDate("Modified", f.modified);
    if (modified) lines.push(modified);
    if (f.publish) {
      lines.push(
        "Published" +
          (f.publish.publishDate ? " on " + f.publish.publishDate : "") +
          (f.publish.checkWorkflow ? ", taking workflow into account" : ""),
      );
    }
    if (f.templates?.length) lines.push("Templates: " + f.templates.join(", "));
    if (f.createdBy?.length) lines.push("Created by: " + f.createdBy.join(", "));
    if (f.modifiedBy?.length) lines.push("Updated by: " + f.modifiedBy.join(", "));
    if (f.languages?.length) lines.push("Languages: " + f.languages.join(", "));
  }

  if (source.kind === "files-dynamic") {
    lines.push("Root folder: " + (source.root || "not set"));
    const f = source.include;
    if (f.name?.pattern) {
      lines.push(
        'Name contains "' +
          f.name.pattern +
          '"' +
          (f.name.acceptDirectories ? ", ignoring directory entries" : ""),
      );
    }
    const created = describeDate("Created", f.created);
    if (created) lines.push(created);
    const modified = describeDate("Modified", f.modified);
    if (modified) lines.push(modified);
  }

  if (lines.length <= 1) lines.push("No filters — everything under the root.");
  return lines;
}

/** The legacy two columns, shared by both branches of this tab. */
function EntryTable({ rows, options }: { rows: string[]; options: string }) {
  return (
    <div className="max-h-[28rem] overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Entry key</TableHead>
            <TableHead className="w-48">Installation options</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row}>
              <TableCell className="font-mono text-xs">{row}</TableCell>
              <TableCell className="text-xs">{options}</TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={2} className="text-muted-foreground">
                Nothing in this source yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The dynamic branch: state the query, then go and resolve it on request.
 *
 * Everything transient — the in-flight flag, the error, the controller — stays local.
 * Only the RESULT is hoisted, because only the result is expensive to reproduce.
 */
function DynamicPreview({ source }: { source: SourceDefinition & { kind: "items-dynamic" } }) {
  const ctx = useSession((s) => s.ctx);
  const cached = useSession((s) => s.previews[source.uid]);
  const setPreview = useSession((s) => s.setPreview);

  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  // A ref, not state: aborting must not wait for a re-render, and the unmount cleanup has
  // to reach the controller of a walk still in flight.
  const walk = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => walk.current?.abort(), []);

  const queryKey = dynamicQueryKey(source);
  const stale = cached !== undefined && cached.key !== queryKey;

  async function run() {
    if (!ctx) return;
    setError(undefined);
    setNote(undefined);
    const controller = new AbortController();
    walk.current = controller;
    setBusy("Resolving…");
    try {
      const result = await resolveSource(ctx, source, {
        signal: controller.signal,
        onProgress: (scanned) => setBusy("Scanned " + scanned + " items…"),
      });
      setPreview(source.uid, { ...result, key: queryKey, at: Date.now() });
    } catch (e: unknown) {
      // Stopping is a decision, not a failure; the partial walk is discarded either way.
      if (controller.signal.aborted) setNote("Stopped. The list below is the previous run.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      walk.current = undefined;
      setBusy(undefined);
    }
  }

  const options = behaviourLabel(source.behaviour);

  return (
    <div className="space-y-4 p-6">
      <div className="max-w-3xl">
        <h4 className="font-semibold">{SOURCE_LABELS[source.kind]}</h4>
        <p className="text-sm text-muted-foreground">
          This source stores a query, not a fixed list. Resolve it to see what it selects
          right now — the package re-runs the same query when it is generated.
        </p>
      </div>

      <ul className="max-w-3xl space-y-1 rounded-md border p-4 text-sm">
        {describeQuery(source).map((line, i) => (
          <li key={i} className="font-mono text-xs">
            {line}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={!!busy || !ctx || !source.root} onClick={run}>
          <Icon path={cached ? mdiRefresh : mdiPlayOutline} />
          {cached ? "Re-run preview" : "Run preview"}
        </Button>

        {busy && (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> {busy}
            {/* "Stop", not "Cancel" — this tab has no Cancel, but the wording matches the
                Select Items dialog, where the distinction does matter. */}
            <Button variant="ghost" size="sm" onClick={() => walk.current?.abort()}>
              <Icon path={mdiStopCircleOutline} /> Stop
            </Button>
          </span>
        )}

        {!source.root && (
          <span className="text-sm text-muted-foreground">
            Set a search root first, on the SEARCH ROOT tab.
          </span>
        )}
      </div>

      {error && <p className="text-sm text-danger-fg">{error}</p>}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}

      {cached && (
        <>
          {stale && (
            <Alert variant="warning">
              <AlertDescription>
                The query changed since this ran. Re-run to see what the source selects now.
              </AlertDescription>
            </Alert>
          )}

          {cached.unevaluated.length > 0 && (
            <Alert variant="warning">
              <AlertDescription>
                Could not apply the{" "}
                {cached.unevaluated.map((k) => FILTER_LABELS[k]).join(", ")} filter
                {cached.unevaluated.length === 1 ? "" : "s"} — this environment&rsquo;s
                Authoring API did not return the information they test. The list below is
                therefore <strong>wider</strong> than what the package will contain.
              </AlertDescription>
            </Alert>
          )}

          {cached.truncated && (
            <Alert variant="warning">
              <AlertDescription>
                Stopped at {cached.entries.length} items. The subtree is larger than preview
                will walk; narrow the search root or the filters to see all of it.
              </AlertDescription>
            </Alert>
          )}

          <p className="text-sm text-muted-foreground">
            {cached.entries.length} of {cached.scanned} items scanned
            {cached.unevaluated.length > 0 ? " — some filters not applied" : ""}.
          </p>

          <div className={stale ? "opacity-50" : undefined}>
            <EntryTable rows={cached.entries.map((e) => e.key)} options={options} />
          </div>

          {source.include.templates?.length ? (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Icon path={mdiAlertOutline} className="mt-0.5 size-3.5 shrink-0" />
              Templates are matched exactly. An item using a template that merely inherits
              from one you picked is not included.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function PreviewTab({ source }: { source: SourceDefinition }) {
  if (source.kind === "items-dynamic") {
    return <DynamicPreview source={source} />;
  }

  // A file source's query cannot be resolved at all — there is no server file system to
  // run it against — so it keeps the description it always had.
  if (source.kind === "files-dynamic") {
    return (
      <div className="max-w-3xl space-y-4 p-6">
        <div>
          <h4 className="font-semibold">{SOURCE_LABELS[source.kind]}</h4>
          <p className="text-sm text-muted-foreground">
            This source stores a query over the Sitecore server&rsquo;s file system, which
            SitecoreAI does not have. It is kept as it was, but it cannot be resolved here.
          </p>
        </div>
        <ul className="space-y-1 rounded-md border p-4 text-sm">
          {describeQuery(source).map((line, i) => (
            <li key={i} className="font-mono text-xs">
              {line}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const count = entryCount(source) ?? 0;
  const rows =
    source.kind === "items-static"
      ? source.entries.map((e) => formatItemRef(e))
      : source.kind === "files-static"
        ? source.entries
        : source.entries.map((e) => formatAccountRef(e));

  return (
    <div className="space-y-4 p-6">
      <p className="text-sm text-muted-foreground">
        {count} {count === 1 ? "entry" : "entries"}, captured at design time. Duplicates across
        sources are removed when the package is generated.
      </p>
      <EntryTable rows={rows} options={behaviourLabel(source.behaviour)} />
    </div>
  );
}

export function NameTab({
  name,
  onChange,
}: {
  name: string;
  onChange: (name: string) => void;
}) {
  return (
    <div className="max-w-xl space-y-3 p-6">
      <Label htmlFor="source-name">Name:</Label>
      <Input
        id="source-name"
        value={name}
        placeholder="Unnamed source"
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        A label for this source inside the definition. It does not affect what is packaged.
      </p>
    </div>
  );
}
