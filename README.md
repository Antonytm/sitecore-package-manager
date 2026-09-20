# Sitecore Package Manager

[![Netlify Status](https://api.netlify.com/api/v1/badges/9028cf56-caf3-4e83-9795-0a868f60ec10/deploy-status)](https://app.netlify.com/projects/sitecore-package-manager/deploys)

A **Sitecore Marketplace application** that installs and creates classic-format Sitecore
packages — focused on **items** — for **SitecoreAI / XM Cloud**. It replaces the sunset
**Sitecore Package Manager** and **Package Installation Wizard**.

- **Install**: apply the items from a classic Sitecore package `.zip` to a site.
- **Create**: export selected items as a classic-format package `.zip` (byte-compatible).

## Repo layout

| Path | Contents |
|---|---|
| [`app/`](app/README.md) | The Next.js Marketplace app — **start here** to run, develop or deploy it |
| [`wiki/`](wiki/INDEX.md) | The reverse-engineered package-format reference the app is built from |
| `files/` | Sample packages and decompiled assemblies (gitignored, local only) |

```bash
cd app
npm install
npm run dev          # http://localhost:3000
```

See [`app/README.md`](app/README.md) for prerequisites, the portal registration steps and the
app's own layout, and [`app/src/ARCHITECTURE.md`](app/src/ARCHITECTURE.md) for the module
boundaries.
