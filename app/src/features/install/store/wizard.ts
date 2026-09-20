// The install wizard's document state.
//
// Vanilla zustand and React-free, exactly as features/create/store/designer.ts is, so the
// whole reducer surface is testable under vitest's node environment. The React binding lives
// in ./hooks.ts.
//
// Deliberately NOT part of session.ts's ActiveDialog union: that models the designer's
// modals, and this is a separate surface on its own route whose lifetime is the run.

import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import type { PackageModel } from "@/src/core/model";
import type { InstallResult } from "@/src/xmc/install";
import type { InstallPlan } from "@/src/xmc/plan";
import { stepsFor, type Step, type StepId } from "../lib/steps";

export interface WizardState {
  /** The chosen file's name, for display. */
  fileName?: string;
  pkg?: PackageModel;
  /** Parse or read failure for the chosen file. */
  fileError?: string;

  steps: Step[];
  index: number;

  plan?: InstallPlan;
  planError?: string;

  /** A message while something long-running is happening, not a boolean. */
  busy?: string;
  progress?: { done: number; total: number };

  result?: InstallResult;
  log: string[];
}

export interface WizardActions {
  loadPackage(fileName: string, pkg: PackageModel): void;
  failPackage(fileName: string, error: string): void;
  clearPackage(): void;

  next(): void;
  back(): void;
  goTo(id: StepId): void;

  setBusy(busy?: string): void;
  setProgress(done: number, total: number): void;
  appendLog(line: string): void;

  setPlan(plan: InstallPlan): void;
  clearPlan(): void;
  failPlan(error: string): void;

  setResult(result: InstallResult): void;
  reset(): void;
}

export type WizardStore = WizardState & WizardActions;

const initial = (): WizardState => ({
  steps: stepsFor(undefined),
  index: 0,
  log: [],
});

export function createWizardStore() {
  return createStore<WizardStore>()(
    subscribeWithSelector((set, get) => ({
      ...initial(),

      loadPackage(fileName, pkg) {
        set({
          fileName,
          pkg,
          fileError: undefined,
          // The step list depends on the package: no readme, no readme screen.
          steps: stepsFor(pkg.metadata),
          index: 0,
          plan: undefined,
          planError: undefined,
          result: undefined,
          log: [],
        });
      },

      failPackage(fileName, error) {
        set({ fileName, pkg: undefined, fileError: error, steps: stepsFor(undefined), index: 0 });
      },

      clearPackage() {
        set(initial());
      },

      next() {
        const { index, steps } = get();
        set({ index: Math.min(index + 1, steps.length - 1) });
      },

      back() {
        const { index, steps } = get();
        const target = Math.max(index - 1, 0);
        // Stepping back off the plan discards it; it is a snapshot and must be recomputed
        // rather than shown stale next time round.
        const leavingPlan = steps[index]?.id === "plan";
        set({ index: target, ...(leavingPlan ? { plan: undefined, planError: undefined } : {}) });
      },

      goTo(id) {
        const at = get().steps.findIndex((s) => s.id === id);
        if (at >= 0) set({ index: at });
      },

      setBusy(busy) {
        set({ busy, ...(busy ? {} : { progress: undefined }) });
      },

      setProgress(done, total) {
        set({ progress: { done, total } });
      },

      appendLog(line) {
        set({ log: [...get().log, line] });
      },

      setPlan(plan) {
        set({ plan, planError: undefined });
      },

      clearPlan() {
        // The plan is a snapshot; recompute rather than re-show it after a failed install.
        set({ plan: undefined, planError: undefined, result: undefined, log: [] });
      },

      failPlan(error) {
        set({ plan: undefined, planError: error });
      },

      setResult(result) {
        set({ result, busy: undefined });
      },

      reset() {
        set(initial());
      },
    })),
  );
}

export const wizardStore = createWizardStore();
