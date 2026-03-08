import os from "node:os";

import type { BackendProtocol, DiscoveredBackend } from "@t3tools/contracts";
import { Bonjour } from "bonjour-service";

export const T3_BACKEND_BONJOUR_SERVICE_TYPE = "t3code";
export const T3_BACKEND_BONJOUR_SERVICE_NAME = "_t3code._tcp";
export const DEFAULT_BONJOUR_DISCOVERY_TIMEOUT_MS = 1_500;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

interface BonjourTxtRecord {
  protocol?: string;
  host?: string;
  port?: string;
}

interface BonjourServiceRecord {
  name?: string;
  host?: string;
  fqdn?: string;
  port?: number;
  txt?: BonjourTxtRecord;
  addresses?: string[];
}

function sanitizeHost(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }

  const trimmed = input.trim().replace(/\.+$/, "");
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

function sanitizeProtocol(input: string | null | undefined): BackendProtocol {
  return input === "wss" ? "wss" : "ws";
}

function sanitizePort(input: string | number | null | undefined): number | null {
  const numeric = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65_535 ? numeric : null;
}

function stableBackendKey(input: {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: BackendProtocol;
}): string {
  return `${input.protocol}:${input.host}:${input.port}:${input.name}`;
}

function normalizeDiscoveredBackend(service: BonjourServiceRecord): DiscoveredBackend | null {
  const name = service.name?.trim();
  if (!name) {
    return null;
  }

  const port = sanitizePort(service.port) ?? sanitizePort(service.txt?.port);
  if (port === null) {
    return null;
  }

  const host =
    sanitizeHost(service.txt?.host) ??
    sanitizeHost(service.host) ??
    sanitizeHost(service.fqdn) ??
    sanitizeHost(service.addresses?.find((address) => !LOOPBACK_HOSTS.has(address)));
  if (!host) {
    return null;
  }

  return {
    name,
    host,
    port,
    protocol: sanitizeProtocol(service.txt?.protocol),
  };
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

export function buildBonjourBackendServiceName(hostname = os.hostname()): string {
  const trimmedHostname = hostname.trim() || "backend";
  return `T3 Code on ${trimmedHostname}`;
}

export function resolveAdvertisedBonjourHost(host?: string): string | undefined {
  const trimmedHost = host?.trim();
  if (trimmedHost && !LOOPBACK_HOSTS.has(trimmedHost) && trimmedHost !== "0.0.0.0" && trimmedHost !== "::" && trimmedHost !== "[::]") {
    return trimmedHost;
  }

  const interfaces = os.networkInterfaces();
  const ipv4Candidate = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal && !LOOPBACK_HOSTS.has(entry.address));
  if (ipv4Candidate) {
    return ipv4Candidate.address;
  }

  const ipv6Candidate = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv6" && !entry.internal && !entry.address.startsWith("fe80:"));
  return ipv6Candidate?.address;
}

export function shouldAdvertiseBonjourBackend(input: {
  readonly authToken?: string | undefined;
  readonly host?: string | undefined;
}): boolean {
  if (input.authToken && input.authToken.trim().length > 0) {
    return false;
  }

  const host = input.host?.trim();
  if (!host) {
    return true;
  }

  return !LOOPBACK_HOSTS.has(host);
}

export function createBonjourBackendAdvertisement(input: {
  readonly name?: string;
  readonly port: number;
  readonly protocol?: BackendProtocol;
  readonly host?: string;
}) {
  const bonjour = new Bonjour();
  const advertisedHost = resolveAdvertisedBonjourHost(input.host);
  const service = bonjour.publish({
    name: input.name ?? buildBonjourBackendServiceName(),
    type: T3_BACKEND_BONJOUR_SERVICE_TYPE,
    port: input.port,
    txt: {
      ...(advertisedHost ? { host: advertisedHost } : {}),
      port: String(input.port),
      protocol: input.protocol ?? "ws",
    },
  });

  let stopped = false;
  return {
    stop(): Promise<void> {
      if (stopped) {
        return Promise.resolve();
      }
      stopped = true;

      return new Promise((resolve) => {
        try {
          service.stop?.(() => {
            bonjour.destroy();
            resolve();
          });
        } catch {
          bonjour.destroy();
          resolve();
        }
      });
    },
  };
}

export async function discoverBonjourBackends(input?: {
  readonly timeoutMs?: number;
}): Promise<DiscoveredBackend[]> {
  const timeoutMs = Math.max(
    250,
    Math.min(input?.timeoutMs ?? DEFAULT_BONJOUR_DISCOVERY_TIMEOUT_MS, 10_000),
  );

  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: T3_BACKEND_BONJOUR_SERVICE_TYPE });
    const backends = new Map<string, DiscoveredBackend>();
    let settled = false;

    const finalize = () => {
      if (settled) {
        return;
      }
      settled = true;
      browser.stop();
      bonjour.destroy();
      resolve(sortDiscoveredBackends([...backends.values()]));
    };

    browser.on("up", (service: BonjourServiceRecord) => {
      const normalized = normalizeDiscoveredBackend(service);
      if (!normalized) {
        return;
      }
      backends.set(stableBackendKey(normalized), normalized);
    });

    browser.on("error", finalize);
    const timer = setTimeout(finalize, timeoutMs);
    timer.unref?.();
  });
}
