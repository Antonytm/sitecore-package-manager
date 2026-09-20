// The wizard's decisions: step sequencing, button state, copy, and file-error wording.
//
// All of it lives in `.ts` precisely so it can be tested — vitest is node-only over
// `src/**/*.test.ts`, so anything decided inside a `.tsx` has no coverage at all.

import { describe, it, expect, beforeEach } from "vitest";
import type { PackageMetadata, PackageModel } from "@/src/core/model";
import type { InstallPlan } from "@/src/xmc/plan";
import { canGoBack, forwardAction, indexOfStep, stepsFor } from "../lib/steps";
import {
  alwaysCaveats,
  dispositionLabel,
  notApplied,
  packageTitle,
  planSummary,
  resultDetail,
  resultHeadline,
} from "../lib/describe";
import { describeReadError, tooLarge, MAX_PACKAGE_BYTES } from "../lib/readfile";
import { createWizardStore } from "../store/wizard";

const meta = (over: Partial<PackageMetadata> = {}): PackageMetadata => ({ name: "P", ...over });

const pkgWith = (over: Partial<PackageModel> = {}): PackageModel => ({
  metadata: meta(),
  items: [],
  sources: [],
  ...over,
});

const emptyPlan = (over: Partial<InstallPlan> = {}): InstallPlan => ({
  entries: [],
  creating: 0,
  updating: 0,
  blocked: 0,
  missingTemplates: [],
  problems: [],
  ...over,
});

describe("step sequence", () => {
  it("skips Readme and License when the package has neither", () => {
    expect(stepsFor(meta()).map((s) => s.id)).toEqual([
      "select", "verify", "plan", "installing", "result",
    ]);
  });

  it("includes Readme only when there is one", () => {
    expect(indexOfStep(stepsFor(meta({ readme: "hello" })), "readme")).toBe(1);
    expect(indexOfStep(stepsFor(meta({ readme: "   " })), "readme")).toBe(-1);
  });

  it("includes License only when there is one — every real sample has it empty", () => {
    expect(indexOfStep(stepsFor(meta({ license: "" })), "license")).toBe(-1);
    expect(indexOfStep(stepsFor(meta({ license: "Terms" })), "license")).toBeGreaterThan(0);
  });

  it("puts the plan step between verify and installing", () => {
    const ids = stepsFor(meta({ readme: "r", license: "l" })).map((s) => s.id);
    expect(ids).toEqual(["select", "readme", "license", "verify", "plan", "installing", "result"]);
  });

  it("keeps the legacy Verify wording", () => {
    const verify = stepsFor(meta()).find((s) => s.id === "verify")!;
    expect(verify.subtitle).toBe("Verify the package information before you click install.");
  });
});

describe("navigation", () => {
  const steps = stepsFor(meta());

  it("allows Back everywhere except the first screen", () => {
    expect(canGoBack(steps, 0)).toBe(false);
    expect(canGoBack(steps, 1)).toBe(true);
  });

  it("forbids Back once installing has started", () => {
    expect(canGoBack(steps, indexOfStep(steps, "installing"))).toBe(false);
    expect(canGoBack(steps, indexOfStep(steps, "result"))).toBe(false);
  });
});

describe("the forward button", () => {
  const steps = stepsFor(meta());
  const state = {
    hasPackage: true, hasPlan: true, nothingToInstall: false, busy: false,
  };

  it("is disabled on Select until a package is loaded", () => {
    expect(forwardAction(steps, 0, { ...state, hasPackage: false })!.enabled).toBe(false);
    expect(forwardAction(steps, 0, state)!.enabled).toBe(true);
  });

  it("says Install only on the plan step", () => {
    expect(forwardAction(steps, indexOfStep(steps, "plan"), state)!.label).toBe("Install");
    expect(forwardAction(steps, indexOfStep(steps, "verify"), state)!.label).toBe("Next");
  });

  it("refuses to install before the plan exists", () => {
    const at = indexOfStep(steps, "plan");
    expect(forwardAction(steps, at, { ...state, hasPlan: false })!.enabled).toBe(false);
  });

  it("refuses to install when every item is blocked", () => {
    const at = indexOfStep(steps, "plan");
    expect(forwardAction(steps, at, { ...state, nothingToInstall: true })!.enabled).toBe(false);
  });

  it("offers nothing to press while installing", () => {
    expect(forwardAction(steps, indexOfStep(steps, "installing"), state)).toBeUndefined();
  });

  it("disables everything while busy", () => {
    expect(forwardAction(steps, 0, { ...state, busy: true })!.enabled).toBe(false);
  });
});

describe("the store", () => {
  let store: ReturnType<typeof createWizardStore>;
  beforeEach(() => {
    store = createWizardStore();
  });

  it("rebuilds the step list from the loaded package", () => {
    store.getState().loadPackage("p.zip", pkgWith({ metadata: meta({ readme: "hi" }) }));
    expect(store.getState().steps.map((s) => s.id)).toContain("readme");
  });

  it("discards the plan when stepping back off it", () => {
    const s = store.getState();
    s.loadPackage("p.zip", pkgWith());
    s.goTo("plan");
    s.setPlan(emptyPlan({ creating: 1 }));
    expect(store.getState().plan).toBeDefined();
    store.getState().back();
    // The plan is a snapshot of the target; showing a stale one after a detour would be
    // worse than recomputing it.
    expect(store.getState().plan).toBeUndefined();
  });

  it("clears a previous run when a new package is loaded", () => {
    const s = store.getState();
    s.loadPackage("a.zip", pkgWith());
    s.appendLog("something");
    s.setResult({ installed: 1, skipped: 0, failed: [] });
    store.getState().loadPackage("b.zip", pkgWith());
    expect(store.getState().log).toEqual([]);
    expect(store.getState().result).toBeUndefined();
  });

  it("records a read failure without leaving a stale package behind", () => {
    const s = store.getState();
    s.loadPackage("good.zip", pkgWith());
    store.getState().failPackage("bad.zip", "nope");
    expect(store.getState().pkg).toBeUndefined();
    expect(store.getState().fileError).toBe("nope");
  });

  it("does not step past the last screen", () => {
    const s = store.getState();
    s.loadPackage("p.zip", pkgWith());
    for (let i = 0; i < 20; i++) store.getState().next();
    expect(store.getState().index).toBe(store.getState().steps.length - 1);
  });
});

describe("copy", () => {
  it("summarises a plan in plain numbers", () => {
    expect(planSummary(emptyPlan({ creating: 3, updating: 1 }))).toBe(
      "3 new items, 1 existing item updated.",
    );
    expect(planSummary(emptyPlan())).toBe("This package contains nothing that can be installed.");
  });

  it("always says the install cannot be undone", () => {
    expect(alwaysCaveats(emptyPlan()).join(" ")).toMatch(/cannot be undone/);
  });

  it("names missing templates as the reason items are blocked", () => {
    const one = alwaysCaveats(emptyPlan({ missingTemplates: ["{A}"] })).join(" ");
    expect(one).toMatch(/1 template referenced by this package is not/);
    expect(one).toMatch(/items using it are blocked/);
  });

  it("agrees in number when several templates are missing", () => {
    // A live run produced "7 templates ... is not on this environment".
    const many = alwaysCaveats(emptyPlan({ missingTemplates: ["{A}", "{B}"] })).join(" ");
    expect(many).toMatch(/2 templates referenced by this package are not/);
    expect(many).toMatch(/items using them are blocked/);
  });

  it("states what will not be applied, per source kind", () => {
    const text = notApplied(
      pkgWith({
        metadata: meta({ postStep: "My.PostStep" }),
        sources: [
          { uid: "1", name: "f", behaviour: { itemMode: "Undefined", itemMergeMode: "Undefined" }, kind: "files-static", entries: [], converterRoot: "" },
          { uid: "2", name: "a", behaviour: { itemMode: "Undefined", itemMergeMode: "Undefined" }, kind: "accounts", entries: [] },
        ],
      }),
    ).join(" ");
    expect(text).toMatch(/no server file system/);
    expect(text).toMatch(/Cloud Portal/);
    expect(text).toMatch(/My\.PostStep/);
  });

  it("says nothing when there is nothing to warn about", () => {
    expect(notApplied(pkgWith())).toEqual([]);
  });

  it("names media blobs as unapplied rather than implying they installed", () => {
    const text = notApplied(
      pkgWith({ blobs: [{ id: "{A}", data: new Uint8Array() }] }),
    ).join(" ");
    expect(text).toMatch(/missing media/);
  });

  it("reports a result without repeating one shared failure per item", () => {
    const failed = [1, 2, 3].map((n) => ({
      item: { id: "{" + n + "}" } as never,
      error: "same reason",
    }));
    expect(resultHeadline({ installed: 0, skipped: 0, failed })).toBe("The installation failed.");
    expect(resultDetail({ installed: 0, skipped: 0, failed })).toEqual(["same reason"]);
  });

  it("pluralises the success headline", () => {
    expect(resultHeadline({ installed: 1, skipped: 0, failed: [] })).toBe("Installed 1 item.");
    expect(resultHeadline({ installed: 2, skipped: 0, failed: [] })).toBe("Installed 2 items.");
  });

  it("falls back to a readable package title", () => {
    expect(packageTitle(pkgWith({ metadata: meta({ name: "  " }) }))).toBe("Unnamed package");
  });

  it("labels each disposition", () => {
    const item = {} as never;
    expect(dispositionLabel({ item, disposition: "create" })).toBe("Create");
    expect(dispositionLabel({ item, disposition: "update" })).toBe("Update");
    expect(dispositionLabel({ item, disposition: "blocked" })).toBe("Blocked");
  });
});

describe("file errors", () => {
  it("explains a zip that is not a Sitecore package", () => {
    const text = describeReadError(new Error("readPackage: outer zip has no package.zip"), "x.zip");
    expect(text).toMatch(/not a Sitecore package/);
    expect(text).toMatch(/Update packages/);
  });

  it("explains a corrupt archive", () => {
    expect(describeReadError(new Error("invalid signature"), "x.zip")).toMatch(/truncated or corrupt/);
  });

  it("passes an unknown message through rather than swallowing it", () => {
    expect(describeReadError(new Error("weird"), "x.zip")).toMatch(/weird/);
  });

  it("rejects an oversized file before reading it", () => {
    expect(tooLarge(MAX_PACKAGE_BYTES + 1, "big.zip")).toMatch(/larger than/);
    expect(tooLarge(1024, "small.zip")).toBeUndefined();
  });
});
