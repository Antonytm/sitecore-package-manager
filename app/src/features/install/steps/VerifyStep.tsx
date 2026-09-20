"use client";

// Legacy Screen 7: read-only package metadata. In the legacy wizard this was also the point
// of commitment; here Next leads to "What will change" instead.

import { useWizard } from "../store/hooks";

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value?.trim() ? value : <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

export function VerifyStep() {
  const pkg = useWizard((s) => s.pkg);
  const meta = pkg?.metadata;
  return (
    <dl className="p-6 text-sm">
      <Row label="Package name" value={meta?.name} />
      <Row label="Version" value={meta?.version} />
      <Row label="Author" value={meta?.author} />
      <Row label="Publisher" value={meta?.publisher} />
      <Row label="Comment" value={meta?.comment} />
      <Row label="Items" value={String(pkg?.items.length ?? 0)} />
    </dl>
  );
}
