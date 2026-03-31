const path = require("path");

const DEFAULTS = {
  pollIntervalMs: 2000,
  idleThresholdSeconds: 60,
  localApiPort: 3002,
  maxTimelineEvents: 20000,
  syncIntervalMs: 60000,
  erpDesktopEndpoint: process.env.ERP_DESKTOP_ENDPOINT || "http://localhost:8000/api/desktop-activity",
  erpBrowserEndpoint: process.env.ERP_BROWSER_ENDPOINT || "http://localhost:8000/api/browser-activity",
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
