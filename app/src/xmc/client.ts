// xmc/client — the ONLY place that knows the Marketplace SDK exists.
//
// A thin wrapper over the initialized ClientSDK (with the XMC module) so install.ts /
// export.ts work against item-shaped operations, not raw GraphQL. The concrete ClientSDK
// is created in utils/hooks/useMarketplaceClient.ts and handed in here.

import type { ClientSDK } from "@sitecore-marketplace-sdk/client";

/** Everything the adapter needs from the host. Narrow on purpose. */
export interface XmcContext {
  client: ClientSDK;
  /** Target site/database context for item operations. */
  database?: string;
}

export function createXmcContext(client: ClientSDK, database?: string): XmcContext {
  return { client, database };
}
