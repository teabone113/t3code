# T3 Code

This repository is a fork of [T3 Chat / T3 Code](https://github.com/pingdotgg/t3code).

The upstream project is the original source for the app and its community history. This fork extends it with a more explicit `backend + multiple frontend shells` architecture, remote-shell support, and mobile/tablet clients.

## What This Fork Adds

- A clearer split between the backend runtime and frontend shells.
- Desktop shell modes for:
  - frontend only
  - backend only
  - both
- iPad and iPhone shells built from the shared web frontend.
- Manual remote backend connection from frontend shells.
- Bonjour auto-discovery of available backends on the local network.
- Shared desktop/mobile access to the same running backend instance.

## Architecture

### Backend

The backend is the canonical runtime. It:

- hosts the orchestration state for projects, threads, sessions, and turns
- starts and manages the Codex app-server integration
- exposes the WebSocket/API surface used by every shell
- can run headless on a separate machine
- advertises itself on the LAN via Bonjour for shell discovery

### Frontend Shells

This fork treats the UI as a set of shells over the same backend.

- Desktop shell
  - Electron app
  - can run in `frontend only`, `backend only`, or `both` mode
  - can connect to a local or remote backend

- Tablet shell
  - iPad shell built with Capacitor over the shared web app
  - desktop-style layout, but frontend-only

- Mobile shell
  - iPhone shell built from the same shared frontend
  - compact layout with a collapsible left panel
  - frontend-only

- Browser shell
  - the web frontend can also connect directly to a backend

### Backend Discovery

Frontend shells can connect to backends in two ways:

- Manual entry
  - enter host, port, and protocol directly

- Auto-discovery
  - browse Bonjour-advertised backends on the local network
  - supported in the desktop and iOS shells

## Codex

> [!WARNING]
> You need to have [Codex CLI](https://github.com/openai/codex) installed and authorized for T3 Code to work.

This project is currently Codex-first. The backend starts `codex app-server` and the shells connect to the backend over the shared app protocol.

## Running

### Task Runner

This repo now includes a root [Task](https://taskfile.dev) file for common development workflows.

```bash
task
```

Useful examples:

```bash
task install
task dev
task check
task backend:headless
task mobile:open:ios
task version:get
task version:set:release VERSION=0.0.6
task release:desktop:dmg:arm64
```

### Desktop App

You can package the macOS desktop app as a DMG:

```bash
bun run build:desktop-artifact
```

Release artifacts are written to [release](/Users/trevor/Projects/t3code/release).

### Local Development

From the repo root:

```bash
bun install
bun run dev
```

### Headless Backend

To run only the backend for remote shells:

```bash
bun run build
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --no-browser
```

Then connect a shell to that machine either by:

- entering the backend address manually
- selecting it from Bonjour discovery on the same LAN

## Notes

- This is still an early-stage project. Expect rough edges.
- Upstream project: [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
