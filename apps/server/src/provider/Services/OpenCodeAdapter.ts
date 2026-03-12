import type {
  ProviderCatalog,
  ProviderCatalogQuery,
  ProviderCompleteOauthInput,
  ProviderSetApiKeyAuthInput,
  ProviderStartOauthInput,
  ProviderStartOauthResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
  readonly getCatalog: (
    input: ProviderCatalogQuery,
  ) => import("effect").Effect.Effect<ProviderCatalog, ProviderAdapterError>;
  readonly setApiKeyAuth: (
    input: ProviderSetApiKeyAuthInput,
  ) => import("effect").Effect.Effect<boolean, ProviderAdapterError>;
  readonly startOauth: (
    input: ProviderStartOauthInput,
  ) => import("effect").Effect.Effect<ProviderStartOauthResult, ProviderAdapterError>;
  readonly completeOauth: (
    input: ProviderCompleteOauthInput,
  ) => import("effect").Effect.Effect<boolean, ProviderAdapterError>;
}

export class OpenCodeAdapter extends ServiceMap.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Services/OpenCodeAdapter",
) {}
