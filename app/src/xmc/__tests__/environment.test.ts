// Which project and environment the app is pointed at.
//
// The fixtures are the real payload a live standalone extension received, trimmed. Two of
// its properties are the whole reason this module is not a one-liner: `tenantName` is null,
// and `host.state` answers despite being typed `null` for `appType: 'portal'`.

import { describe, it, expect } from "vitest";
import type { ApplicationContext } from "@sitecore-marketplace-sdk/client";
import { describeEnvironment, narrowHostState } from "../environment";

/** As observed: tenantName null, tenantDisplayName already formatted "<project> / <env>". */
const appContext = (over: Record<string, unknown> = {}): ApplicationContext =>
  ({
    id: "e2c127c6-ae9e-4201-81e8-3e3f1ecc37a4",
    url: "http://localhost:3000/standalone-extension",
    name: "Package Manager",
    organizationId: "org_CoF1J6ejrMTWQ5Oy",
    resources: [
      {
        resourceId: "xmcloud",
        tenantId: "2c5b885b-8b17-4148-8e2c-08df0e9901d4",
        tenantName: null,
        tenantDisplayName: "Packages (Anton Tishchenko) / dev",
        context: { preview: "3em1S0rnRKgcum44eoUKgC", live: "1tgh9hBpEky4M6Wuqc46ca" },
      },
    ],
    ...over,
  }) as unknown as ApplicationContext;

const rawHostState = {
  organizationId: "org_CoF1J6ejrMTWQ5Oy",
  xmCloudTenantInfo: {
    cdpEmbeddedTenantId: "06d71651-b63f-435d-fec8-08dbca59803e",
    customerEnvironmentType: "nonprod",
    environmentId: "5NCRGnlZgt0jMycNvtULOK",
    environmentName: "dev",
    projectId: "2A8pCmlvGeW9cihLx07iUB",
    projectName: "Packages (Anton Tishchenko)",
    regionCode: "euw",
  },
  userInfo: {
    name: "someone@example.test",
    email: "someone@example.test",
    sub: "auth0|0123456789",
    picture: "https://s.gravatar.com/avatar/abc",
  },
};

describe("narrowing host.state", () => {
  it("keeps the environment identity", () => {
    expect(narrowHostState(rawHostState)).toEqual({
      organizationId: "org_CoF1J6ejrMTWQ5Oy",
      projectId: "2A8pCmlvGeW9cihLx07iUB",
      projectName: "Packages (Anton Tishchenko)",
      environmentId: "5NCRGnlZgt0jMycNvtULOK",
      environmentName: "dev",
      environmentType: "nonprod",
      regionCode: "euw",
    });
  });

  it("drops userInfo entirely", () => {
    // host.state carries the signed-in user's email, name and auth subject. The app has no
    // use for any of it, and anything kept here can end up in a render or a copied
    // diagnostic. Narrowing at the boundary is what keeps that impossible rather than
    // merely unintended.
    const narrowed = narrowHostState(rawHostState);
    expect(narrowed).not.toHaveProperty("userInfo");
    expect(JSON.stringify(narrowed)).not.toMatch(/example\.test|auth0|gravatar/);
  });

  it("does not carry over fields the host adds later", () => {
    const narrowed = narrowHostState({
      ...rawHostState,
      somethingNew: "surprise",
      xmCloudTenantInfo: { ...rawHostState.xmCloudTenantInfo, secretToken: "shhh" },
    });
    expect(JSON.stringify(narrowed)).not.toMatch(/surprise|shhh/);
  });

  it.each([null, undefined, "portal", 42, {}])("answers undefined for %o", (raw) => {
    expect(narrowHostState(raw)).toBeUndefined();
  });
});

describe("resolving the label", () => {
  it("prefers host.state, which separates the pair at the source", () => {
    const info = describeEnvironment(appContext(), narrowHostState(rawHostState));
    expect(info.source).toBe("host.state");
    expect(info.project).toBe("Packages (Anton Tishchenko)");
    expect(info.environment).toBe("dev");
    expect(info.label).toBe("Packages (Anton Tishchenko) / dev");
    expect(info.environmentType).toBe("nonprod");
    expect(info.regionCode).toBe("euw");
  });

  it("falls back to tenantDisplayName, which carries the same pair joined", () => {
    const info = describeEnvironment(appContext());
    expect(info.source).toBe("tenantDisplayName");
    expect(info.project).toBe("Packages (Anton Tishchenko)");
    expect(info.environment).toBe("dev");
  });

  it("splits the display name on the last separator, not the first", () => {
    // A project name may contain a slash; the environment is always the trailing segment.
    const info = describeEnvironment(
      appContext({
        resources: [{ tenantDisplayName: "Marketing / Web (EU) / qa", tenantId: "t" }],
      }),
    );
    expect(info.project).toBe("Marketing / Web (EU)");
    expect(info.environment).toBe("qa");
  });

  it("treats a display name with no separator as a project name", () => {
    const info = describeEnvironment(
      appContext({ resources: [{ tenantDisplayName: "Solo", tenantId: "t" }] }),
    );
    expect(info.project).toBe("Solo");
    expect(info.environment).toBeUndefined();
  });

  it("treats tenantName: null as absent rather than as a value", () => {
    // It really is null on a live tenant, which is why it cannot be the primary source.
    const info = describeEnvironment(appContext());
    expect(info.tenantName).toBeUndefined();
    expect(info.label).not.toBe("null");
  });

  it("falls back to the raw tenant slug when nothing else names the pair", () => {
    const info = describeEnvironment(
      appContext({
        resources: [{ tenantName: "sitecoremvp7412-packagesant51e1-dev95fe", tenantId: "t" }],
      }),
    );
    expect(info.source).toBe("tenantName");
    expect(info.label).toBe("sitecoremvp7412-packagesant51e1-dev95fe");
    // Not split: the slug's segments are mangled and guessing at them would invent a name.
    expect(info.project).toBeUndefined();
  });

  it("says so rather than inventing a label when there is no resource at all", () => {
    const info = describeEnvironment(appContext({ resources: [], resourceAccess: [] }));
    expect(info.source).toBe("none");
    expect(info.label).toBe("environment unknown");
  });

  it("survives no application context", () => {
    expect(describeEnvironment(undefined).label).toBe("environment unknown");
  });

  it("carries the ids the popover shows, including the context id", () => {
    const info = describeEnvironment(appContext(), narrowHostState(rawHostState));
    expect(info.tenantId).toBe("2c5b885b-8b17-4148-8e2c-08df0e9901d4");
    expect(info.organizationId).toBe("org_CoF1J6ejrMTWQ5Oy");
    // Preview, not live: authoring edits the editing surface.
    expect(info.contextId).toBe("3em1S0rnRKgcum44eoUKgC");
  });

  it("uses host.state's organization id when the app context omits it", () => {
    const info = describeEnvironment(
      appContext({ organizationId: undefined }),
      narrowHostState(rawHostState),
    );
    expect(info.organizationId).toBe("org_CoF1J6ejrMTWQ5Oy");
  });
});
