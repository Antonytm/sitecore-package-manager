"use client";

// The Installation Wizard.
//
// Mirrors the legacy flow documented in wiki/articles/installation-wizard-ui.md:
// select/upload → readme → verify → progress → result, with one deliberate addition. The
// legacy wizard committed from Verify; we insert "What will change" and commit from there,
// because Sitecore had an installation history and therefore an uninstall, and we have
// neither.
//
// This file is a renderer. Every decision — which steps exist, whether the forward button is
// enabled, what each sentence says — lives in ./lib/*.ts, because vitest is node-only over
// `src/**/*.test.ts` and a decision inside a component is a decision with no coverage.

import { useEffect, useRef } from "react";
import Link from "next/link";
import { mdiArrowLeft, mdiPackageVariantClosed } from "@mdi/js";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { EnvironmentBar } from "@/src/features/shared/EnvironmentBar";
import { Stepper } from "@/src/components/ui/stepper";
import { useSession, useSessionBootstrap } from "@/src/features/create/store/session";
import { installPackage } from "@/src/xmc/install";
import { planInstall } from "@/src/xmc/plan";
import { useCurrentStep, useWizard } from "./store/hooks";
import { wizardStore } from "./store/wizard";
import { canGoBack, forwardAction } from "./lib/steps";
import { packageTitle } from "./lib/describe";
import { SelectPackageStep } from "./steps/SelectPackageStep";
import { TextStep } from "./steps/TextStep";
import { VerifyStep } from "./steps/VerifyStep";
import { PlanStep } from "./steps/PlanStep";
import { InstallingStep } from "./steps/InstallingStep";
import { ResultStep } from "./steps/ResultStep";

export function InstallWizard() {
  useSessionBootstrap();
  const ctx = useSession((s) => s.ctx);
  const connectionError = useSession((s) => s.connectionError);

  const step = useCurrentStep();
  const steps = useWizard((s) => s.steps);
  const index = useWizard((s) => s.index);
  const pkg = useWizard((s) => s.pkg);
  const plan = useWizard((s) => s.plan);
  const busy = useWizard((s) => s.busy);

  const run = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => run.current?.abort(), []);

  const actions = wizardStore.getState;

  // Entering the plan step computes it; entering "installing" starts the install. Both are
  // driven by the step the user is on rather than by the button that got them there, so a
  // Back-then-Next never leaves a stale plan on screen.
  useEffect(() => {
    if (step.id === "plan" && ctx && !plan && !busy) {
      const controller = new AbortController();
      run.current = controller;
      actions().setBusy("Checking what this package will change…");
      planInstall(ctx, pkg!, { signal: controller.signal })
        .then((p) => actions().setPlan(p))
        .catch((e) => actions().failPlan(String(e instanceof Error ? e.message : e)))
        .finally(() => actions().setBusy(undefined));
    }

    if (step.id === "installing" && ctx && !busy && !actions().result) {
      const controller = new AbortController();
      run.current = controller;
      actions().setBusy("Installing…");
      installPackage(ctx, pkg!, {
        signal: controller.signal,
        onStep: (s, d) => actions().appendLog(d ? s + ": " + d : s),
        onProgress: (done, total) => actions().setProgress(done, total),
      })
        .then((result) => {
          actions().setResult(result);
          actions().next();
        })
        .catch((e) => {
          actions().setResult({
            installed: 0,
            skipped: 0,
            media: 0,
            failed: (pkg?.items ?? []).map((item) => ({
              item,
              error: String(e instanceof Error ? e.message : e),
            })),
          });
          actions().next();
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id, ctx]);

  const forward = forwardAction(steps, index, {
    hasPackage: Boolean(pkg),
    hasPlan: Boolean(plan),
    nothingToInstall: Boolean(plan && plan.creating + plan.updating === 0),
    busy: Boolean(busy),
  });

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-6">
        {/* One row, not three. The portal's own chrome already names the app above the
            iframe, so the back link, the title and the environment share a line — and the
            environment belongs here most of all, because this is the screen that writes. */}
        <div className="flex items-center gap-3">
          <Link
            href="/standalone-extension"
            className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:underline"
          >
            <Icon path={mdiArrowLeft} size="sm" /> Package Manager
          </Link>
          <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold">
            <Icon path={mdiPackageVariantClosed} size="sm" /> Install a package
          </h1>
          <EnvironmentBar className="ml-auto" />
        </div>
        {step.subtitle && <p className="mt-1 text-sm text-muted-foreground">{step.subtitle}</p>}
      </header>

      <Stepper
        className="mb-8"
        currentStep={index}
        steps={steps.map((s, i) => ({
          label: s.label,
          status: i < index ? "completed" : i === index ? "active" : "pending",
        }))}
      />

      {connectionError && (
        <p className="mb-4 text-sm text-danger-fg">
          Not connected to Sitecore: {String(connectionError)}
        </p>
      )}

      <section className="rounded-md border">
        {step.id === "select" && <SelectPackageStep />}
        {step.id === "readme" && <TextStep text={pkg?.metadata.readme ?? ""} />}
        {step.id === "license" && <TextStep text={pkg?.metadata.license ?? ""} />}
        {step.id === "verify" && <VerifyStep />}
        {step.id === "plan" && <PlanStep />}
        {step.id === "installing" && <InstallingStep />}
        {step.id === "result" && <ResultStep />}
      </section>

      <footer className="mt-6 flex items-center gap-2">
        {canGoBack(steps, index) && (
          <Button variant="outline" onClick={() => actions().back()} disabled={Boolean(busy)}>
            Back
          </Button>
        )}
        <div className="flex-1" />
        {step.id === "installing" && (
          <Button
            variant="outline"
            onClick={() => run.current?.abort()}
            title="Stops before the next step; a request already in flight still has to land."
          >
            Stop
          </Button>
        )}
        {forward && (
          <Button
            disabled={!forward.enabled}
            onClick={() => (step.id === "result" ? actions().reset() : actions().next())}
          >
            {forward.label}
          </Button>
        )}
      </footer>

      {pkg && step.id !== "select" && (
        <p className="mt-3 text-xs text-muted-foreground">Package: {packageTitle(pkg)}</p>
      )}
    </main>
  );
}
