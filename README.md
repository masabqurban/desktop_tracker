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

## Notes on Cross-Platform Support

Electron supports all three target OS platforms.

- `active-win` supports Windows/macOS/Linux for active window/app detection.
- `uiohook-napi` supports global mouse/keyboard hooks on all three but may require accessibility/input permissions on macOS and some Linux desktop setups.
- On strict environments where global hooks are restricted, app usage and idle tracking still continue, while key/mouse counts may be limited.

## Suggested Laravel Endpoints

1. `POST /api/desktop-activity`
2. `POST /api/browser-activity`

Store the payloads in MySQL and aggregate in Laravel for ERP dashboards.
