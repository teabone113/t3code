import { registerPlugin } from "@capacitor/core";
import type { DiscoveredBackend } from "@t3tools/contracts";

import { isCapacitorShell } from "./env";

interface BackendDiscoveryPlugin {
  discoverBackends(options?: { timeoutMs?: number }): Promise<{
    backends: DiscoveredBackend[];
  }>;
}

const capacitorBackendDiscovery = registerPlugin<BackendDiscoveryPlugin>("BackendDiscovery");
const DISCOVERY_LOG_PREFIX = "[backend-discovery]";

function logDiscovery(message: string, payload?: unknown): void {
  if (payload === undefined) {
    console.info(DISCOVERY_LOG_PREFIX, message);
    return;
  }

  console.info(DISCOVERY_LOG_PREFIX, message, payload);
}

function sortDiscoveredBackends(backends: readonly DiscoveredBackend[]): DiscoveredBackend[] {
  return [...backends].toSorted((left, right) => {
    if (left.name !== right.name) {
      return left.name.localeCompare(right.name);
    }
    if (left.host !== right.host) {
      return left.host.localeCompare(right.host);
    }
    if (left.port !== right.port) {
      return left.port - right.port;
    }
    return left.protocol.localeCompare(right.protocol);
  });
}

export function supportsBackendDiscovery(): boolean {
  const supported = Boolean(window.desktopBridge?.discoverBackends) || isCapacitorShell();
  logDiscovery("supports discovery", {
    supported,
    electron: Boolean(window.desktopBridge?.discoverBackends),
    capacitor: isCapacitorShell(),
  });
  return supported;
}

export async function discoverBackends(timeoutMs = 3_000): Promise<DiscoveredBackend[]> {
  if (window.desktopBridge?.discoverBackends) {
    logDiscovery("starting desktop discovery", { timeoutMs });
    const backends = sortDiscoveredBackends(await window.desktopBridge.discoverBackends(timeoutMs));
    logDiscovery("desktop discovery complete", { count: backends.length, backends });
    return backends;
  }

  if (isCapacitorShell()) {
    logDiscovery("starting capacitor discovery", { timeoutMs });
    try {
      const result = await capacitorBackendDiscovery.discoverBackends({ timeoutMs });
      const backends = sortDiscoveredBackends(result.backends);
      logDiscovery("capacitor discovery complete", { count: backends.length, backends });
      return backends;
    } catch (error) {
      logDiscovery("capacitor discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  logDiscovery("discovery unavailable in current shell");
  return [];
}
