# T3 Code Mobile Shell

This workspace hosts the Capacitor iOS shells for the remote client.

## Current scope

- Wrap the existing `apps/web` frontend.
- Preserve the desktop-oriented layout on iPad.
- Adapt the same shared frontend into a compact iPhone shell with a collapsible sidebar.
- Connect to either a manually configured remote backend profile or a Bonjour-discovered backend from the shared web settings UI.
- Do not introduce a second frontend stack.

## Local workflow

```bash
bun run --cwd apps/mobile cap:sync
bun run --cwd apps/mobile cap:open:ios
```

The sync step builds `apps/web` and copies its static bundle into the native shell.

## Notes

- V1 assumes trusted-network access on the local network.
- The shell reuses the same WebSocket protocol as the browser and desktop shells.
- Bonjour discovery is implemented natively on iOS and exposed through the shared settings UI.
- If you connect to `ws://` / `http://` backends on iPad or iPhone, the generated iOS project may require App Transport Security exceptions for your local-network environment.
