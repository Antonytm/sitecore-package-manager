"use client";

// features/create — the Create package experience.
//
// Mirrors the legacy Package Designer documented in
// wiki/articles/package-designer-ui.md: metadata → item sources (static / dynamic) →
// installation options → generate zip. Drives xmc.exportSource() then core.writePackage().

export function PackageDesigner() {
  // TODO: metadata form + source builders wired to xmc/export + core/writePackage.
  return (
    <section>
      <h2>Create a package</h2>
      <p>Select items and export them as a classic-format package .zip.</p>
    </section>
  );
}
