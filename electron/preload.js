const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trackerApi", {
  getDashboard: () => ipcRenderer.invoke("tracker:get-dashboard"),
  getReport: (period) => ipcRenderer.invoke("tracker:get-report", period),
  forceSync: () => ipcRenderer.invoke("tracker:force-sync"),
  queueSync: (reason) => ipcRenderer.invoke("tracker:queue-sync", reason),
  openScreenshot: (screenshotPath) => ipcRenderer.invoke("tracker:open-screenshot", screenshotPath),
  onUpdate: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("tracker:update", listener);
    return () => {
      ipcRenderer.removeListener("tracker:update", listener);
    };
  }
});
