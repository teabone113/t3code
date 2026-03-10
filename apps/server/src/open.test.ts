import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  isCommandAvailable,
  launchDetached,
  resolveAvailableEditors,
  resolveAvailableTerminalApps,
  resolveEditorLaunch,
  resolveTerminalLaunch,
} from "./open";
import { Effect } from "effect";
import { assertSuccess } from "@effect/vitest/utils";

describe("resolveEditorLaunch", () => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "darwin",
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "darwin",
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("falls back to installed mac app bundles when the editor CLI is missing", () =>
    Effect.gen(function* () {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-home-"));
      try {
        fs.mkdirSync(path.join(homeDir, "Applications", "Zed.app"), { recursive: true });
        const launch = yield* resolveEditorLaunch(
          { cwd: "/tmp/workspace", editor: "zed" },
          "darwin",
          { HOME: homeDir, PATH: "" },
        );
        assert.deepEqual(launch, {
          command: "open",
          args: ["-a", "Zed", "/tmp/workspace"],
        });
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("passes --goto through open -a for mac app fallback when supported", () =>
    Effect.gen(function* () {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-home-"));
      try {
        fs.mkdirSync(path.join(homeDir, "Applications", "Cursor.app"), { recursive: true });
        const launch = yield* resolveEditorLaunch(
          { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
          "darwin",
          { HOME: homeDir, PATH: "" },
        );
        assert.deepEqual(launch, {
          command: "open",
          args: ["-a", "Cursor", "--args", "--goto", "/tmp/workspace/src/open.ts:71:5"],
        });
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("uses --goto when editor supports line/column suffixes", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        "darwin",
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        "darwin",
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/open.ts:71:5"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

describe("resolveTerminalLaunch", () => {
  it.effect("falls back to installed mac app bundles when terminal CLI is missing", () =>
    Effect.gen(function* () {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-home-"));
      try {
        fs.mkdirSync(path.join(homeDir, "Applications", "Warp.app"), { recursive: true });
        const launch = yield* resolveTerminalLaunch(
          { cwd: "/tmp/workspace", terminal: "warp" },
          "darwin",
          { HOME: homeDir, PATH: "" },
        );
        assert.deepEqual(launch, {
          command: "open",
          args: ["-a", "Warp", "/tmp/workspace"],
        });
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("supports mac Terminal without requiring a CLI command", () =>
    Effect.gen(function* () {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-home-"));
      try {
        fs.mkdirSync(path.join(homeDir, "Applications", "Terminal.app"), { recursive: true });
        const launch = yield* resolveTerminalLaunch(
          { cwd: "/tmp/workspace", terminal: "terminal" },
          "darwin",
          { HOME: homeDir, PATH: "" },
        );
        assert.deepEqual(launch, {
          command: "open",
          args: ["-a", "Terminal", "/tmp/workspace"],
        });
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("launchDetached", () => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `t3code-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

describe("isCommandAvailable", () => {
  function withTempDir(run: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-open-"));
    try {
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("resolves win32 commands with PATHEXT", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "code.CMD"), "@echo off\r\n", "utf8");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    });
  });

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it("does not treat bare files without executable extension as available on win32", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "npm"), "echo nope\r\n", "utf8");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    });
  });

  it("appends PATHEXT for commands with non-executable extensions on win32", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "my.tool.CMD"), "@echo off\r\n", "utf8");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    });
  });

  it("uses platform-specific PATH delimiter for platform overrides", () => {
    withTempDir((firstDir) => {
      withTempDir((secondDir) => {
        fs.writeFileSync(path.join(secondDir, "code.CMD"), "@echo off\r\n", "utf8");
        const env = {
          PATH: `${firstDir};${secondDir}`,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        } satisfies NodeJS.ProcessEnv;
        assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
      });
    });
  });
});

describe("resolveAvailableEditors", () => {
  it("returns only editors whose launch commands are available", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-editors-"));
    try {
      fs.writeFileSync(path.join(dir, "cursor.CMD"), "@echo off\r\n", "utf8");
      fs.writeFileSync(path.join(dir, "explorer.EXE"), "MZ", "utf8");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["cursor", "file-manager"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects supported mac editors from app bundles without PATH commands", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-editors-home-"));
    try {
      fs.mkdirSync(path.join(homeDir, "Applications", "Zed.app"), { recursive: true });
      const editors = resolveAvailableEditors("darwin", {
        HOME: homeDir,
        PATH: "",
      });
      assert.deepEqual(editors, ["zed", "file-manager"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("resolveAvailableTerminalApps", () => {
  it("returns only supported terminal apps whose launch commands are available", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-terminals-"));
    try {
      fs.writeFileSync(path.join(dir, "warp.CMD"), "@echo off\r\n", "utf8");
      const terminals = resolveAvailableTerminalApps("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(terminals, ["warp"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects mac terminal apps from Applications without CLI shims", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-terminal-apps-"));
    try {
      fs.mkdirSync(path.join(homeDir, "Applications", "Terminal.app"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, "Applications", "Warp.app"), { recursive: true });
      const terminals = resolveAvailableTerminalApps("darwin", {
        HOME: homeDir,
        PATH: "",
      });
      assert.deepEqual(terminals, ["terminal", "warp"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
