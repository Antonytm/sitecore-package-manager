# Sitecore Marketplace App (this project's shell)

How this repo is set up as a Sitecore Marketplace application, following Sitecore's
recommended approach. This is the runtime/host side; what the app *does* with packages is in
[[package-installation]] / [[package-creation]] / [[item-serialization]].

## What a Marketplace app is

A Sitecore **Marketplace custom app** is a standalone web app that the **Sitecore Cloud Portal**
embeds (in an iframe) and talks to via the browser **PostMessage** API. There is no Sitecore
server-side plugin model — the app is just a hosted web app that uses the **Marketplace SDK** to
request data/actions from the host. Apps surface through **extension points**: Custom Field,
Dashboard Widget, Fullscreen, Pages Context Panel, and **Standalone**.

## Recommended stack (what we used)

Mirrors the official [`Sitecore/marketplace-starter`](https://github.com/Sitecore/marketplace-starter)
(`xmcloud-extension-starter`):

- **Next.js 15** (App Router) + **React 19** + **TypeScript 5.9**
- **`@sitecore-marketplace-sdk/client`** `^0.2.0` — the PostMessage bridge / `ClientSDK.init`
- **`@sitecore-marketplace-sdk/xmc`** `^0.2.0` — XM Cloud Authoring/Management API module
- Node **18.18+** (works on 24.x), npm **10+**

Other supported ways to start (not used here): the `npx shadcn@latest add
https://blok.sitecore.com/r/marketplace/next/quickstart.json` CLI (client-side) or its
`quickstart-with-custom-auth.json` variant (full-stack), or manual SDK init in a Vite/React app.

## Decisions for this project

- **Extension point: Standalone** — a package manager is a full tool, so it mounts as a
  top-level app at `/standalone-extension` rather than a field/widget.
- **Auth: client-side (built-in)** — simplest recommended starting point. If we later need
  server-side calls (e.g. heavy package processing), switch to the full-stack/custom-auth
  scaffold (Auth0 client id, `--experimental-https`, custom host).
- **Location: `app/` subfolder** — the Next.js app is isolated in its own folder so
  the repo root stays clean (`wiki/`, `files/`, `.claude/` live at root). Run npm commands from
  `app/`.

## Project layout

```
app/                                  # the Next.js app (run npm here)
  src/
    app/
      layout.tsx                      # app metadata
      page.tsx                        # public landing route (/)
      standalone-extension/page.tsx   # main UI, the registered extension point
    utils/hooks/useMarketplaceClient.ts # ClientSDK.init({ target: window.parent, modules: [XMC] })
  next.config.ts  tsconfig.json  eslint.config.mjs  package.json
wiki/   files/   (repo root)
```

`useMarketplaceClient` (from the starter) initializes a singleton `ClientSDK` with the `XMC`
module registered, with retry/loading state. Pages call `client.query("application.context")`
and (later) XMC operations.

## How items flow (the point of the app)

- **Install**: read `items/**` + `properties/items/**` from a package ([[item-serialization]]),
  order parents-first ([[package-installation]]), encode them as a `.raif` chunk
  ([[raif-frame-grammar]]) and push it through the **XMC** module's content-transfer operations
  ([[content-transfer-api]]). The Authoring API cannot be used for this — it has no way to create
  an item at a chosen id — so identity is preserved by the transfer format instead
  ([[content-transfer-install]]).
- **Create**: read items via XMC and emit the two-layer package zip ([[package-creation]],
  [[package-format]]).

`files/`, `security/`, and post-steps are out of scope on SitecoreAI (no file system; different
security model) — see [[security-accounts]].

## Run / register

`npm install` → `npm run dev` (`http://localhost:3000`; `/standalone-extension` is the app).
Live host data only appears when embedded in the Cloud Portal (PostMessage), which generally
needs HTTPS (`next dev --experimental-https`). Register a **Standalone** extension in the Cloud
Portal pointing at the deployed URL + `/standalone-extension`, then install into an XM Cloud org.
See `README.md`.

## Open questions to resolve next

- ~~Exact XMC module operations for item create/update~~ — settled: Authoring mutations cannot
  assign item ids, so install goes through `xmc.contentTransfer.*` ([[content-transfer-api]]).
  Media/blob chunks remain open ([[raif-frame-grammar]]).
- Whether package *processing* (zip parse/build) runs client-side or needs a server route.
- Media/blob round-trip on XM Cloud (the `blob/` gap from [[item-serialization]]).

## Sources

- [Marketplace getting started](https://developers.sitecore.com/learn/getting-started/marketplace),
  [Register a custom app](https://developers.sitecore.com/learn/getting-started/marketplace/marketplace-register-app),
  [SDK quick start](https://doc.sitecore.com/mp/en/developers/sdk/latest/sitecore-marketplace-sdk/quick-start.html),
  [marketplace-starter](https://github.com/Sitecore/marketplace-starter),
  [marketplace-sdk](https://github.com/Sitecore/marketplace-sdk), fetched 2026-06-21.
- Scaffolded in this repo (`package.json`, `src/`), 2026-06-21.
