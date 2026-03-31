# Employee Desktop Tracker - Complete Tracking Features

## Updates (April 1, 2026)

### 1. ✅ Fixed Idle Time Tracking
- **Issue**: Idle time was showing 0s because system idle detection only tracks lock/sleep
- **Solution**: Implemented activity-based idle timeout detection
  - Tracks actual user inactivity (keyboard/mouse)
  - 60-second timeout = idle state
  - Resets on any keyboard or mouse activity
- **Result**: Now correctly tracks time spent idle vs active

### 2. ✅ Complete Browser Event Tracking
- **Browser Events**: Now shows ALL browser events (increased from 100 to 300+ displayed)
- **Toggle Display**: "Show All" / "Show Recent" buttons for toggling
- **Event Details**: Each event displays:
  - Event type (session_start, tab, navigation, idle)
  - Timestamp with precise time
  - Incognito indicator (🔒) for private browser sessions

### 3. ✅ Extension Status Monitoring
- **Current Status**: Shows if extension is enabled or disabled
- **Uptime Percentage**: Calculates % of time extension has been enabled
- **Duration Tracking**:
  - Total time enabled
  - Total time disabled
  - Last state change timestamp
- **Auto-Tracking**: Automatically tracks state changes

### 4. ✅ Browser Context Detection
- **Normal Tabs**: Tracks count of regular browsing sessions
- **Incognito Mode**: 
  - Detects when user browses in private/incognito mode
  - Shows 🔒 indicator on incognito events
  - Separate count for incognito vs normal sessions
- **Note**: Requires extension permission "Allow in Incognito" in browser settings

## Desktop Activity Tracking

### Mouse & Keyboard
- Global keyboard event count (all keypresses)
- Global mouse event count (all clicks/movement)
- Activity-based idle detection

### Application Tracking
- Currently active/foreground app
- Time spent per app
- App switch counts
- List of opened apps with first/last seen timestamps

### Idle Detection
- Based on user activity (not system sleep)
- 60-second no-input = idle
- Separate tracking of active vs idle time
- Daily/weekly/monthly idle summaries

## Reports & Analytics

### Time Periods
- **Daily**: Today's tracked, idle, and app switches
- **Weekly**: Rolling last 7 days
- **Monthly**: Rolling last 30 days

### Data Displayed
- Total tracked time
- Total idle time
- Keyboard & mouse event counts
- Number of opened apps
- Pending ERP sync queue size
- Most used apps (top 15)
- Daily breakdown (last 30 days)

### Browser Integration
- Extension enabled/disabled duration and %
- Browser context (normal vs incognito tabs)
- Receives events from Chrome, Edge, Firefox, Safari
- All browser events logged with timestamps
- Incognito mode clearly marked

## Technical Implementation

### Desktop Tracker Services
1. **tracker-service.js**: 
   - Polls every 2 seconds
   - Detects active app via `active-win`
   - Captures global input via `uiohook-napi`
   - Manages idle timeout (60s)
   
2. **data-store.js**: 
   - Persists to `tracker-data.json`
   - Tracks events, apps, daily stats
   - Records extension status
   - Records browser context

3. **report-service.js**:
   - Generates dashboard payloads
   - Aggregates daily/weekly/monthly stats
   - Calculates extension uptime %

4. **local-api-server.js**:
   - Exposes `/browser-activity` endpoint for extension
   - Endpoint `/api/extension-status` for status updates
   - Tracks incognito context from browser events

### Browser Extension Updates
- Modified `background.js` to:
  - Detect `tab.incognito` property
  - Include `isIncognito` flag in all events
  - Report on both regular and incognito tabs

## Running the Updated App

### Development
```bash
cd employee-desktop-tracker
npm install  # if dependencies updated
npm run dev
```
This starts:
- Vite dev server on http://localhost:5173
- Electron app connected to dev server
- Desktop tracking service
- Local API server on http://localhost:3002
- Browser extension connects automatically

### Production
```bash
npm run build
npm start
```

### Building Installers
```bash
npm run dist
```
Creates native installers for:
- Windows (.nsis)
- macOS (.dmg)
- Linux (.AppImage, .deb)

## Browser Extension Integration

### Chrome/Edge
1. Go to `chrome://extensions` (or `edge://extensions`)
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `browser-activity-tracker-extension` folder
5. In extension settings, enable "Allow in Incognito" to track private browsing

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select any file from `browser-activity-tracker-extension` folder

### Safari
Use the Safari Web Extension converter (see README.md in extension folder)

## ERP Sync

All collected data is queued for sync to Laravel ERP:
- Desktop activity: `POST /api/desktop-activity`
- Browser events: `POST /api/browser-activity`

Configure in `.env`:
```
ERP_DESKTOP_ENDPOINT=http://localhost:8000/api/desktop-activity
ERP_BROWSER_ENDPOINT=http://localhost:8000/api/browser-activity
ERP_AUTH_TOKEN=your-token-here
```

## Data Storage

### Local Storage
- File: `~/.config/employee-desktop-tracker/tracker-data.json` (Linux/macOS)
- File: `%APPDATA%\employee-desktop-tracker\tracker-data.json` (Windows)
- Contains: All events, app usage, daily stats, sync queue, extension status

### Sync Queue
- Persisted locally until successful delivery
- Automatic retry on ERP endpoint unavailability
- Manual "Sync to ERP" button in dashboard
- Shows pending items count
