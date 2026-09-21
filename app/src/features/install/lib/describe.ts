// All user-facing copy for the install wizard.
//
// It lives here rather than in the components because vitest runs node over
// `src/**/*.test.ts` — no .tsx, no jsdom — so a sentence written inside a component is a
// sentence with no coverage. The caveats in particular are asserted against real sample
// packages, so the wording cannot drift away from what the data actually says.

import type { PackageModel } from "@/src/core/model";
import type { InstallPlan, PlannedItem } from "@/src/xmc/plan";
import type { InstallResult } from "@/src/xmc/install";

/**
 * Shown instead of a spinner when there is no Sitecore session.
 *
 * Both the plan and the install need the host connection. Without it they would otherwise
 * wait forever on a step that can never complete, which reads as a hang rather than as a
 * missing connection.
 */
export const NOT_CONNECTED =
  "Not connected to Sitecore, so this package cannot be checked or installed. " +
  "Open this app from the Sitecore Cloud Portal.";

export function packageTitle(pkg: PackageModel | undefined): string {
  return pkg?.metadata.name?.trim() || "Unnamed package";
}

function plural(n: number, one: string, many = one + "s"): string {
  return n + " " + (n === 1 ? one : many);
}

/** The one-line summary above the plan table. */
export function planSummary(plan: InstallPlan | undefined): string {
  if (!plan) return "Working out what this package will change…";
  const parts: string[] = [];
  if (plan.creating) parts.push(plural(plan.creating, "new item"));
  if (plan.updating) parts.push(plural(plan.updating, "existing item") + " updated");
  if (plan.blocked) parts.push(plural(plan.blocked, "item") + " blocked");
  if (parts.length === 0) return "This package contains nothing that can be installed.";
  // Media is named separately rather than folded into the item counts: a media item is one
  // of those items, and the file it points at is the part people actually worry about.
  if (plan.media) parts.push(plural(plan.media, "media file") + " applied");
  return parts.join(", ") + ".";
}

export function dispositionLabel(entry: PlannedItem): string {
  if (entry.disposition === "create") return "Create";
  if (entry.disposition === "update") return "Update";
  return "Blocked";
}

/**
 * What this package carries that the installer will not apply.
 *
 * Stated rather than hidden: a package can legitimately contain file and security-account
 * sources, and on XM Cloud neither can be applied — there is no server file system and
 * identity lives in the Cloud Portal.
 */
export function notApplied(pkg: PackageModel | undefined): string[] {
  if (!pkg) return [];
  const out: string[] = [];

  const files = pkg.sources.filter((s) => s.kind === "files-static" || s.kind === "files-dynamic");
  if (files.length > 0) {
    out.push(
      plural(files.length, "file source") +
        " will not be applied — SitecoreAI has no server file system.",
    );
  }

  const accounts = pkg.sources.filter((s) => s.kind === "accounts");
  if (accounts.length > 0) {
    out.push(
      plural(accounts.length, "security-account source") +
        " will not be applied — identity lives in the Cloud Portal.",
    );
  }

  if (pkg.metadata.postStep?.trim()) {
    out.push(
      "This package declares a post-step (" +
        pkg.metadata.postStep.trim() +
        ") which cannot run here.",
    );
  }

  return out;
}

/** Caveats that apply to every install on this platform, shown on the plan step. */
export function alwaysCaveats(plan: InstallPlan | undefined): string[] {
  const out: string[] = [];
  out.push("Installing cannot be undone — this app has no uninstall.");
  if (plan && plan.missingTemplates.length > 0) {
    const n = plan.missingTemplates.length;
    out.push(
      plural(n, "template") +
        (n === 1 ? " referenced by this package is" : " referenced by this package are") +
        " not on this environment, so the items using " +
        (n === 1 ? "it" : "them") +
        " are blocked.",
    );
  }
  if (plan && plan.problems.length > 0) {
    const n = plan.problems.length;
    out.push(plural(n, "item") + (n === 1 ? " could" : " could") + " not be checked before installing.");
  }
  return out;
}

export function resultHeadline(result: InstallResult | undefined): string {
  if (!result) return "";
  if (result.failed.length > 0) return "The installation failed.";
  if (result.installed === 0) return "Nothing was installed.";
  const media = result.media > 0 ? " and " + plural(result.media, "media file") : "";
  return "Installed " + plural(result.installed, "item") + media + ".";
}

export function resultDetail(result: InstallResult | undefined): string[] {
  if (!result) return [];
  const out: string[] = [];
  if (result.skipped > 0) out.push(plural(result.skipped, "item") + " skipped.");
  // One message per distinct failure — a chunk fails as a unit, so every item usually
  // carries the same text and repeating it 300 times helps nobody.
  const seen = new Set<string>();
  for (const failure of result.failed) {
    if (seen.has(failure.error)) continue;
    seen.add(failure.error);
    out.push(failure.error);
  }
  return out;
}
