import Link from "next/link";

/**
 * The public landing route.
 *
 * Plain HTML rather than components on purpose — this page renders outside the Cloud
 * Portal and does not touch the Marketplace SDK. It does still need utility classes for
 * its type scale: Tailwind's preflight resets heading sizes and list markers, so nothing
 * is styled unless a class says so.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-6 py-12">
      <h1 className="text-2xl font-semibold">Sitecore Package Manager</h1>

      <p>
        A Sitecore Marketplace application that installs and creates classic-format
        Sitecore packages (items) for SitecoreAI / XM Cloud — a replacement for the sunset
        Package Manager and Package Installation Wizard.
      </p>

      <p>
        This page is the public landing route. Inside the Sitecore Cloud Portal the app
        runs through its registered extension point:
      </p>

      <ul className="list-disc space-y-1 pl-6">
        <li>
          <Link
            href="/standalone-extension"
            className="text-primary underline underline-offset-4"
          >
            Standalone extension
          </Link>{" "}
          — the full package-manager UI.
        </li>
        <li>
          <Link
            href="/standalone-extension/create"
            className="text-primary underline underline-offset-4"
          >
            Package Designer
          </Link>{" "}
          — build a package definition.
        </li>
      </ul>

      <p className="text-sm text-muted-foreground">
        Built with the Sitecore Marketplace SDK (
        <code>@sitecore-marketplace-sdk/client</code> +{" "}
        <code>@sitecore-marketplace-sdk/xmc</code>). See <code>README.md</code> and the{" "}
        <code>wiki/</code> for the package-format reference.
      </p>
    </main>
  );
}
