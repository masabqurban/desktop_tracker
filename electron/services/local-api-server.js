const express = require("express");
const cors = require("cors");
const { createDashboardPayload, buildRange, topApps } = require("./report-service");
const { DEFAULTS } = require("./config");

class LocalApiServer {
   constructor({ dataStore, syncService }) {
     const { detectInstalledBrowsers } = require("./browser-detector");
     this.dataStore = dataStore;
     this.syncService = syncService;
     this.app = null;
     this.server = null;
     this.detectInstalledBrowsers = detectInstalledBrowsers;
  }

  getDashboard() {
    const snapshot = this.dataStore.getSnapshot();
    return createDashboardPayload(snapshot);
  }

  start(port = DEFAULTS.localApiPort) {
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json({ limit: "2mb" }));
     // Initialize browser status with all detected browsers
     const installed = this.detectInstalledBrowsers();
     this.dataStore.setInstalledBrowsers(installed);
     this.dataStore.persist();

    this.app.get("/health", (_req, res) => {
      res.json({ ok: true, service: "employee-desktop-tracker", timestamp: Date.now() });
    });

    this.app.post("/browser-activity", (req, res) => {
      const body = req.body || {};
      const normalizedBrowser = body?.browser && body.browser !== "undefined" ? body.browser : "Unknown";
      const normalized = {
        ...body,
        timestamp: body?.event?.timestamp || body?.timestamp || Date.now(),
        browser: normalizedBrowser
      };

      // Handle extension snapshots
      if (body?.type === "extension_snapshot") {
        this.dataStore.updateExtensionData(body.data);
        this.dataStore.updateBrowserStatus(normalizedBrowser, true);
      } else {
        this.dataStore.updateBrowserStatus(normalizedBrowser, true);
      }

      // Track browser context (incognito vs normal)
      if (body?.event?.isIncognito) {
        this.dataStore.recordBrowserContext(true);
      } else if (body?.event?.isIncognito === false) {
        this.dataStore.recordBrowserContext(false);
      }

      this.dataStore.addBrowserEvent(normalized);
      this.dataStore.persist();

      res.json({ ok: true });
    });

    this.app.post("/api/extension-status", (req, res) => {
      const { enabled } = req.body || {};
      if (typeof enabled === "boolean") {
        this.dataStore.updateExtensionStatus(enabled);
        this.dataStore.persist();
      }
      res.json({ ok: true });
    });

    this.app.get("/api/dashboard", (_req, res) => {
      res.json({ ok: true, data: this.getDashboard() });
    });

    this.app.get("/api/reports/:period", (req, res) => {
      const snapshot = this.dataStore.getSnapshot();
      const period = req.params.period;
      const days = period === "daily" ? 1 : period === "weekly" ? 7 : 30;
      const summary = buildRange(snapshot, days);
      res.json({
        ok: true,
        period,
        summary: {
          ...summary,
          topApps: topApps(summary.appUsageMs)
        }
      });
    });

    this.app.post("/api/sync/erp", async (_req, res) => {
      const result = await this.syncService.flushQueue();
      res.json(result);
    });

    this.app.get("/api/sync-status", (_req, res) => {
      const snapshot = this.dataStore.getSnapshot();
      const syncControl = snapshot.syncControl || {};

      res.json({
        ok: true,
        lastSyncAt: snapshot.lastSyncAt || null,
        lastSuccessfulSummarySyncAt: syncControl.lastSuccessfulSummarySyncAt || null,
        lastWeeklyResetAt: syncControl.lastWeeklyResetAt || null,
        lastMonthlyResetAt: syncControl.lastMonthlyResetAt || null
      });
    });

    this.app.get("/api/office-hours-status", (_req, res) => {
      const snapshot = this.dataStore.getSnapshot();
      const session = snapshot.auth || {};
      const employee = session.employee || null;
      const isAuthenticated = Boolean(session.isAuthenticated && session.token);
      const isOnBreak = Boolean(employee?.isOnBreak);
      const hasOfficeIn = Boolean(employee?.officeIn);
      const hasOfficeOut = Boolean(employee?.officeOut);
      const isTrackingActive = isAuthenticated && hasOfficeIn && !hasOfficeOut && !isOnBreak;

      res.json({
        ok: true,
        isAuthenticated,
        isWithinOfficeHours: isTrackingActive,
        isTrackingActive,
        isOnBreak,
        employee: employee ? {
          id: employee.id,
          name: employee.name,
          officeIn: employee.officeIn,
          officeOut: employee.officeOut
        } : null
      });
    });

    this.server = this.app.listen(port);
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

module.exports = {
  LocalApiServer
};
