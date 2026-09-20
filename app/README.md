# Sitecore Package Manager

[![Netlify Status](https://api.netlify.com/api/v1/badges/9028cf56-caf3-4e83-9795-0a868f60ec10/deploy-status)](https://app.netlify.com/projects/sitecore-package-manager/deploys)

A **Sitecore Marketplace application** that installs and creates classic-format Sitecore
packages — focused on **items** — for **SitecoreAI / XM Cloud**. It replaces the sunset
**Sitecore Package Manager** and **Package Installation Wizard**.

- **Install**: apply the items from a classic Sitecore package `.zip` to a site.
- **Create**: export selected items as a classic-format package `.zip` (byte-compatible).

> This app lives in `app/` within the repo. Run all commands below from that
> folder. The reverse-engineered package-format reference lives in the repo-root
> [`wiki/`](../wiki/INDEX.md) (see `package-format`, `item-serialization`, `package-creation`,
> `package-installation`).

## Stack

Built per Sitecore's recommended approach (the official
[`marketplace-starter`](https://github.com/Sitecore/marketplace-starter) layout):

- **Next.js 15** (App Router) + **React 19** + **TypeScript**
- **Sitecore Marketplace SDK** — `@sitecore-marketplace-sdk/client` (PostMessage bridge to
  the host portal) and `@sitecore-marketplace-sdk/xmc` (XM Cloud Authoring/Management APIs)
- Extension point: **Standalone** (`/standalone-extension`) — the full app UI

## Prerequisites

- Node.js **18.18+** (works on 24.x), npm **10+**

## Develop

```bash
npm install
npm run dev          # http://localhost:3000
```

- Landing page: `/` · App entry (loaded by the portal): `/standalone-extension`
- The Marketplace SDK talks to the host via the browser `postMessage` API, so the app only
  shows live data when embedded in the Sitecore Cloud Portal. To test inside the portal you
  generally need to serve over HTTPS — run dev with a custom https host, e.g.:

  ```bash
  next dev --experimental-https --hostname localhost
  ```

## Register the app (Sitecore Cloud Portal)

1. In the Cloud Portal → Marketplace, create a **custom app**.
2. Add a **Standalone** extension pointing at your deployed URL + `/standalone-extension`
   (or your local https URL while developing).
3. Install the app into an XM Cloud organization/environment and open it.

See the Sitecore docs:
[Marketplace getting started](https://developers.sitecore.com/learn/getting-started/marketplace)
· [Register a custom app](https://developers.sitecore.com/learn/getting-started/marketplace/marketplace-register-app)
· [SDK quick start](https://doc.sitecore.com/mp/en/developers/sdk/latest/sitecore-marketplace-sdk/quick-start.html)

## Layout

```
app/                                 # this Next.js app
  src/
    app/
      layout.tsx                     # root layout (app metadata)
      page.tsx                       # public landing route
      standalone-extension/page.tsx  # main app UI (registered extension point)
    utils/hooks/useMarketplaceClient.ts  # SDK init hook (client + XMC module)
wiki/                                # (repo root) reverse-engineered package-format docs
files/                               # (repo root, gitignored) sample packages + assemblies
```
