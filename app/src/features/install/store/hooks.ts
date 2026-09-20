"use client";

// The React binding for the wizard store.
//
// Kept separate so ./wizard itself imports no React — that is what lets its whole reducer
// surface be tested under vitest's node environment. Mirrors create/store/hooks.ts.

import { useStore } from "zustand";
import { wizardStore, type WizardStore } from "./wizard";
import { stepAt } from "../lib/steps";

/**
 * Subscribe to a slice of the wizard.
 *
 * Selectors that build a new object or array each call need `useShallow`
 * (`zustand/react/shallow`) — v5 dropped the equality-function argument.
 */
export function useWizard<T>(selector: (state: WizardStore) => T): T {
  return useStore(wizardStore, selector);
}

/** The step currently on screen. */
export function useCurrentStep() {
  return useStore(wizardStore, (s) => stepAt(s.steps, s.index));
}

export const wizard = wizardStore.getState;
