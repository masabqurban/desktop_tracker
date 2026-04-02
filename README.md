# Employee Desktop Tracker (Electron + React)

Cross-platform desktop tracking app for Windows, macOS, and Linux.

## What It Tracks

- Mouse and keyboard activity counts (global hooks)
- Idle and active state (system idle detection)
- Active/foreground app detection
- App switch activity
- Opened apps history
- Time spent per app
- Daily, weekly, monthly reports
- Recent desktop and browser events

## Browser Extension Integration

This app exposes a local API for the existing browser extension:

- Extension target endpoint: `http://localhost:3002/browser-activity`
- Endpoint in this app: `POST /browser-activity`

The extension already points to this port and route, so browser events are automatically ingested when this desktop app is running.

## ERP (Laravel + Inertia + MySQL) Integration

Queued sync is included. The app sends payloads to Laravel APIs:

- Desktop analytics: `ERP_DESKTOP_ENDPOINT`
- Browser events: `ERP_BROWSER_ENDPOINT`
- Optional bearer auth: `ERP_AUTH_TOKEN`

Configure in `.env` (copy from `.env.example`).

## API Endpoints (Local Desktop App)

- `GET /health`
- `POST /browser-activity`
- `GET /api/dashboard`
- `GET /api/reports/daily`
- `GET /api/reports/weekly`
- `GET /api/reports/monthly`
- `POST /api/sync/erp`

Default local port: `3002`

## Run in Development

```bash
npm install
npm run dev
```

## Build Desktop App

```bash
npm run dist
```

This builds installers for:

- Windows (`nsis`)
- macOS (`dmg`/default electron-builder target)
- Linux (`AppImage`, `deb`)

## Build Windows Installer Only

Recommended (auto-clean + retry fallback for occasional `rcedit` lock issues):

```bash
npm run dist:win
```

Raw command (no fallback):

```bash
npm run dist:win:raw
```

If packaging fails with `Fatal error: Unable to commit changes`, close any running `Employee Desktop Tracker` or `electron` process and run `npm run dist:win` again.

## Build macOS Installer When You Only Have Windows

You cannot reliably produce a macOS DMG installer locally from Windows.

Use the included GitHub Actions workflow on a macOS runner:

1. Push this project to GitHub.
2. Open Actions tab and run workflow: Build Mac Installer.
3. Download artifacts: `mac-installer-arm64` and `mac-installer-x64`.
4. Send the correct `.dmg` to the Mac employee:
	- Apple Silicon (M1/M2/M3): arm64
	- Intel Mac: x64

Workflow file:

- `.github/workflows/build-mac.yml`

Available mac build scripts (used by CI and usable on a real Mac):

- `npm run dist:mac:arm64`
- `npm run dist:mac:x64`

Note: `dist:mac:universal` can fail when native modules are present (for example `active-win`), so prefer arch-specific builds.

## Notes on Cross-Platform Support

Electron supports all three target OS platforms.

- `active-win` supports Windows/macOS/Linux for active window/app detection.
- `uiohook-napi` supports global mouse/keyboard hooks on all three but may require accessibility/input permissions on macOS and some Linux desktop setups.
- On strict environments where global hooks are restricted, app usage and idle tracking still continue, while key/mouse counts may be limited.

## Suggested Laravel Endpoints

1. `POST /api/desktop-activity`
2. `POST /api/browser-activity`

Store the payloads in MySQL and aggregate in Laravel for ERP dashboards.
