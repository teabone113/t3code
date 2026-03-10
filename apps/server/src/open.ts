/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";

import {
  EDITORS,
  TERMINAL_APPS,
  type EditorId,
  type OpenInEditorInput,
  type OpenInTerminalInput,
  type OpenPathWithPreferencesInput,
  type TerminalAppId,
} from "@t3tools/contracts";
import { ServiceMap, Schema, Effect, Layer } from "effect";

// ==============================
// Definitions
// ==============================

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

interface OpenLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface EditorDefinition {
  readonly id: EditorId;
  readonly label: string;
  readonly command: string | null;
}

interface TerminalAppDefinition {
  readonly id: TerminalAppId;
  readonly label: string;
  readonly command: string | null;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const MAC_EDITOR_APP_NAMES: Record<Exclude<EditorId, "file-manager">, ReadonlyArray<string>> = {
  cursor: ["Cursor"],
  vscode: ["Visual Studio Code", "Code"],
  zed: ["Zed"],
};
const MAC_TERMINAL_APP_NAMES: Record<TerminalAppId, ReadonlyArray<string>> = {
  terminal: ["Terminal"],
  warp: ["Warp"],
};
const TERMINAL_APP_ID_SET = new Set<TerminalAppId>(TERMINAL_APPS.map((terminal) => terminal.id));

function stripLineColumnSuffix(target: string): string {
  return target.replace(LINE_COLUMN_SUFFIX_PATTERN, "");
}

function shouldUseGotoFlag(editorId: EditorId, target: string): boolean {
  return (editorId === "cursor" || editorId === "vscode") && LINE_COLUMN_SUFFIX_PATTERN.test(target);
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

function isDirectoryPath(target: string): boolean {
  try {
    return statSync(stripLineColumnSuffix(target)).isDirectory();
  } catch {
    return false;
  }
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function macApplicationDirectories(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const home = env.HOME?.trim();
  return [
    ...(home ? [join(home, "Applications")] : []),
    "/Applications",
    "/Applications/Setapp",
  ];
}

function isMacApplicationInstalled(
  appNames: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  for (const directory of macApplicationDirectories(env)) {
    for (const appName of appNames) {
      try {
        if (statSync(join(directory, `${appName}.app`)).isDirectory()) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const extension of windowsPathExtensions) {
    candidates.push(`${command}${extension}`);
    candidates.push(`${command}${extension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") {
      const extension = extname(filePath);
      if (extension.length === 0) return false;
      return windowsPathExtensions.includes(extension.toUpperCase());
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return commandCandidates.some((candidate) =>
      isExecutableFile(candidate, platform, windowsPathExtensions),
    );
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;
  const pathEntries = pathValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      if (isExecutableFile(join(pathEntry, candidate), platform, windowsPathExtensions)) {
        return true;
      }
    }
  }
  return false;
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    const command = editor.command ?? fileManagerCommandForPlatform(platform);
    const hasCommand = isCommandAvailable(command, { platform, env });
    const hasMacApp =
      platform === "darwin" &&
      editor.id !== "file-manager" &&
      isMacApplicationInstalled(MAC_EDITOR_APP_NAMES[editor.id], env);
    if (hasCommand || hasMacApp) {
      available.push(editor.id);
    }
  }

  return available;
}

export function resolveAvailableTerminalApps(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<TerminalAppId> {
  const available: TerminalAppId[] = [];

  for (const terminal of TERMINAL_APPS) {
    const hasCommand =
      terminal.command !== null && isCommandAvailable(terminal.command, { platform, env });
    const hasMacApp =
      platform === "darwin" && isMacApplicationInstalled(MAC_TERMINAL_APP_NAMES[terminal.id], env);
    if (hasCommand || hasMacApp) {
      available.push(terminal.id);
    }
  }

  return available;
}

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected terminal app.
   */
  readonly openInTerminal: (input: OpenInTerminalInput) => Effect.Effect<void, OpenError>;

  /**
   * Open a path using file-vs-folder preferences.
   */
  readonly openPathWithPreferences: (
    input: OpenPathWithPreferencesInput,
  ) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("t3/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<OpenLaunch, OpenError> {
  const editorDef = EDITORS.find((editor) => editor.id === input.editor) as EditorDefinition | undefined;
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.command) {
    if (isCommandAvailable(editorDef.command, { platform, env })) {
      return shouldUseGotoFlag(editorDef.id, input.cwd)
        ? { command: editorDef.command, args: ["--goto", input.cwd] }
        : { command: editorDef.command, args: [input.cwd] };
    }

    if (platform === "darwin" && input.editor !== "file-manager") {
      const appNames = MAC_EDITOR_APP_NAMES[input.editor];
      const appName = appNames.find((candidate) => isMacApplicationInstalled([candidate], env));
      if (appName) {
        if (shouldUseGotoFlag(editorDef.id, input.cwd)) {
          return {
            command: "open",
            args: ["-a", appName, "--args", "--goto", input.cwd],
          };
        }
        return {
          command: "open",
          args: ["-a", appName, stripLineColumnSuffix(input.cwd)],
        };
      }
    }

    return yield* new OpenError({ message: `Editor command not found: ${editorDef.command}` });
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  return { command: fileManagerCommandForPlatform(platform), args: [input.cwd] };
});

export const resolveTerminalLaunch = Effect.fnUntraced(function* (
  input: OpenInTerminalInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<OpenLaunch, OpenError> {
  const terminalDef = TERMINAL_APPS.find(
    (terminal) => terminal.id === input.terminal,
  ) as TerminalAppDefinition | undefined;
  if (!terminalDef) {
    return yield* new OpenError({ message: `Unknown terminal app: ${input.terminal}` });
  }

  if (terminalDef.command && isCommandAvailable(terminalDef.command, { platform, env })) {
    return { command: terminalDef.command, args: [stripLineColumnSuffix(input.cwd)] };
  }

  if (platform === "darwin") {
    const appNames = MAC_TERMINAL_APP_NAMES[input.terminal];
    const appName = appNames.find((candidate) => isMacApplicationInstalled([candidate], env));
    if (appName) {
      return {
        command: "open",
        args: ["-a", appName, stripLineColumnSuffix(input.cwd)],
      };
    }
  }

  return yield* new OpenError({
    message: `Terminal app is not installed or unavailable: ${terminalDef.label}`,
  });
});

export const launchDetached = (launch: OpenLaunch) =>
  Effect.gen(function* () {
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        child = spawn(launch.command, [...launch.args], {
          detached: true,
          stdio: "ignore",
          shell: process.platform === "win32",
        });
      } catch (error) {
        return resume(
          Effect.fail(
            new OpenError({ message: "failed to spawn detached process", cause: error }),
          ),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) => Effect.flatMap(resolveEditorLaunch(input), launchDetached),
    openInTerminal: (input) => Effect.flatMap(resolveTerminalLaunch(input), launchDetached),
    openPathWithPreferences: (input) => {
      if (isDirectoryPath(input.path)) {
        const directoryPath = stripLineColumnSuffix(input.path);
        return TERMINAL_APP_ID_SET.has(input.folderTarget as TerminalAppId)
          ? Effect.flatMap(
              resolveTerminalLaunch({
                cwd: directoryPath,
                terminal: input.folderTarget as TerminalAppId,
              }),
              launchDetached,
            )
          : Effect.flatMap(
              resolveEditorLaunch({
                cwd: directoryPath,
                editor: input.folderTarget as EditorId,
              }),
              launchDetached,
            );
      }

      return Effect.flatMap(
        resolveEditorLaunch({
          cwd: input.path,
          editor: input.fileEditor,
        }),
        launchDetached,
      );
    },
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
