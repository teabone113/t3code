import type { ProviderKind, ServerProviderStatus } from "@t3tools/contracts";

export function getProviderStatus(
  statuses: ReadonlyArray<ServerProviderStatus>,
  provider: ProviderKind,
): ServerProviderStatus | null {
  return statuses.find((status) => status.provider === provider) ?? null;
}

export function isProviderConnected(
  status:
    | Pick<ServerProviderStatus, "available" | "authStatus">
    | null
    | undefined,
): boolean {
  if (!status) {
    return false;
  }
  return status.available && status.authStatus === "authenticated";
}

export function getProviderConnectionLabel(
  status:
    | Pick<ServerProviderStatus, "available" | "authStatus">
    | null
    | undefined,
): "Connected" | "Not connected" {
  return isProviderConnected(status) ? "Connected" : "Not connected";
}
