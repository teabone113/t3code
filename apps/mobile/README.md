# T3 Code Mobile Shell

This workspace hosts the Capacitor shell for the iPad-first remote client.

## Current scope

- Wrap the existing `apps/web` frontend.
- Preserve the desktop-oriented layout on iPad.
- Connect to a manually configured remote backend profile from the shared web settings UI.
- Do not introduce a second frontend stack.

## Local workflow

```bash
bun run --cwd apps/mobile cap:sync
bun run --cwd apps/mobile cap:open:ios
```

The sync step builds `apps/web` and copies its static bundle into the native shell.

## Notes

- V1 assumes trusted-network access with manual backend profiles.
- The shell reuses the same WebSocket protocol as the browser and desktop shells.
- If you connect to `ws://` / `http://` backends on iPad, the generated iOS project may require App Transport Security exceptions for your local-network environment.
