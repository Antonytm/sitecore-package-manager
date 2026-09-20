// The wizard's step sequence, as data.
//
// Mirrors the legacy Installation Wizard (wiki/articles/installation-wizard-ui.md) with one
// deliberate divergence: Verify's footer is **Next**, not Install, and the irreversible
// commitment moves one screen later onto "What will change". The legacy wizard had no such
// screen because Sitecore had an installation history and therefore an uninstall; we have
// neither, and a chunk is consumed as one unit, so that screen is the only compensating
// control in the design.
//
// Readme and License appear only when the package carries them — every sample package has an
// empty `sc_license.txt`, so the License screen is skipped in practice.

import type { PackageMetadata } from "@/src/core/model";

export type StepId =
  | "select"
  | "readme"
  | "license"
  | "verify"
  | "plan"
  | "installing"
  | "result";

export interface Step {
  id: StepId;
  /** Shown in the rail. */
  label: string;
  /** The legacy wizard's own subtitle, kept verbatim where there is one. */
  subtitle: string;
}

const ALL: Record<StepId, Step> = {
  select: {
    id: "select",
    label: "Select a package",
    subtitle: "Select a package to install.",
  },
  readme: {
    id: "readme",
    label: "Readme",
    subtitle: "Please read the additional installation instructions before you continue.",
  },
  license: {
    id: "license",
    label: "License",
    subtitle: "Please read the license agreement before you continue.",
  },
  verify: {
    id: "verify",
    label: "Verify",
    subtitle: "Verify the package information before you click install.",
  },
  plan: {
    id: "plan",
    label: "What will change",
    subtitle: "Review what this package will do to this environment. There is no undo.",
  },
  installing: {
    id: "installing",
    label: "Installing",
    subtitle: "Please wait while the package is being installed. This may take a few minutes.",
  },
  result: {
    id: "result",
    label: "Result",
    subtitle: "",
  },
};

/** The steps this particular package needs, in order. */
export function stepsFor(metadata: PackageMetadata | undefined): Step[] {
  const out: Step[] = [ALL.select];
  if (metadata?.readme?.trim()) out.push(ALL.readme);
  if (metadata?.license?.trim()) out.push(ALL.license);
  out.push(ALL.verify, ALL.plan, ALL.installing, ALL.result);
  return out;
}

export function stepAt(steps: Step[], index: number): Step {
  return steps[Math.min(Math.max(index, 0), steps.length - 1)];
}

export function indexOfStep(steps: Step[], id: StepId): number {
  return steps.findIndex((s) => s.id === id);
}

/** Back is available everywhere except the first screen and once installing has begun. */
export function canGoBack(steps: Step[], index: number): boolean {
  const id = stepAt(steps, index).id;
  return index > 0 && id !== "installing" && id !== "result";
}

export interface ForwardState {
  hasPackage: boolean;
  /** The plan must have been computed before Install is offered. */
  hasPlan: boolean;
  /** Nothing installable — every item blocked, or the package carries no items. */
  nothingToInstall: boolean;
  busy: boolean;
}

/** Whether the forward button is enabled, and what it should say. */
export function forwardAction(
  steps: Step[],
  index: number,
  state: ForwardState,
): { label: string; enabled: boolean } | undefined {
  const id = stepAt(steps, index).id;
  if (state.busy) return { label: "Working…", enabled: false };

  switch (id) {
    case "select":
      return { label: "Next", enabled: state.hasPackage };
    case "readme":
    case "license":
      return { label: "Next", enabled: true };
    case "verify":
      return { label: "Next", enabled: true };
    case "plan":
      return { label: "Install", enabled: state.hasPlan && !state.nothingToInstall };
    case "installing":
      return undefined; // nothing to press; the run drives itself
    case "result":
      return { label: "Close", enabled: true };
  }
}
