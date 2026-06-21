# Project Overview

## Goal

Build a **Sitecore Marketplace application** that replaces the soon-to-be-sunset **Sitecore Package Manager** and **Package Installation Wizard** for **Sitecore AI (SitecoreAI / XM Cloud era)**.

The app must:

1. **Install packages** sourced from Sitecore XM/XP using the **exact same package format** the legacy tools used.
2. **Create packages** in the **exact same format** as the legacy tools, so packages remain interchangeable with classic Sitecore XM/XP.

Format compatibility (read *and* write) is the core constraint — see [[package-format]].

## Why this exists

Sitecore is sunsetting the classic Sitecore Package Manager and the Package Installation Wizard as part of the move to Sitecore AI. Customers with existing `.zip`/`.update` packages and established packaging workflows need a path forward that does not break compatibility with the legacy format. This project delivers that as a Marketplace app.

## Open questions / decisions to capture

These are gaps to fill as the project progresses (drop research into `wiki/inbox/` and run `/wiki-compile`):

- Exact internal structure of the legacy Sitecore package `.zip` (installer/metadata/items/files layout, blob handling). See [[package-format]].
- Which Sitecore APIs the Marketplace app uses to read items/templates/media from XM/XP and to apply a package. See [[sitecore-marketplace-app]].
- Authentication / hosting model for a Sitecore Marketplace app (SDK, extension points, permissions). See [[sitecore-marketplace-app]].
- Target Sitecore versions / editions in scope (XM, XP, XM Cloud).

## Sources

- Project framing from the maintainer, 2026-06-21.
