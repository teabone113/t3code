import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const EDITORS = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "vscode", label: "VS Code", command: "code" },
  { id: "zed", label: "Zed", command: "zed" },
  { id: "file-manager", label: "File Manager", command: null },
] as const;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const TERMINAL_APPS = [
  { id: "terminal", label: "Terminal", command: null },
  { id: "warp", label: "Warp", command: "warp" },
] as const;

export const TerminalAppId = Schema.Literals(TERMINAL_APPS.map((terminal) => terminal.id));
export type TerminalAppId = typeof TerminalAppId.Type;

export const FolderOpenTargetId = Schema.Union([EditorId, TerminalAppId]);
export type FolderOpenTargetId = typeof FolderOpenTargetId.Type;

export const OpenInEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type OpenInEditorInput = typeof OpenInEditorInput.Type;

export const OpenInTerminalInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  terminal: TerminalAppId,
});
export type OpenInTerminalInput = typeof OpenInTerminalInput.Type;

export const OpenPathWithPreferencesInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  fileEditor: EditorId,
  folderTarget: FolderOpenTargetId,
});
export type OpenPathWithPreferencesInput = typeof OpenPathWithPreferencesInput.Type;
