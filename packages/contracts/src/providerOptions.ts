import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyStringSchema),
  homePath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type CodexProviderStartOptions = typeof CodexProviderStartOptions.Type;

export const OpenCodeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type OpenCodeProviderStartOptions = typeof OpenCodeProviderStartOptions.Type;

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
  opencode: Schema.optional(OpenCodeProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;
