// xmc/client — the ONLY place that knows the Marketplace SDK exists.
//
// A thin wrapper over the initialized ClientSDK (with the XMC module) so install.ts /
// export.ts / browse.ts work against item-shaped operations, not raw GraphQL. The concrete
// ClientSDK is created in utils/hooks/useMarketplaceClient.ts and handed in here.

import type { ApplicationContext, ClientSDK } from "@sitecore-marketplace-sdk/client";

/** Everything the adapter needs from the host. Narrow on purpose. */
export interface XmcContext {
  client: ClientSDK;
  /**
   * The `sitecoreContextId` forwarded on every XMC call.
   *
   * Optional in the type, required in practice. XMC calls are not sent to the network by
   * this app at all: the SDK's `_fetch` parses the Request URL, keeps only
   * `pathname + search + hash`, and posts that path to the Cloud Portal host, which
   * resolves the real Sitecore endpoint and attaches the user's token. The generated
   * client's `https://example.com/...` base URL is therefore a dummy origin that is
   * discarded — not something to configure.
   *
   * What the host actually routes on is this context id, which rides along in the query
   * string. Without it the host has no tenant to resolve and answers
   * `404 NotFound — No sitecore context`. See {@link contextIdOf}.
   */
  contextId?: string;
  /** Target database for item operations. The Authoring API is effectively `master`. */
  database?: string;
}

export function createXmcContext(
  client: ClientSDK,
  options: { contextId?: string; database?: string } = {},
): XmcContext {
  return { client, contextId: options.contextId, database: options.database ?? "master" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A context id is an opaque non-empty string; reject obvious non-values. */
function asContextId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Last-resort scan for a `contextId` (or a `context.preview`/`context.live`) anywhere in
 * the object graph.
 *
 * The SDK declares two different resource shapes — `ApplicationResourceContext` with a
 * nested `context: { live, preview }`, and `ApplicationMetadata.resources[]` with a flat
 * `contextId` — and both carry `[key: string]: any`, so the runtime shape is not pinned
 * down by the types. Rather than guess one and fail silently, look for either.
 */
function deepFindContextId(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !isRecord(value)) return undefined;

  const direct = asContextId(value.contextId);
  if (direct) return direct;

  if (isRecord(value.context)) {
    const preview = asContextId(value.context.preview) ?? asContextId(value.context.live);
    if (preview) return preview;
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        const found = deepFindContextId(entry, depth + 1);
        if (found) return found;
      }
    } else if (isRecord(child)) {
      const found = deepFindContextId(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Pick the context id out of `application.context`.
 *
 * Checks the documented locations first — `resourceAccess` (current) then `resources`
 * (deprecated), preferring the preview context since authoring edits the editing surface
 * rather than the published one — then falls back to a scan.
 *
 * Returns undefined when the app has no resource attached at all, which is a real
 * configuration case: the app registration needs an XM Cloud resource for the pickers to
 * have anything to talk to.
 */
export function contextIdOf(appContext: ApplicationContext | undefined): string | undefined {
  if (!appContext) return undefined;

  const lists = [appContext.resourceAccess, appContext.resources];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const resource of list) {
      if (!isRecord(resource)) continue;
      const nested = isRecord(resource.context)
        ? asContextId(resource.context.preview) ?? asContextId(resource.context.live)
        : undefined;
      const found = nested ?? asContextId(resource.contextId);
      if (found) return found;
    }
  }

  return deepFindContextId(appContext);
}
