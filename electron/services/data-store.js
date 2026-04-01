const fs = require("fs");
const path = require("path");
const { DEFAULTS } = require("./config");

const INITIAL_DATA = {
  events: [],
  browserEvents: [],
  appUsageMs: {},
  openedApps: {},
  daily: {},
  extensionStatus: {
    enabled: true,
    enabledAt: Date.now(),
    disabledAt: null,
    totalEnabledMs: 0,
    totalDisabledMs: 0,
    lastStateChange: Date.now()
  },
  browserStatus: {
    Chrome: { enabled: false, enabledAt: null, totalEnabledMs: 0 },
    Edge: { enabled: false, enabledAt: null, totalEnabledMs: 0 },
    Firefox: { enabled: false, enabledAt: null, totalEnabledMs: 0 },
    Opera: { enabled: false, enabledAt: null, totalEnabledMs: 0 },
    Safari: { enabled: false, enabledAt: null, totalEnabledMs: 0 }
  },
  installedBrowsers: {},
   extensionData: {
     topDomains: [],
     totalTabMs: 0,
     totalIdleMs: 0,
     daily: {
       tabMs: 0,
       idleMs: 0,
       eventCount: 0,
       topDomains: []
     },
     weekly: {
       tabMs: 0,
       idleMs: 0,
       eventCount: 0,
       topDomains: []
     },
     monthly: {
       tabMs: 0,
       idleMs: 0,
       eventCount: 0,
       topDomains: []
     },
     productivity: 0
   },
  browserContext: {
    incognito: 0,
    normal: 0
  },
  screenshots: [],
  idleStartTime: null,
  lastSnapshotAt: null,
  lastSyncAt: null,
  syncQueue: []
};

function formatDateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

class DataStore {
  constructor() {
    this.filePath = "";
    this.data = JSON.parse(JSON.stringify(INITIAL_DATA));
  }

  init(baseDir) {
    this.filePath = path.join(baseDir, "tracker-data.json");
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = { ...JSON.parse(JSON.stringify(INITIAL_DATA)), ...parsed };
    } catch {
      this.data = JSON.parse(JSON.stringify(INITIAL_DATA));
      this.persist();
    }
  }

  persist() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }

  addOpenedApp(appName, timestamp) {
    if (!appName) {
      return;
    }

    const current = this.data.openedApps[appName] || { firstSeenAt: timestamp, lastSeenAt: timestamp };
    current.lastSeenAt = timestamp;
    this.data.openedApps[appName] = current;
  }

  addAppUsage(appName, durationMs, timestamp, isIdle) {
    if (!appName || durationMs <= 0) {
      return;
    }

    this.data.appUsageMs[appName] = (this.data.appUsageMs[appName] || 0) + durationMs;

    const key = formatDateKey(timestamp);
    const daily = this.data.daily[key] || {
      activeMs: 0,
      idleMs: 0,
      keyboardCount: 0,
      mouseCount: 0,
      appUsageMs: {},
      appSwitches: 0,
      browserEvents: 0,
      desktopEvents: 0
    };

    if (isIdle) {
      daily.idleMs += durationMs;
    } else {
      daily.activeMs += durationMs;
    }

    daily.appUsageMs[appName] = (daily.appUsageMs[appName] || 0) + durationMs;
    this.data.daily[key] = daily;
  }

  addInputCount(type, count, timestamp) {
    const key = formatDateKey(timestamp);
    const daily = this.data.daily[key] || {
      activeMs: 0,
      idleMs: 0,
      keyboardCount: 0,
      mouseCount: 0,
      appUsageMs: {},
      appSwitches: 0,
      browserEvents: 0,
      desktopEvents: 0
    };

    if (type === "keyboard") {
      daily.keyboardCount += count;
    }

    if (type === "mouse") {
      daily.mouseCount += count;
    }

    this.data.daily[key] = daily;
  }

  incrementAppSwitch(timestamp) {
    const key = formatDateKey(timestamp);
    const daily = this.data.daily[key] || {
      activeMs: 0,
      idleMs: 0,
      keyboardCount: 0,
      mouseCount: 0,
      appUsageMs: {},
      appSwitches: 0,
      browserEvents: 0,
      desktopEvents: 0
    };

    daily.appSwitches += 1;
    this.data.daily[key] = daily;
  }

  addDesktopEvent(event) {
    this.data.events.push(event);
    if (this.data.events.length > DEFAULTS.maxTimelineEvents) {
      this.data.events = this.data.events.slice(-DEFAULTS.maxTimelineEvents);
    }

    const key = formatDateKey(event.timestamp || Date.now());
    const daily = this.data.daily[key] || {
      activeMs: 0,
      idleMs: 0,
      keyboardCount: 0,
      mouseCount: 0,
      appUsageMs: {},
      appSwitches: 0,
      browserEvents: 0,
      desktopEvents: 0
    };

    daily.desktopEvents += 1;
    this.data.daily[key] = daily;
  }

  addBrowserEvent(event) {
    this.data.browserEvents.push(event);
    if (this.data.browserEvents.length > DEFAULTS.maxTimelineEvents) {
      this.data.browserEvents = this.data.browserEvents.slice(-DEFAULTS.maxTimelineEvents);
    }

    const key = formatDateKey(event.timestamp || Date.now());
    const daily = this.data.daily[key] || {
      activeMs: 0,
      idleMs: 0,
      keyboardCount: 0,
      mouseCount: 0,
      appUsageMs: {},
      appSwitches: 0,
      browserEvents: 0,
      desktopEvents: 0
    };

    daily.browserEvents += 1;
    this.data.daily[key] = daily;
  }

  queueForSync(payload) {
    this.data.syncQueue.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      payload,
      createdAt: Date.now(),
      attempts: 0
    });
  }

  markSyncSuccess(ids) {
    const idSet = new Set(ids);
    this.data.syncQueue = this.data.syncQueue.filter((item) => !idSet.has(item.id));
    this.data.lastSyncAt = Date.now();
  }

  markSyncAttempt(ids) {
    const idSet = new Set(ids);
    this.data.syncQueue = this.data.syncQueue.map((item) => {
      if (!idSet.has(item.id)) {
        return item;
      }

      return {
        ...item,
        attempts: item.attempts + 1
      };
    });
  }

  touchSnapshot(timestamp) {
    this.data.lastSnapshotAt = timestamp;
  }

  updateExtensionStatus(enabled) {
    const now = Date.now();
    if (this.data.extensionStatus.enabled === enabled) {
      return;
    }

    const duration = now - this.data.extensionStatus.lastStateChange;
    if (this.data.extensionStatus.enabled) {
      this.data.extensionStatus.totalEnabledMs += duration;
    } else {
      this.data.extensionStatus.totalDisabledMs += duration;
    }

    this.data.extensionStatus.enabled = enabled;
    this.data.extensionStatus.lastStateChange = now;
    if (enabled) {
      this.data.extensionStatus.enabledAt = now;
      this.data.extensionStatus.disabledAt = null;
    } else {
      this.data.extensionStatus.disabledAt = now;
    }
  }

  recordBrowserContext(isIncognito) {
    if (isIncognito) {
      this.data.browserContext.incognito += 1;
    } else {
      this.data.browserContext.normal += 1;
    }
  }

  updateBrowserStatus(browserName, enabled) {
    if (!browserName || browserName === "undefined" || browserName === "Unknown") {
      return;
    }
    if (!this.data.browserStatus[browserName]) {
      this.data.browserStatus[browserName] = { enabled: false, enabledAt: null, totalEnabledMs: 0 };
    }
    const status = this.data.browserStatus[browserName];
    if (status.enabled !== enabled) {
      if (status.enabled && status.enabledAt) {
        status.totalEnabledMs += Date.now() - status.enabledAt;
      }
      status.enabled = enabled;
      if (enabled) {
        status.enabledAt = Date.now();
      }
    }
  }

  setInstalledBrowsers(installedMap) {
    this.data.installedBrowsers = { ...(installedMap || {}) };

    delete this.data.browserStatus.undefined;
    delete this.data.browserStatus.Unknown;

    for (const [browserName, info] of Object.entries(this.data.installedBrowsers)) {
      if (!info?.installed) {
        continue;
      }

      if (!this.data.browserStatus[browserName]) {
        this.data.browserStatus[browserName] = {
          enabled: false,
          enabledAt: null,
          totalEnabledMs: 0
        };
      }
    }
  }

  updateExtensionData(data) {
    this.data.extensionData = {
      topDomains: Array.isArray(data.topDomains) ? data.topDomains : [],
      totalTabMs: data.totalTabMs || 0,
      totalIdleMs: data.totalIdleMs || 0,
      daily: data.daily || { tabMs: 0, idleMs: 0, eventCount: 0, topDomains: [] },
      weekly: data.weekly || { tabMs: 0, idleMs: 0, eventCount: 0, topDomains: [] },
      monthly: data.monthly || { tabMs: 0, idleMs: 0, eventCount: 0, topDomains: [] },
      productivity: data.productivity || 0
    };
  }

  recordScreenshot(imagePath, idleMs, metadata = {}) {
    this.data.screenshots.push({
      timestamp: Date.now(),
      path: imagePath,
      idleMs,
      appName: "system_idle",
      displayId: metadata.displayId,
      displayLabel: metadata.displayLabel,
      isActiveDisplay: Boolean(metadata.isActiveDisplay),
      resolution: metadata.resolution
    });
    if (this.data.screenshots.length > 100) {
      this.data.screenshots = this.data.screenshots.slice(-100);
    }
  }
}

module.exports = {
  DataStore
};
