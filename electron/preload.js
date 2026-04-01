const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trackerApi", {
  getDashboard: () => ipcRenderer.invoke("tracker:get-dashboard"),
  getReport: (period) => ipcRenderer.invoke("tracker:get-report", period),
  forceSync: () => ipcRenderer.invoke("tracker:force-sync"),
  queueSync: (reason) => ipcRenderer.invoke("tracker:queue-sync", reason),
  openScreenshot: (screenshotPath) => ipcRenderer.invoke("tracker:open-screenshot", screenshotPath),
  login: (payload) => ipcRenderer.invoke("tracker:auth-login", payload),
  logout: () => ipcRenderer.invoke("tracker:auth-logout"),
  getSession: () => ipcRenderer.invoke("tracker:auth-session"),
  refreshSession: () => ipcRenderer.invoke("tracker:auth-refresh"),
  openErpLogin: () => ipcRenderer.invoke("tracker:open-erp-login"),
  onUpdate: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("tracker:update", listener);
    return () => {
      ipcRenderer.removeListener("tracker:update", listener);
    };
  }
});
