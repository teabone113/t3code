import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildRemoteBackendWsUrl,
  resolveDefaultBackendWsUrl,
  resolveHttpOriginFromWsUrl,
} from "./backendConnection";

describe("backendConnection", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          protocol: "http:",
          host: "localhost:3773",
          origin: "http://localhost:3773",
        },
        desktopBridge: undefined,
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("builds a websocket URL from a saved remote profile", () => {
    expect(
      buildRemoteBackendWsUrl({
        host: "192.168.1.42",
        port: 3773,
        protocol: "ws",
      }),
    ).toBe("ws://192.168.1.42:3773");
  });

  it("resolves the default backend websocket URL from the desktop bridge when available", () => {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        getWsUrl: () => "ws://10.0.0.12:3773/?token=dev",
      },
    });

    expect(resolveDefaultBackendWsUrl()).toBe("ws://10.0.0.12:3773/?token=dev");
  });

  it("converts websocket origins to matching HTTP origins", () => {
    expect(resolveHttpOriginFromWsUrl("wss://example.com:4443/socket")).toBe(
      "https://example.com:4443",
    );
  });
});
