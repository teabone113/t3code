import type { ProviderCatalogQuery, ProviderKind } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";

interface ProviderCatalogQueryInput {
  provider: ProviderKind;
  cwd?: string | null;
  binaryPath?: string | null;
  enabled?: boolean;
}

export const providerCatalogQueryKeys = {
  all: ["providerCatalog"] as const,
  catalog: (input: ProviderCatalogQueryInput) =>
    ["providerCatalog", input.provider, input.cwd ?? null, input.binaryPath ?? null] as const,
};

function normalizeQuery(input: ProviderCatalogQueryInput): ProviderCatalogQuery {
  return {
    provider: input.provider,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
  };
}

export function providerCatalogQueryOptions(input: ProviderCatalogQueryInput) {
  return queryOptions({
    queryKey: providerCatalogQueryKeys.catalog(input),
    enabled: input.enabled ?? true,
    staleTime: 15_000,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.getCatalog(normalizeQuery(input));
    },
  });
}
