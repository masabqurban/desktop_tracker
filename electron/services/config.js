const path = require("path");

const DEFAULTS = {
  pollIntervalMs: 2000,
  idleThresholdSeconds: 600,
  localApiPort: 3002,
  maxTimelineEvents: 20000,
  syncIntervalMs: 60000,
  erpBaseUrl: process.env.ERP_BASE_URL || "https://erp.vendaxis.com",
  erpDesktopEndpoint: process.env.ERP_DESKTOP_ENDPOINT || "https://erp.vendaxis.com/api/admin/tracker/desktop-activity",
  erpBrowserEndpoint: process.env.ERP_BROWSER_ENDPOINT || "https://erp.vendaxis.com/api/admin/tracker/browser-activity",
  erpScreenshotEndpoint: process.env.ERP_SCREENSHOT_ENDPOINT || "https://erp.vendaxis.com/api/admin/tracker/screenshot",
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
