import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const ProviderCatalogQuery = Schema.Struct({
  provider: ProviderKind,
  cwd: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderCatalogQuery = typeof ProviderCatalogQuery.Type;

export const ProviderAuthMethod = Schema.Struct({
  type: Schema.Literals(["oauth", "api"]),
  label: TrimmedNonEmptyString,
});
export type ProviderAuthMethod = typeof ProviderAuthMethod.Type;

export const ProviderCatalogDelegatedProvider = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  connected: Schema.Boolean,
  defaultModelSlug: Schema.NullOr(TrimmedNonEmptyString),
  authMethods: Schema.Array(ProviderAuthMethod),
});
export type ProviderCatalogDelegatedProvider = typeof ProviderCatalogDelegatedProvider.Type;

export const ProviderCatalogModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  providerId: TrimmedNonEmptyString,
  providerName: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  connected: Schema.Boolean,
  supportsAttachments: Schema.Boolean,
  supportsReasoning: Schema.Boolean,
  supportsToolCalls: Schema.Boolean,
  experimental: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Literals(["alpha", "beta", "deprecated"])),
});
export type ProviderCatalogModel = typeof ProviderCatalogModel.Type;

export const ProviderCatalog = Schema.Struct({
  provider: ProviderKind,
  cwd: TrimmedNonEmptyString,
  fetchedAt: IsoDateTime,
  delegatedProviders: Schema.Array(ProviderCatalogDelegatedProvider),
  models: Schema.Array(ProviderCatalogModel),
});
export type ProviderCatalog = typeof ProviderCatalog.Type;

export const ProviderSetApiKeyAuthInput = Schema.Struct({
  provider: ProviderKind,
  cwd: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  delegatedProviderId: TrimmedNonEmptyString,
  apiKey: TrimmedNonEmptyString,
});
export type ProviderSetApiKeyAuthInput = typeof ProviderSetApiKeyAuthInput.Type;

export const ProviderStartOauthInput = Schema.Struct({
  provider: ProviderKind,
  cwd: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  delegatedProviderId: TrimmedNonEmptyString,
  methodIndex: Schema.Number,
});
export type ProviderStartOauthInput = typeof ProviderStartOauthInput.Type;

export const ProviderStartOauthResult = Schema.Struct({
  url: TrimmedNonEmptyString,
  method: Schema.Literals(["auto", "code"]),
  instructions: TrimmedNonEmptyString,
});
export type ProviderStartOauthResult = typeof ProviderStartOauthResult.Type;

export const ProviderCompleteOauthInput = Schema.Struct({
  provider: ProviderKind,
  cwd: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  delegatedProviderId: TrimmedNonEmptyString,
  methodIndex: Schema.Number,
  code: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderCompleteOauthInput = typeof ProviderCompleteOauthInput.Type;
