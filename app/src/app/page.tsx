import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "3rem 1.5rem" }}>
      <h1>Sitecore Package Manager</h1>
      <p>
        A Sitecore Marketplace application that installs and creates classic-format
        Sitecore packages (items) for SitecoreAI / XM Cloud — a replacement for the
        sunset Package Manager and Package Installation Wizard.
      </p>
      <p>
        This page is the public landing route. Inside the Sitecore Cloud Portal the app
        runs through its registered extension point:
      </p>
      <ul>
        <li>
          <Link href="/standalone-extension">Standalone extension</Link> — the full
          package-manager UI.
        </li>
      </ul>
      <p style={{ color: "#666", fontSize: 14 }}>
        Built with the Sitecore Marketplace SDK (<code>@sitecore-marketplace-sdk/client</code>{" "}
        + <code>@sitecore-marketplace-sdk/xmc</code>). See <code>README.md</code> and the
        <code> wiki/</code> for the package-format reference.
      </p>
    </main>
  );
}
