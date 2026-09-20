// contextIdOf is load-bearing: the XMC module ships a placeholder base URL and relies on
// the host to route each call to the right tenant, using this id. Get it wrong and every
// picker fails with `404 NotFound — No sitecore context`, which is what happened when this
// only looked at `resourceAccess[0].context.preview`.
//
// The SDK declares two different resource shapes and both carry an index signature, so the
// runtime payload is not pinned down by the types. These cases lock in both.

import { describe, it, expect } from "vitest";
import { contextIdOf } from "../client";
import type { ApplicationContext } from "@sitecore-marketplace-sdk/client";

const asContext = (value: unknown) => value as ApplicationContext;

describe("contextIdOf", () => {
  it("reads the nested preview context from resourceAccess", () => {
    expect(
      contextIdOf(
        asContext({
          resourceAccess: [
            { resourceId: "r", tenantId: "t", context: { live: "live-1", preview: "preview-1" } },
          ],
        }),
      ),
    ).toBe("preview-1");
  });

  it("prefers preview over live, since authoring edits the editing surface", () => {
    expect(
      contextIdOf(
        asContext({ resourceAccess: [{ context: { live: "live-1", preview: "preview-1" } }] }),
      ),
    ).toBe("preview-1");
  });

  it("falls back to live when only that is present", () => {
    expect(contextIdOf(asContext({ resourceAccess: [{ context: { live: "live-1" } }] }))).toBe(
      "live-1",
    );
  });

  it("reads the FLAT contextId shape used by ApplicationMetadata.resources", () => {
    expect(
      contextIdOf(
        asContext({ resources: [{ contextId: "ctx-1", tenantId: "t", tenantName: "n" }] }),
      ),
    ).toBe("ctx-1");
  });

  it("prefers resourceAccess over the deprecated resources list", () => {
    expect(
      contextIdOf(
        asContext({
          resourceAccess: [{ context: { preview: "from-access" } }],
          resources: [{ contextId: "from-resources" }],
        }),
      ),
    ).toBe("from-access");
  });

  it("skips resources that carry no usable id", () => {
    expect(
      contextIdOf(
        asContext({
          resourceAccess: [{ resourceId: "r" }, { context: { preview: "preview-2" } }],
        }),
      ),
    ).toBe("preview-2");
  });

  it("finds a context id nested somewhere unexpected", () => {
    expect(contextIdOf(asContext({ tenant: { environment: { contextId: "deep-1" } } }))).toBe(
      "deep-1",
    );
  });

  it("treats empty and blank strings as absent", () => {
    expect(contextIdOf(asContext({ resourceAccess: [{ context: { preview: "  " } }] }))).toBeUndefined();
    expect(contextIdOf(asContext({ resources: [{ contextId: "" }] }))).toBeUndefined();
  });

  it("returns undefined when there is no resource at all", () => {
    expect(contextIdOf(undefined)).toBeUndefined();
    expect(contextIdOf(asContext({ name: "app", id: "x" }))).toBeUndefined();
    expect(contextIdOf(asContext({ resourceAccess: [] }))).toBeUndefined();
  });
});
