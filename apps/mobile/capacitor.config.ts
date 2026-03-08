import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.t3tools.t3code",
  appName: "T3 Code",
  webDir: "../web/dist",
  bundledWebRuntime: false,
  server: {
    cleartext: true,
  },
  ios: {
    contentInset: "automatic",
    backgroundColor: "#ffffff",
    scrollEnabled: true,
  },
};

export default config;
