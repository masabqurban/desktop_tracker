const path = require("path");

const DEFAULTS = {
  pollIntervalMs: 2000,
  idleThresholdSeconds: 300,
  localApiPort: 3002,
  maxTimelineEvents: 20000,
  syncIntervalMs: 60000,
  erpBaseUrl: process.env.ERP_BASE_URL || "http://127.0.0.1:8000",
  erpDesktopEndpoint: process.env.ERP_DESKTOP_ENDPOINT || "http://127.0.0.1:8000/api/admin/tracker/desktop-activity",
  erpBrowserEndpoint: process.env.ERP_BROWSER_ENDPOINT || "http://127.0.0.1:8000/api/admin/tracker/browser-activity",
  erpScreenshotEndpoint: process.env.ERP_SCREENSHOT_ENDPOINT || "http://127.0.0.1:8000/api/admin/tracker/screenshot",
  erpAuthToken: process.env.ERP_AUTH_TOKEN || "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
};

function resolveRendererEntry(app) {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }

  return `file://${path.join(app.getAppPath(), "dist", "index.html")}`;
}

module.exports = {
  DEFAULTS,
  resolveRendererEntry
};
