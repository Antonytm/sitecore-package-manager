// xmc/environment — which SitecoreAI project and environment are we pointed at?
//
// The app writes items at fixed GUIDs into a live tenant and there is no uninstall, so
// "which environment is this?" has to be answerable without opening the portal's own
// dropdown. The portal shows a project and an environment ("Packages (Anton Tishchenko)" /
// "dev"); this recovers the same pair from what the host hands the iframe.
//
// Measured against a live standalone extension rather than read off the .d.ts files, because
// the types are misleading here in both directions:
//
//   * `ApplicationContext` declares no project or environment name, yet
//     `resources[0].tenantDisplayName` arrives already formatted as "<project> / <env>".
//   * `HostState<'portal'>` is typed `null`, yet a standalone portal extension DOES get a
//     populated `xmCloudTenantInfo`. The narrow type is what would have stopped us asking.
//
//   * `tenantName` is null on that tenant, so it cannot be the primary source, and splitting
//     it on the XM Cloud slug convention is not a route at all.
//
// PRIVACY: `host.state` also carries a `userInfo` block — email, name, auth subject, avatar.
// The app has no use for any of it. {@link narrowHostState} drops it at the boundary so it
// never reaches the store, a render, or a copied diagnostic. Read `xmCloudTenantInfo` only.

import type { ApplicationContext } from "@sitecore-marketplace-sdk/client";
import { contextIdOf } from "./client";

/** The only part of `host.state` this app keeps. Everything else is dropped on arrival. */
export interface HostEnvironment {
  organizationId?: string;
  projectId?: string;
  projectName?: string;
  environmentId?: string;
  environmentName?: string;
  /** `nonprod` / `prod` — worth showing, it says whether this is production. */
  environmentType?: string;
  regionCode?: string;
}

/** Where the project/environment pair came from, so a wrong label is diagnosable. */
export type EnvironmentSource = "host.state" | "tenantDisplayName" | "tenantName" | "none";

export interface EnvironmentInfo {
  project?: string;
  environment?: string;
  /** Ready to render: "Packages (Anton Tishchenko) / dev", or a stated fallback. */
  label: string;
  environmentType?: string;
  regionCode?: string;
  projectId?: string;
  environmentId?: string;
  tenantId?: string;
  tenantName?: string;
  organizationId?: string;
  contextId?: string;
  source: EnvironmentSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A non-empty trimmed string, or undefined. `null` is a real value in these payloads. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Keep the environment identity from a raw `host.state` answer and discard the rest.
 *
 * Deliberately field-by-field rather than a spread: `userInfo` must not survive this
 * function, and a spread would carry every future field the host adds along with it.
 */
export function narrowHostState(raw: unknown): HostEnvironment | undefined {
  if (!isRecord(raw)) return undefined;
  const tenant = isRecord(raw.xmCloudTenantInfo) ? raw.xmCloudTenantInfo : undefined;

  const narrowed: HostEnvironment = {
    organizationId: text(raw.organizationId),
    projectId: text(tenant?.projectId),
    projectName: text(tenant?.projectName),
    environmentId: text(tenant?.environmentId),
    environmentName: text(tenant?.environmentName),
    environmentType: text(tenant?.customerEnvironmentType),
    regionCode: text(tenant?.regionCode),
  };

  return Object.values(narrowed).some((v) => v !== undefined) ? narrowed : undefined;
}

/**
 * Split "Packages (Anton Tishchenko) / dev" into its two halves.
 *
 * On the LAST separator, not the first: a project name may itself contain a slash or
 * parentheses, but the environment name is the trailing segment.
 */
function splitDisplayName(display: string): { project?: string; environment?: string } {
  const at = display.lastIndexOf(" / ");
  if (at < 0) return { project: display };
  return {
    project: text(display.slice(0, at)),
    environment: text(display.slice(at + 3)),
  };
}

/** The first resource with anything in it. `resourceAccess` is current; `resources` is its alias. */
function firstResource(appContext: ApplicationContext | undefined): Record<string, unknown> | undefined {
  for (const list of [appContext?.resourceAccess, appContext?.resources]) {
    if (!Array.isArray(list)) continue;
    for (const resource of list) if (isRecord(resource)) return resource;
  }
  return undefined;
}

/**
 * Resolve the environment label, preferring the source that names the pair explicitly.
 *
 * `host.state` first because it separates project from environment at the source and adds
 * the type and region; `tenantDisplayName` next because it carries the same pair already
 * joined; `tenantName` last, raw, because on a real tenant it came back `null` and when it
 * is present it is an opaque slug like `sitecoremvp7412-packagesant51e1-dev95fe`.
 */
export function describeEnvironment(
  appContext: ApplicationContext | undefined,
  host?: HostEnvironment,
): EnvironmentInfo {
  const resource = firstResource(appContext);
  const tenantName = text(resource?.tenantName);
  const tenantDisplayName = text(resource?.tenantDisplayName);

  const common = {
    environmentType: host?.environmentType,
    regionCode: host?.regionCode,
    projectId: host?.projectId,
    environmentId: host?.environmentId,
    tenantId: text(resource?.tenantId),
    tenantName,
    organizationId: text(appContext?.organizationId) ?? host?.organizationId,
    contextId: contextIdOf(appContext),
  };

  if (host?.projectName || host?.environmentName) {
    return {
      ...common,
      project: host.projectName,
      environment: host.environmentName,
      label: join(host.projectName, host.environmentName),
      source: "host.state",
    };
  }

  if (tenantDisplayName) {
    const { project, environment } = splitDisplayName(tenantDisplayName);
    return { ...common, project, environment, label: tenantDisplayName, source: "tenantDisplayName" };
  }

  if (tenantName) {
    return { ...common, label: tenantName, source: "tenantName" };
  }

  return { ...common, label: "environment unknown", source: "none" };
}

function join(project: string | undefined, environment: string | undefined): string {
  if (project && environment) return project + " / " + environment;
  return project ?? environment ?? "environment unknown";
}
