import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_CONTEXT_BINARY_PATH_MAX_LENGTH = 4096;
const PROJECT_CONTEXT_PROMPT_MAX_LENGTH = 16_384;
const PROJECT_CONTEXT_TEXT_MAX_LENGTH = 16_384;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH),
  ),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

const ProjectContextSourceKind = Schema.Literals(["repo-outline", "symbol", "text-search"]);

export const ProjectContextSource = Schema.Struct({
  kind: ProjectContextSourceKind,
  label: TrimmedNonEmptyString,
  filePath: Schema.optional(TrimmedNonEmptyString),
  line: Schema.optional(PositiveInt),
});
export type ProjectContextSource = typeof ProjectContextSource.Type;

export const ProjectBuildContextInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  prompt: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROJECT_CONTEXT_PROMPT_MAX_LENGTH),
  ),
  enabled: Schema.Boolean,
  binaryPath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_CONTEXT_BINARY_PATH_MAX_LENGTH)),
  ),
});
export type ProjectBuildContextInput = typeof ProjectBuildContextInput.Type;

export const ProjectBuildContextResult = Schema.Struct({
  applied: Schema.Boolean,
  contextText: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PROJECT_CONTEXT_TEXT_MAX_LENGTH),
    ),
  ),
  message: Schema.optional(TrimmedNonEmptyString),
  sources: Schema.Array(ProjectContextSource),
});
export type ProjectBuildContextResult = typeof ProjectBuildContextResult.Type;
