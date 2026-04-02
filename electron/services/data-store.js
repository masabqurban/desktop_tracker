const fs = require("fs");
const path = require("path");
const { DEFAULTS } = require("./config");
const { deriveExtensionDataFromEvents } = require("./report-service");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

function createEmptyRollup() {
  return {
    activeMs: 0,
    idleMs: 0,
    keyboardCount: 0,
    mouseCount: 0,
    appSwitches: 0,
    browserEvents: 0,
    desktopEvents: 0,
    appUsageMs: {}
  };
}

const INITIAL_DATA = {
  events: [],
  browserEvents: [],
  appUsageMs: {},
  openedApps: {},
  daily: {},
  rollups: {
    weekly: createEmptyRollup(),
    monthly: createEmptyRollup()
  },
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
  auth: {
    isAuthenticated: false,
    token: "",
    userType: "Employee",
    employee: null,
    loginAt: null,
    lastProfileRefreshAt: null
  },
  idleStartTime: null,
  lastSnapshotAt: null,
  lastSyncAt: null,
  syncQueue: [],
  syncControl: {
    lastWorkState: "unknown",
    lastOfficeOutDate: null,
    lastRetryAt: null,
    lastSyncTriggeredAt: null,
    lastSuccessfulSummarySyncAt: null,
    lastWeeklyResetAt: null,
    lastMonthlyResetAt: null
  }
};

function formatDateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseDateKeyToMs(dateKey) {
  if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return NaN;
  }

  return new Date(`${dateKey}T00:00:00`).getTime();
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

  ensureRollups() {
    const rollups = this.data.rollups || {};
    this.data.rollups = {
      weekly: {
        ...createEmptyRollup(),
        ...(rollups.weekly || {})
      },
      monthly: {
        ...createEmptyRollup(),
        ...(rollups.monthly || {})
      }
    };
  }

  recalculateAppUsageFromDaily() {
    const usage = {};

    for (const day of Object.values(this.data.daily || {})) {
      const dayUsage = day?.appUsageMs || {};
      for (const [appName, durationMs] of Object.entries(dayUsage)) {
        usage[appName] = (usage[appName] || 0) + (durationMs || 0);
      }
    }

    this.data.appUsageMs = usage;
  }

  resetDailyData(activityDate) {
    const targetDate = typeof activityDate === "string" && activityDate
      ? activityDate
      : formatDateKey(Date.now());

    delete this.data.daily[targetDate];

    this.data.events = (this.data.events || []).filter((event) => {
      return formatDateKey(event?.timestamp || Date.now()) !== targetDate;
    });

    this.data.browserEvents = (this.data.browserEvents || []).filter((event) => {
      return formatDateKey(event?.timestamp || Date.now()) !== targetDate;
    });

    this.data.screenshots = (this.data.screenshots || []).filter((shot) => {
      return formatDateKey(shot?.timestamp || Date.now()) !== targetDate;
    });

    // Rebuild extension aggregates from remaining browser events so desktop view
    // stays consistent with extension popup after office-out resets.
    this.data.extensionData = deriveExtensionDataFromEvents(this.data);

    this.recalculateAppUsageFromDaily();
    this.data.openedApps = {};
  }

  pruneHistoryDays(maxDays) {
    const now = Date.now();
    const cutoff = now - maxDays * DAY_MS;

    this.data.events = (this.data.events || []).filter((event) => (event?.timestamp || 0) >= cutoff);
    this.data.browserEvents = (this.data.browserEvents || []).filter((event) => (event?.timestamp || 0) >= cutoff);
    this.data.screenshots = (this.data.screenshots || []).filter((shot) => (shot?.timestamp || 0) >= cutoff);

    const filteredDaily = {};
    for (const [dateKey, entry] of Object.entries(this.data.daily || {})) {
      const dateMs = parseDateKeyToMs(dateKey);
      if (!Number.isNaN(dateMs) && dateMs >= cutoff) {
        filteredDaily[dateKey] = entry;
      }
    }

    this.data.daily = filteredDaily;
    this.recalculateAppUsageFromDaily();
  }

  applyPostSyncResets(activityDate) {
    const now = Date.now();
    const control = this.getSyncControl();

    this.ensureRollups();

    this.resetDailyData(activityDate);

    const syncPatch = {
      lastSuccessfulSummarySyncAt: now
    };

    if (!control.lastWeeklyResetAt) {
      syncPatch.lastWeeklyResetAt = now;
    } else if (now - control.lastWeeklyResetAt >= WEEK_MS) {
      this.data.rollups.weekly = createEmptyRollup();
      this.data.extensionData = {
        ...(this.data.extensionData || {}),
        weekly: {
          tabMs: 0,
          idleMs: 0,
          eventCount: 0,
          topDomains: []
        }
      };
      syncPatch.lastWeeklyResetAt = now;
    }

    if (!control.lastMonthlyResetAt) {
      syncPatch.lastMonthlyResetAt = now;
    } else if (now - control.lastMonthlyResetAt >= MONTH_MS) {
      this.data.rollups.monthly = createEmptyRollup();
      this.pruneHistoryDays(30);
      this.data.extensionData = {
        ...(this.data.extensionData || {}),
        monthly: {
          tabMs: 0,
          idleMs: 0,
          eventCount: 0,
          topDomains: []
        }
      };
      syncPatch.lastMonthlyResetAt = now;
    }

    this.updateSyncControl(syncPatch);
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

    this.ensureRollups();
    for (const periodName of ["weekly", "monthly"]) {
      const rollup = this.data.rollups[periodName];
      if (isIdle) {
        rollup.idleMs += durationMs;
      } else {
        rollup.activeMs += durationMs;
      }
      rollup.appUsageMs[appName] = (rollup.appUsageMs[appName] || 0) + durationMs;
    }
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

    this.ensureRollups();
    for (const periodName of ["weekly", "monthly"]) {
      const rollup = this.data.rollups[periodName];
      if (type === "keyboard") {
        rollup.keyboardCount += count;
      }
      if (type === "mouse") {
        rollup.mouseCount += count;
      }
    }
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

    this.ensureRollups();
    this.data.rollups.weekly.appSwitches += 1;
    this.data.rollups.monthly.appSwitches += 1;
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

    this.ensureRollups();
    this.data.rollups.weekly.desktopEvents += 1;
    this.data.rollups.monthly.desktopEvents += 1;
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

    this.ensureRollups();
    this.data.rollups.weekly.browserEvents += 1;
    this.data.rollups.monthly.browserEvents += 1;
  }

  queueForSync(payload) {
    const dedupeKey = payload?.dedupeKey || null;
    if (dedupeKey) {
      const existingIndex = this.data.syncQueue.findIndex(
        (item) => item?.payload?.dedupeKey === dedupeKey
      );

      if (existingIndex >= 0) {
        const existing = this.data.syncQueue[existingIndex];
        this.data.syncQueue[existingIndex] = {
          ...existing,
          payload,
          createdAt: Date.now()
        };
        return existing.id;
      }
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.data.syncQueue.push({
      id,
      payload,
      createdAt: Date.now(),
      attempts: 0
    });

    return id;
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

  setAuthSession({ token, userType = "Employee", employee = null }) {
    this.data.auth = {
      isAuthenticated: Boolean(token),
      token: token || "",
      userType,
      employee,
      loginAt: Date.now(),
      lastProfileRefreshAt: Date.now()
    };
  }

  updateAuthEmployee(employee) {
    const current = this.data.auth || {};
    this.data.auth = {
      isAuthenticated: Boolean(current.token),
      token: current.token || "",
      userType: current.userType || "Employee",
      employee: employee || current.employee || null,
      loginAt: current.loginAt || Date.now(),
      lastProfileRefreshAt: Date.now()
    };
  }

  clearAuthSession() {
    this.data.auth = {
      isAuthenticated: false,
      token: "",
      userType: "Employee",
      employee: null,
      loginAt: null,
      lastProfileRefreshAt: null
    };
  }

  getAuthSession() {
    return { ...(this.data.auth || {}) };
  }

  getSyncControl() {
    return {
      lastWorkState: this.data.syncControl?.lastWorkState || "unknown",
      lastOfficeOutDate: this.data.syncControl?.lastOfficeOutDate || null,
      lastRetryAt: this.data.syncControl?.lastRetryAt || null,
      lastSyncTriggeredAt: this.data.syncControl?.lastSyncTriggeredAt || null,
      lastSuccessfulSummarySyncAt: this.data.syncControl?.lastSuccessfulSummarySyncAt || null,
      lastWeeklyResetAt: this.data.syncControl?.lastWeeklyResetAt || null,
      lastMonthlyResetAt: this.data.syncControl?.lastMonthlyResetAt || null
    };
  }

  updateSyncControl(patch) {
    const current = this.getSyncControl();
    this.data.syncControl = {
      ...current,
      ...(patch || {})
    };
  }

  hasPendingSyncQueue() {
    return Array.isArray(this.data.syncQueue) && this.data.syncQueue.length > 0;
  }
}

module.exports = {
  DataStore
};
