// /standalone-extension/install — the Installation Wizard.
//
// Mirrors ../create/page.tsx: the route is a thin shell and the feature component carries
// the "use client" directive itself.

import { InstallWizard } from "@/src/features/install/InstallWizard";

export default function InstallPage() {
  return <InstallWizard />;
}
