"use client";

// INSTALLATION OPTIONS (legacy Screen 9) — the design-time twin of the installer's
// collision dialog. "How should the installer behave if the package contains items that
// already exist:"
//
// Two faithful details: the default is **Ask User** (serialized as ItemMode=Undefined),
// and **file sources omit Merge**, because files cannot be version-merged.

import { RadioGroup, RadioGroupItem } from "@/src/components/ui/radio-group";
import { Label } from "@/src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import type { BehaviourOptions, ItemMergeMode, ItemMode } from "@/src/core/model";

interface Props {
  behaviour: BehaviourOptions;
  /** File sources get Overwrite / Skip / Ask User only. */
  allowMerge: boolean;
  onChange: (behaviour: BehaviourOptions) => void;
}

/** The radio value shown in the UI; "Undefined" is presented as "Ask User". */
const CHOICES: Array<{ value: ItemMode; label: string; description: string }> = [
  {
    value: "Overwrite",
    label: "Overwrite",
    description: "Replace the existing item, and its versions, with the one from the package.",
  },
  {
    value: "Merge",
    label: "Merge",
    description: "Keep the existing item and combine its versions with the package's.",
  },
  {
    value: "Skip",
    label: "Skip",
    description: "Leave the existing item untouched and install nothing for it.",
  },
  {
    value: "Undefined",
    label: "Ask User",
    description:
      "If files with the same ID or Path are found, you will be asked to resolve the conflict.",
  },
];

const MERGE_MODES: Array<{ value: ItemMergeMode; label: string }> = [
  { value: "Clear", label: "Clear" },
  { value: "Append", label: "Append" },
  { value: "Merge", label: "Merge" },
];

export function InstallOptionsTab({ behaviour, allowMerge, onChange }: Props) {
  const choices = allowMerge ? CHOICES : CHOICES.filter((c) => c.value !== "Merge");
  const active = choices.find((c) => c.value === behaviour.itemMode) ?? choices[choices.length - 1];

  return (
    <div className="space-y-4 p-6">
      <p className="font-medium">
        How should the installer behave if the package contains items that already exist:
      </p>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <RadioGroup
          value={behaviour.itemMode}
          onValueChange={(value) =>
            onChange({
              itemMode: value as ItemMode,
              // A merge sub-mode is only meaningful while Merge is selected.
              itemMergeMode:
                value === "Merge"
                  ? behaviour.itemMergeMode === "Undefined"
                    ? "Clear"
                    : behaviour.itemMergeMode
                  : "Undefined",
            })
          }
          className="space-y-3"
        >
          {choices.map((choice) => (
            <div key={choice.value} className="space-y-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem value={choice.value} id={"mode-" + choice.value} />
                <Label htmlFor={"mode-" + choice.value}>{choice.label}</Label>
              </div>

              {choice.value === "Merge" && behaviour.itemMode === "Merge" && (
                <div className="pl-6">
                  <Select
                    value={
                      behaviour.itemMergeMode === "Undefined" ? "Clear" : behaviour.itemMergeMode
                    }
                    onValueChange={(v) =>
                      onChange({ itemMode: "Merge", itemMergeMode: v as ItemMergeMode })
                    }
                  >
                    <SelectTrigger className="w-40" aria-label="Merge mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MERGE_MODES.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          ))}
        </RadioGroup>

        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          {active.description}
          {behaviour.itemMode === "Merge" && (
            <p className="mt-2">
              {behaviour.itemMergeMode === "Append" &&
                "Append — add the package's versions on top, keeping the existing ones."}
              {behaviour.itemMergeMode === "Merge" &&
                "Merge — replace overlapping versions and keep the rest."}
              {(behaviour.itemMergeMode === "Clear" ||
                behaviour.itemMergeMode === "Undefined") &&
                "Clear — remove the existing versions, then add the package's."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
