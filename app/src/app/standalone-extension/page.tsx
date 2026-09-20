"use client";

import Link from "next/link";
import { mdiPackageVariantClosed, mdiPackageVariantPlus } from "@mdi/js";
import { useSession, useSessionBootstrap } from "@/src/features/create/store/session";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { Spinner } from "@/src/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";

/**
 * Standalone extension — the main entry point for the Sitecore Package Manager app
 * when launched from the Sitecore Cloud Portal.
 *
 * It surfaces the two core capabilities: Create opens the Package Designer; Install is a
 * later phase. The Sitecore session is established once in the store and shared with the
 * designer, rather than each page running its own application.context query.
 */
function StandaloneExtension() {
  useSessionBootstrap();
  const appContext = useSession((s) => s.appContext);
  const contextLoaded = useSession((s) => s.contextLoaded);
  const error = useSession((s) => s.connectionError);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Sitecore Package Manager</h1>
      <p className="mt-1 text-muted-foreground">
        Install and create classic-format Sitecore packages (items) on SitecoreAI / XM Cloud.
      </p>

      {!contextLoaded && !error && (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Connecting to Sitecore…
        </p>
      )}
      {error && <p className="mt-6 text-sm text-danger-fg">Error: {String(error)}</p>}

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Icon path={mdiPackageVariantClosed} /> Install a package
            </CardTitle>
            <CardDescription>
              Upload a classic Sitecore package and apply its items to the site.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Reads the package&apos;s serialized items and applies them through the Authoring API.
          </CardContent>
          <CardFooter>
            <Button asChild>
              <Link href="/standalone-extension/install">Open Installation Wizard</Link>
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Icon path={mdiPackageVariantPlus} /> Create a package
            </CardTitle>
            <CardDescription>
              Define what a package contains, the way Package Designer did.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Build a package definition from item, file and security-account sources, then generate
            the .zip.
          </CardContent>
          <CardFooter>
            <Button asChild>
              <Link href="/standalone-extension/create">Open Package Designer</Link>
            </Button>
          </CardFooter>
        </Card>
      </section>

      {appContext && (
        <details className="mt-8 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Application context</summary>
          <ul className="mt-2 space-y-1">
            <li>
              <strong>Name:</strong> {appContext.name}
            </li>
            <li>
              <strong>ID:</strong> {appContext.id}
            </li>
            <li>
              <strong>Installation ID:</strong> {appContext.installationId}
            </li>
            <li>
              <strong>Type:</strong> {appContext.type}
            </li>
          </ul>
        </details>
      )}
    </main>
  );
}

export default StandaloneExtension;
