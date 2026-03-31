const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const log = require("electron-log");
const { resolveRendererEntry } = require("./services/config");
const { DataStore } = require("./services/data-store");
const { TrackerService } = require("./services/tracker-service");
const { LocalApiServer } = require("./services/local-api-server");
const { SyncService } = require("./services/sync-service");
const { createDashboardPayload } = require("./services/report-service");

let mainWindow;
let dataStore;
let trackerService;
let localApiServer;
let syncService;

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

  localApiServer = new LocalApiServer({
    dataStore,
    syncService
  });

  trackerService = new TrackerService({
    dataStore,
    onUpdate: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("tracker:update");
      }
    }
  });

  await trackerService.start();
  localApiServer.start();
  syncService.start();
  syncService.queueDesktopSnapshot("startup");

  log.info("Employee Desktop Tracker started.");
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
    syncService.queueDesktopSnapshot("shutdown");
    await syncService.flushQueue();
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
