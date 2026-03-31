const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trackerApi", {
  getDashboard: () => ipcRenderer.invoke("tracker:get-dashboard"),
  getReport: (period) => ipcRenderer.invoke("tracker:get-report", period),
  forceSync: () => ipcRenderer.invoke("tracker:force-sync"),
  queueSync: (reason) => ipcRenderer.invoke("tracker:queue-sync", reason),
  onUpdate: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("tracker:update", listener);
    return () => {
      ipcRenderer.removeListener("tracker:update", listener);
    };
  }
});
