// The response unwrap is the narrowest, highest-consequence code in the XMC layer.
//
// The SDK returns a hey-api RequestResult whose `.data` is the parsed body, which is
// itself the GraphQL envelope `{ data, errors }`. Both levels carry a `data` key, so an
// unwrap that stops at the first one returns the ENVELOPE rather than the payload — and
// every field read off it is `undefined`. That failure is silent and actively
// misleading: a successful item lookup is indistinguishable from "item not found".
//
// These cases pin the descent at both shapes and make sure a real payload survives it.

import { describe, it, expect, vi } from "vitest";
import { authoringGraphql, AuthoringError } from "../authoring";
import type { XmcContext } from "../client";
import type { ClientSDK } from "@sitecore-marketplace-sdk/client";

interface MutateCall {
  operation: string;
  body: { query: string; variables: Record<string, unknown> };
  query: Record<string, unknown>;
}

/** A client that answers every mutate with `response` and records what it was asked. */
function fakeCtx(response: unknown) {
  const calls: MutateCall[] = [];
  const client = {
    mutate: async (operation: string, options: { params: { body: MutateCall["body"]; query: MutateCall["query"] } }) => {
      calls.push({ operation, body: options.params.body, query: options.params.query });
      return response;
    },
  } as unknown as ClientSDK;
  return { ctx: { client, contextId: "ctx-1", database: "master" } as XmcContext, calls };
}

const ITEM = { itemId: "513a5371aa834db2a559e5687586b400", name: "sitecore", path: "/sitecore" };

describe("authoringGraphql — response unwrapping", () => {
  it("returns the PAYLOAD, not the envelope, for the SDK's two-level shape", async () => {
    const { ctx } = fakeCtx({ data: { data: { item: ITEM } } });
    const data = await authoringGraphql<{ item: typeof ITEM }>(ctx, "query { item { name } }");
    expect(data.item).toEqual(ITEM);
  });

  it("does not report a found item as missing (the regression)", async () => {
    const { ctx } = fakeCtx({ data: { data: { item: ITEM } } });
    const data = await authoringGraphql<{ item: unknown }>(ctx, "query { item { name } }");
    // The bug made this `undefined`, which the tree renders as "Could not find /sitecore".
    expect(data.item).not.toBeUndefined();
  });

  it("still unwraps a bare envelope, if the SDK ever hands one back directly", async () => {
    const { ctx } = fakeCtx({ data: { item: ITEM } });
    const data = await authoringGraphql<{ item: typeof ITEM }>(ctx, "query { item { name } }");
    expect(data.item).toEqual(ITEM);
  });

  it("preserves a genuine null item rather than inventing one", async () => {
    const { ctx } = fakeCtx({ data: { data: { item: null } } });
    const data = await authoringGraphql<{ item: unknown }>(ctx, "query { item { name } }");
    expect(data.item).toBeNull();
  });

  it("keeps a payload field that is itself called `data`", async () => {
    const { ctx } = fakeCtx({ data: { data: { item: { data: { nested: 1 } } } } });
    const data = await authoringGraphql<{ item: { data: unknown } }>(ctx, "query { item { data } }");
    expect(data.item.data).toEqual({ nested: 1 });
  });
});

describe("authoringGraphql — failures", () => {
  it("throws the first GraphQL error from the inner envelope", async () => {
    const { ctx } = fakeCtx({
      data: { data: null, errors: [{ message: "Cannot query field 'nope'" }] },
    });
    await expect(authoringGraphql(ctx, "query { nope }")).rejects.toThrow(
      /Cannot query field 'nope'/,
    );
  });

  it("surfaces RFC 7807 problem details instead of a bare 'no data'", async () => {
    const { ctx } = fakeCtx({
      error: { status: 404, title: "NotFound", detail: "No sitecore context" },
    });
    await expect(authoringGraphql(ctx, "query { item { name } }")).rejects.toThrow(
      /404 — NotFound — No sitecore context/,
    );
  });

  it("calls out a missing context id, the one cause the caller can act on", async () => {
    const { ctx } = fakeCtx({ error: { status: 404, title: "NotFound" } });
    // Spread rather than a default parameter: passing `undefined` would take the default.
    const noContext: XmcContext = { ...ctx, contextId: undefined };
    await expect(authoringGraphql(noContext, "query { item { name } }")).rejects.toThrow(
      /No Sitecore context id was available/,
    );
  });

  it("reports an unreadable shape as an AuthoringError carrying that shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = fakeCtx({ unexpected: true });
    await expect(authoringGraphql(ctx, "query { item { name } }")).rejects.toBeInstanceOf(
      AuthoringError,
    );
    vi.restoreAllMocks();
  });
});

describe("authoringGraphql — request", () => {
  it("goes through mutate, since authoring.graphql is on the MutationMap", async () => {
    const { ctx, calls } = fakeCtx({ data: { data: { item: ITEM } } });
    await authoringGraphql(ctx, "query Q { item { name } }", { path: "/sitecore" });
    expect(calls[0].operation).toBe("xmc.authoring.graphql");
  });

  it("forwards the context id as sitecoreContextId, which is how the host routes", async () => {
    const { ctx, calls } = fakeCtx({ data: { data: { item: ITEM } } });
    await authoringGraphql(ctx, "query Q { item { name } }");
    expect(calls[0].query).toEqual({ sitecoreContextId: "ctx-1" });
  });

  it("sends the query and variables verbatim", async () => {
    const { ctx, calls } = fakeCtx({ data: { data: { item: ITEM } } });
    await authoringGraphql(ctx, "query Q { item { name } }", { path: "/sitecore" });
    expect(calls[0].body).toEqual({
      query: "query Q { item { name } }",
      variables: { path: "/sitecore" },
    });
  });
});
