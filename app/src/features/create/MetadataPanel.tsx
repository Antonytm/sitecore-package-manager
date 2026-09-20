"use client";

// The Metadata page (legacy Screen 3) — General Info / Publishing / System.
//
// Field labels and grouping are kept verbatim from the legacy designer so the form reads
// the same, and because each field maps 1:1 onto a metadata entry in the built package.

import { Input } from "@/src/components/ui/input";
import { Textarea } from "@/src/components/ui/textarea";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { mdiClose, mdiPlus } from "@mdi/js";
import { useDesigner } from "./store/hooks";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-start sm:gap-4">
      <label htmlFor={htmlFor} className="pt-2 text-sm font-medium">
        {label}
      </label>
      <div className="space-y-1">
        {children}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export function MetadataPanel() {
  const metadata = useDesigner((s) => s.definition.metadata);
  const onChange = useDesigner((s) => s.patchMetadata);
  const attributes = Object.entries(metadata.attributes ?? {});

  function setAttributes(next: Array<[string, string]>) {
    const record: Record<string, string> = {};
    for (const [name, value] of next) {
      if (name.trim() !== "") record[name] = value;
    }
    onChange({ attributes: Object.keys(record).length > 0 ? record : undefined });
  }

  return (
    <div className="max-w-3xl space-y-8 p-6">
      <Section title="General Info">
        <Row label="Package Name:" htmlFor="meta-name" hint="The only required field.">
          <Input
            id="meta-name"
            value={metadata.name}
            onChange={(e) => onChange({ name: e.target.value })}
            aria-required
          />
        </Row>
        <Row label="Author:" htmlFor="meta-author">
          <Input
            id="meta-author"
            value={metadata.author ?? ""}
            onChange={(e) => onChange({ author: e.target.value })}
          />
        </Row>
        <Row label="Version:" htmlFor="meta-version">
          <Input
            id="meta-version"
            value={metadata.version ?? ""}
            onChange={(e) => onChange({ version: e.target.value })}
          />
        </Row>
      </Section>

      <Section title="Publishing">
        <Row label="Publisher:" htmlFor="meta-publisher">
          <Input
            id="meta-publisher"
            value={metadata.publisher ?? ""}
            onChange={(e) => onChange({ publisher: e.target.value })}
          />
        </Row>
        <Row label="License:" htmlFor="meta-license">
          <Textarea
            id="meta-license"
            rows={4}
            value={metadata.license ?? ""}
            onChange={(e) => onChange({ license: e.target.value })}
          />
        </Row>
        <Row label="Comment:" htmlFor="meta-comment">
          <Textarea
            id="meta-comment"
            rows={3}
            value={metadata.comment ?? ""}
            onChange={(e) => onChange({ comment: e.target.value })}
          />
        </Row>
        <Row
          label="Read me:"
          htmlFor="meta-readme"
          hint="Shown to whoever installs the package."
        >
          <Textarea
            id="meta-readme"
            rows={5}
            value={metadata.readme ?? ""}
            onChange={(e) => onChange({ readme: e.target.value })}
          />
        </Row>
      </Section>

      <Section title="System">
        <Row
          label="Post Step:"
          htmlFor="meta-poststep"
          hint="Fully-qualified type of an IPostStep to run after install. Server-side, so it is stored but not executed here."
        >
          <Input
            id="meta-poststep"
            value={metadata.postStep ?? ""}
            onChange={(e) => onChange({ postStep: e.target.value })}
          />
        </Row>

        <Row label="Custom Attributes:" htmlFor="meta-attr-0">
          <div className="space-y-2">
            {attributes.map(([name, value], index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  id={"meta-attr-" + index}
                  aria-label={"Attribute " + (index + 1) + " name"}
                  placeholder="Name"
                  value={name}
                  onChange={(e) => {
                    const next = [...attributes] as Array<[string, string]>;
                    next[index] = [e.target.value, value];
                    setAttributes(next);
                  }}
                />
                <Input
                  aria-label={"Attribute " + (index + 1) + " value"}
                  placeholder="Value"
                  value={value}
                  onChange={(e) => {
                    const next = [...attributes] as Array<[string, string]>;
                    next[index] = [name, e.target.value];
                    setAttributes(next);
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={"Remove attribute " + (index + 1)}
                  onClick={() =>
                    setAttributes(attributes.filter((_, i) => i !== index) as Array<[string, string]>)
                  }
                >
                  <Icon path={mdiClose} className="text-danger-fg" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setAttributes([...attributes, ["", ""]] as Array<[string, string]>)
              }
            >
              <Icon path={mdiPlus} /> Add attribute
            </Button>
          </div>
        </Row>
      </Section>
    </div>
  );
}
