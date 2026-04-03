const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { powerMonitor } = require("electron");
const fs = require("fs");
const log = require("electron-log");
const { resolveRendererEntry } = require("./services/config");
const { DataStore } = require("./services/data-store");
const { TrackerService } = require("./services/tracker-service");
const { LocalApiServer } = require("./services/local-api-server");
const { SyncService } = require("./services/sync-service");
const { AuthService } = require("./services/auth-service");
const { DEFAULTS } = require("./services/config");
const { createDashboardPayload } = require("./services/report-service");

let mainWindow;
let dataStore;
let trackerService;
let localApiServer;
let syncService;
let authService;
let powerHandlersRegistered = false;
let lastTrackerIdle = false;
let profileRefreshInFlight = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const entry = resolveRendererEntry(app);
  mainWindow.loadURL(entry);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

async function bootstrapServices() {
  dataStore = new DataStore();
  dataStore.init(app.getPath("userData"));

  syncService = new SyncService({
    dataStore,
    getDashboardPayload: () => createDashboardPayload(dataStore.getSnapshot())
  });

  authService = new AuthService({
    dataStore,
    erpBaseUrl: DEFAULTS.erpBaseUrl
  });

  // Validate stored auth token on startup (in case token expired while app was closed)
  await authService.validateStoredAuthToken();
  await syncService.handleEmployeeStateChange("startup_validate");

  localApiServer = new LocalApiServer({
    dataStore,
    syncService
  });

  trackerService = new TrackerService({
    dataStore,
    onUpdate: async (update) => {
      const currentlyIdle = Boolean(update?.idle);
      const idleStarted = currentlyIdle && !lastTrackerIdle;
      lastTrackerIdle = currentlyIdle;

      if (idleStarted) {
        await refreshAuthProfileForStateCheck("idle_start");
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("tracker:update");
      }
    }
  });

  await trackerService.start();
  localApiServer.start();
  syncService.start();
  registerPowerMonitorHandlers();

  log.info("Employee Desktop Tracker started.");
}

async function refreshAuthProfileForStateCheck(triggerReason) {
  if (profileRefreshInFlight) {
    return;
  }

  profileRefreshInFlight = true;
  try {
    const session = authService.getSession();
    if (!session?.isAuthenticated || !session?.token) {
      await syncService.handleEmployeeStateChange(`${triggerReason}_no_session`);
      return;
    }

    await authService.refreshEmployeeProfile();
    await syncService.handleEmployeeStateChange(`${triggerReason}_profile_refresh`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("tracker:update");
    }
  } catch {
    // Ignore transient refresh errors; next trigger will retry.
  } finally {
    profileRefreshInFlight = false;
  }
}

function registerPowerMonitorHandlers() {
  if (powerHandlersRegistered) {
    return;
  }

  powerHandlersRegistered = true;

  powerMonitor.on("suspend", async () => {
    try {
      if (trackerService?.handleSystemSuspend) {
        await trackerService.handleSystemSuspend();
      }
      await syncService.handleEmployeeStateChange("power_suspend");
    } catch {
      // Best effort only; poll/refresh loop still restores state.
    }
  });

  powerMonitor.on("resume", async () => {
    try {
      if (trackerService?.handleSystemResume) {
        trackerService.handleSystemResume();
      }

      const session = authService.getSession();
      if (session?.isAuthenticated && session?.token) {
        await authService.refreshEmployeeProfile();
      }

      await syncService.handleEmployeeStateChange("power_resume");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("tracker:update");
      }
    } catch {
      // Ignore transient resume refresh errors.
    }
  });

  powerMonitor.on("lock-screen", async () => {
    try {
      await refreshAuthProfileForStateCheck("lock_screen");
    } catch {
      // Ignore transient lock-screen refresh errors.
    }
  });

  powerMonitor.on("unlock-screen", async () => {
    try {
      await refreshAuthProfileForStateCheck("unlock_screen");
    } catch {
      // Ignore transient unlock-screen refresh errors.
    }
  });
}

function registerIpc() {
  ipcMain.handle("tracker:get-dashboard", async () => {
    return createDashboardPayload(dataStore.getSnapshot());
  });

  ipcMain.handle("tracker:get-report", async (_event, period) => {
    const dashboard = createDashboardPayload(dataStore.getSnapshot());
    if (period === "daily") {
      return dashboard.periods.daily;
    }
    if (period === "weekly") {
      return dashboard.periods.weekly;
    }
    return dashboard.periods.monthly;
  });

  ipcMain.handle("tracker:force-sync", async () => {
    return syncService.flushQueue();
  });

  ipcMain.handle("tracker:queue-sync", async (_event, reason) => {
    syncService.queueDesktopSnapshot(reason || "manual");
    return { ok: true };
  });

  ipcMain.handle("tracker:open-screenshot", async (_event, screenshotPath) => {
    if (!screenshotPath || typeof screenshotPath !== "string") {
      return { ok: false, error: "Invalid screenshot path" };
    }

    const normalizedPath = path.normalize(screenshotPath);
    if (!fs.existsSync(normalizedPath)) {
      return { ok: false, error: "Screenshot file not found" };
    }

    const openError = await shell.openPath(normalizedPath);
    if (openError) {
      return { ok: false, error: openError };
    }

    return { ok: true };
  });

  ipcMain.handle("tracker:auth-login", async (_event, payload) => {
    try {
      const session = await authService.login(payload || {});
      await syncService.handleEmployeeStateChange("auth_login");
      return { ok: true, session };
    } catch (error) {
      return { ok: false, error: error?.response?.data?.message || error?.message || "Login failed" };
    }
  });

  ipcMain.handle("tracker:auth-logout", async () => {
    const session = await authService.logout();
    await syncService.handleEmployeeStateChange("auth_logout");
    return { ok: true, session };
  });

  ipcMain.handle("tracker:auth-session", async () => {
    return { ok: true, session: authService.getSession() };
  });

  ipcMain.handle("tracker:auth-refresh", async () => {
    try {
      const session = await authService.refreshEmployeeProfile();
      await syncService.handleEmployeeStateChange("manual_profile_refresh");
      return { ok: true, session };
    } catch (error) {
      return { ok: false, error: error?.response?.data?.message || error?.message || "Profile refresh failed" };
    }
  });

  ipcMain.handle("tracker:open-erp-login", async () => {
    const loginUrl = `${DEFAULTS.erpBaseUrl.replace(/\/+$/, "")}/`;
    await shell.openExternal(loginUrl);
    return { ok: true, url: loginUrl };
  });
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  await bootstrapServices();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (syncService) {
    syncService.stop();
  }

  if (trackerService) {
    await trackerService.stop();
  }

  if (localApiServer) {
    localApiServer.stop();
  }

  if (dataStore) {
    dataStore.persist();
  }
});
