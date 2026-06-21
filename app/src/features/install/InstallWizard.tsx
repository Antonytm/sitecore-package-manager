"use client";

// features/install — the Install package experience.
//
// Mirrors the legacy Installation Wizard flow documented in
// wiki/articles/installation-wizard-ui.md: select/upload → readme → verify →
// progress → ★ collision dialog (Overwrite/Merge/Skip, Apply / Apply to all / Abort)
// → result. Drives core.readPackage() then xmc.installPackage().

export function InstallWizard() {
  // TODO: wizard steps + collision dialog wired to xmc/install + xmc/collisions.
  return (
    <section>
      <h2>Install a package</h2>
      <p>Upload a classic Sitecore package and apply its items to the site.</p>
    </section>
  );
}
