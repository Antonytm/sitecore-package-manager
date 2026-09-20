import { PackageDesigner } from "@/src/features/create/PackageDesigner";

/**
 * Create a package — the Package Designer replacement.
 *
 * Nested under the registered Standalone extension so it inherits the same Marketplace
 * host context (the SDK bridge is established against `window.parent`).
 */
export default function CreatePage() {
  return <PackageDesigner />;
}
