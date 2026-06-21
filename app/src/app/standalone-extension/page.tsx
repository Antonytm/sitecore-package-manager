"use client";

import { useState, useEffect } from "react";
import type { ApplicationContext } from "@sitecore-marketplace-sdk/client";
import { useMarketplaceClient } from "@/src/utils/hooks/useMarketplaceClient";

/**
 * Standalone extension — the main entry point for the Sitecore Package Manager app
 * when launched from the Sitecore Cloud Portal.
 *
 * It initializes the Marketplace client, reads the application context, and surfaces
 * the two core capabilities. The actual item read/write will go through the XMC module
 * (XM Cloud Authoring/Management API); see wiki/articles/item-serialization.md and
 * wiki/articles/package-installation.md for what each flow must do.
 */
function StandaloneExtension() {
  const { client, error, isInitialized } = useMarketplaceClient();
  const [appContext, setAppContext] = useState<ApplicationContext>();

  useEffect(() => {
    if (!error && isInitialized && client) {
      client
        .query("application.context")
        .then((res) => {
          setAppContext(res.data);
        })
        .catch((err) => {
          console.error("Error retrieving application.context:", err);
        });
    } else if (error) {
      console.error("Error initializing Marketplace client:", error);
    }
  }, [client, error, isInitialized]);

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <h1>Sitecore Package Manager</h1>
      <p style={{ color: "#555" }}>
        Install and create classic-format Sitecore packages (items) on SitecoreAI / XM
        Cloud.
      </p>

      {!isInitialized && !error && <p>Connecting to Sitecore…</p>}
      {error && <p style={{ color: "red" }}>Error: {String(error)}</p>}

      {isInitialized && (
        <>
          <section style={{ display: "flex", gap: 16, margin: "1.5rem 0" }}>
            <article style={card}>
              <h2 style={{ marginTop: 0 }}>Install a package</h2>
              <p>Upload a classic Sitecore package and apply its items to the site.</p>
              {/* TODO: read items/** + properties/items/** from the package and
                  apply via the XMC module. See wiki/articles/package-installation.md */}
              <button disabled>Coming soon</button>
            </article>

            <article style={card}>
              <h2 style={{ marginTop: 0 }}>Create a package</h2>
              <p>Select items and export them as a classic-format package .zip.</p>
              {/* TODO: read items via the XMC module and emit the two-layer zip.
                  See wiki/articles/package-creation.md */}
              <button disabled>Coming soon</button>
            </article>
          </section>

          {appContext && (
            <details>
              <summary>Application context</summary>
              <ul>
                <li>
                  <strong>Name:</strong> {appContext.name}
                </li>
                <li>
                  <strong>ID:</strong> {appContext.id}
                </li>
                <li>
                  <strong>Installation ID:</strong> {appContext.installationId}
                </li>
                <li>
                  <strong>Type:</strong> {appContext.type}
                </li>
              </ul>
            </details>
          )}
        </>
      )}
    </main>
  );
}

const card: React.CSSProperties = {
  flex: 1,
  border: "1px solid #e2e2e2",
  borderRadius: 8,
  padding: "1rem 1.25rem",
};

export default StandaloneExtension;
