"use client";

// FILTERS (legacy Screens 5b and 7b) — the filter chain of a dynamic source.
//
// One long scrolling page. Every section is optional (blank means no restriction) and has
// its own Clear Filter button. Item sources get all nine sections. The file-filter
// counterpart was removed with the file source kinds, which SitecoreAI cannot resolve.

import { useState } from "react";
import { mdiClose, mdiPlus } from "@mdi/js";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Checkbox } from "@/src/components/ui/checkbox";
import { Label } from "@/src/components/ui/label";
import { Icon } from "@/src/components/ui/icon";
import { RadioGroup, RadioGroupItem } from "@/src/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import type { DateFilter, ItemFilters } from "@/src/core/model";
import { SelectRootItemDialog } from "../dialogs/SelectRootItemDialog";
import { useSession } from "../store/session";
import { TEMPLATES_ROOT_PATH } from "@/src/xmc/browse";

function FilterSection({
  title,
  onClear,
  canClear,
  children,
}: {
  title: string;
  onClear: () => void;
  canClear: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-b pb-6 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <h4 className="font-semibold">{title}</h4>
        <Button variant="outline" size="sm" disabled={!canClear} onClick={onClear}>
          Clear Filter
        </Button>
      </div>
      {children}
    </section>
  );
}

/** "Within the past N days" vs an explicit start/end range. */
function DateFilterFields({
  id,
  value,
  onChange,
}: {
  id: string;
  value: DateFilter | undefined;
  onChange: (next: DateFilter | undefined) => void;
}) {
  const mode = value?.mode ?? "within";
  return (
    <div className="space-y-3">
      <RadioGroup
        value={mode}
        onValueChange={(next) =>
          onChange(next === "within" ? { mode: "within", days: 0 } : { mode: "range" })
        }
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroupItem value="within" id={id + "-within"} />
          <Label htmlFor={id + "-within"}>Within the past</Label>
          <Input
            className="w-24"
            type="number"
            min={0}
            aria-label="Days"
            disabled={mode !== "within"}
            value={value?.mode === "within" ? String(value.days) : ""}
            onChange={(e) => {
              const days = Number(e.target.value);
              onChange(e.target.value === "" ? undefined : { mode: "within", days });
            }}
          />
          <span className="text-sm">days</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <RadioGroupItem value="range" id={id + "-range"} />
          <Label htmlFor={id + "-range"}>Specify dates</Label>
        </div>
      </RadioGroup>

      {mode === "range" && (
        <div className="grid gap-3 pl-6 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={id + "-from"}>Start date:</Label>
            <Input
              id={id + "-from"}
              type="date"
              value={value?.mode === "range" ? value.from ?? "" : ""}
              onChange={(e) =>
                onChange({
                  mode: "range",
                  from: e.target.value || undefined,
                  to: value?.mode === "range" ? value.to : undefined,
                })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={id + "-to"}>End date:</Label>
            <Input
              id={id + "-to"}
              type="date"
              value={value?.mode === "range" ? value.to ?? "" : ""}
              onChange={(e) =>
                onChange({
                  mode: "range",
                  from: value?.mode === "range" ? value.from : undefined,
                  to: e.target.value || undefined,
                })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** A list box with Add / Remove, used by the Created by and Updated by filters. */
function AccountListFilter({
  id,
  values,
  onChange,
}: {
  id: string;
  values: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const [draft, setDraft] = useState("");
  const list = values ?? [];

  return (
    <div className="space-y-2">
      <ul className="h-24 overflow-auto rounded-md border p-1 text-xs">
        {list.length === 0 && <li className="p-2 text-muted-foreground">No accounts.</li>}
        {list.map((account) => (
          <li
            key={account}
            className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-neutral-bg"
          >
            <span className="truncate font-mono">{account}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={"Remove " + account}
              onClick={() => {
                const next = list.filter((a) => a !== account);
                onChange(next.length > 0 ? next : undefined);
              }}
            >
              <Icon path={mdiClose} className="text-danger-fg" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={draft}
          placeholder="sitecore\\jane@example.com"
          aria-label="Account"
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={draft.trim() === ""}
          onClick={() => {
            if (!list.includes(draft.trim())) onChange([...list, draft.trim()]);
            setDraft("");
          }}
        >
          <Icon path={mdiPlus} /> Add
        </Button>
      </div>
    </div>
  );
}

// ── item filters ────────────────────────────────────────────────────────────

interface ItemFiltersProps {
  filters: ItemFilters;
  onChange: (next: ItemFilters) => void;
}

export function ItemFiltersTab({ filters, onChange }: ItemFiltersProps) {
  const languages = useSession((s) => s.languages);
  const pickingTemplate = useSession((s) => s.activeDialog?.kind === "template-picker");
  const openDialog = useSession((s) => s.openDialog);
  const closeDialog = useSession((s) => s.closeDialog);
  const patch = (next: Partial<ItemFilters>) => onChange({ ...filters, ...next });

  return (
    <div className="max-w-3xl space-y-6 p-6">
      <FilterSection
        title="Item name filter"
        canClear={!!filters.name}
        onClear={() => patch({ name: undefined })}
      >
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr] sm:items-center">
          <Label htmlFor="f-name">All or part of the item name:</Label>
          <Input
            id="f-name"
            value={filters.name?.pattern ?? ""}
            onChange={(e) =>
              patch({
                name: {
                  pattern: e.target.value,
                  searchType: filters.name?.searchType ?? "Simple",
                },
              })
            }
          />
          <Label htmlFor="f-name-type">Use:</Label>
          <Select
            value={filters.name?.searchType ?? "Simple"}
            onValueChange={(v) =>
              patch({
                name: {
                  pattern: filters.name?.pattern ?? "",
                  searchType: v as "Simple" | "Regex" | "Wildcards",
                },
              })
            }
          >
            <SelectTrigger id="f-name-type" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Simple">Simple Search</SelectItem>
              <SelectItem value="Regex">Regular Expression</SelectItem>
              <SelectItem value="Wildcards">Wildcards</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FilterSection>

      <FilterSection
        title="Creation date filter"
        canClear={!!filters.created}
        onClear={() => patch({ created: undefined })}
      >
        <DateFilterFields
          id="f-created"
          value={filters.created}
          onChange={(created) => patch({ created })}
        />
      </FilterSection>

      <FilterSection
        title="Modification date filter"
        canClear={!!filters.modified}
        onClear={() => patch({ modified: undefined })}
      >
        <DateFilterFields
          id="f-modified"
          value={filters.modified}
          onChange={(modified) => patch({ modified })}
        />
      </FilterSection>

      <FilterSection
        title="Publish date filter"
        canClear={!!filters.publish}
        onClear={() => patch({ publish: undefined })}
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr] sm:items-center">
            <Label htmlFor="f-publish">Publish date:</Label>
            <Input
              id="f-publish"
              type="date"
              value={filters.publish?.publishDate ?? ""}
              onChange={(e) =>
                patch({
                  publish: {
                    publishDate: e.target.value || undefined,
                    // Checked by default in the legacy dialog.
                    checkWorkflow: filters.publish?.checkWorkflow ?? true,
                  },
                })
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="f-workflow"
              checked={filters.publish?.checkWorkflow ?? true}
              onCheckedChange={(checked) =>
                patch({
                  publish: {
                    publishDate: filters.publish?.publishDate,
                    checkWorkflow: checked === true,
                  },
                })
              }
            />
            <Label htmlFor="f-workflow">Take workflow into account</Label>
          </div>
        </div>
      </FilterSection>

      <FilterSection
        title="Template filter"
        canClear={!!filters.templates?.length}
        onClear={() => patch({ templates: undefined })}
      >
        <div className="space-y-2">
          <ul className="h-28 overflow-auto rounded-md border p-1 text-xs">
            {!filters.templates?.length && (
              <li className="p-2 text-muted-foreground">
                No templates selected — items of any template are included.
              </li>
            )}
            {filters.templates?.map((id) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-neutral-bg"
              >
                <span className="truncate font-mono">{id}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={"Remove " + id}
                  onClick={() => {
                    const next = filters.templates?.filter((t) => t !== id) ?? [];
                    patch({ templates: next.length > 0 ? next : undefined });
                  }}
                >
                  <Icon path={mdiClose} className="text-danger-fg" />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openDialog({ kind: "template-picker" })}
          >
            <Icon path={mdiPlus} /> Add template
          </Button>
        </div>

        {pickingTemplate && (
          <SelectRootItemDialog
            open
            treeId="filters-templates"
            title="Select Template"
            rootPath={TEMPLATES_ROOT_PATH}
            showDatabase={false}
            onCancel={closeDialog}
            onConfirm={(node) => {
              const current = filters.templates ?? [];
              if (!current.includes(node.id)) patch({ templates: [...current, node.id] });
              closeDialog();
            }}
          />
        )}
      </FilterSection>

      <FilterSection
        title="Created by filter"
        canClear={!!filters.createdBy?.length}
        onClear={() => patch({ createdBy: undefined })}
      >
        <AccountListFilter
          id="f-createdby"
          values={filters.createdBy}
          onChange={(createdBy) => patch({ createdBy })}
        />
      </FilterSection>

      <FilterSection
        title="Updated by filter"
        canClear={!!filters.modifiedBy?.length}
        onClear={() => patch({ modifiedBy: undefined })}
      >
        <AccountListFilter
          id="f-updatedby"
          values={filters.modifiedBy}
          onChange={(modifiedBy) => patch({ modifiedBy })}
        />
      </FilterSection>

      <FilterSection
        title="Language filter"
        canClear={!!filters.languages?.length}
        onClear={() => patch({ languages: undefined })}
      >
        {languages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No languages could be loaded from this environment.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {languages.map((language) => {
              const checked = filters.languages?.includes(language.code) ?? false;
              return (
                <div key={language.code} className="flex items-center gap-2">
                  <Checkbox
                    id={"lang-" + language.code}
                    checked={checked}
                    onCheckedChange={(next) => {
                      const current = filters.languages ?? [];
                      const updated =
                        next === true
                          ? [...current, language.code]
                          : current.filter((c) => c !== language.code);
                      patch({ languages: updated.length > 0 ? updated : undefined });
                    }}
                  />
                  <Label htmlFor={"lang-" + language.code}>
                    {language.displayName}{" "}
                    <span className="text-muted-foreground">({language.code})</span>
                  </Label>
                </div>
              );
            })}
          </div>
        )}
      </FilterSection>
    </div>
  );
}
