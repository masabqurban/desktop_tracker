const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { DEFAULTS } = require("./config");

const DAY_MS = 24 * 60 * 60 * 1000;

function todayDateKey() {
  return toLocalDateKey(Date.now());
}

function toLocalDateKey(timestamp) {
  const now = new Date(timestamp);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDateKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function extractDateKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = normalizeDateKey(trimmed);
  if (direct) {
    return direct;
  }

  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? normalizeDateKey(match[1]) : null;
}

function buildTopApps(appUsageMs, limit = 10) {
  return Object.entries(appUsageMs || {})
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, limit)
    .map(([name, durationMs]) => ({ name, durationMs }));
}

function aggregateDayEntries(entries) {
  const summary = {
    activeMs: 0,
    idleMs: 0,
    keyboardCount: 0,
    mouseCount: 0,
    appSwitches: 0,
    browserEvents: 0,
    desktopEvents: 0,
    appUsageMs: {}
  };

  for (const day of entries) {
    if (!day) {
      continue;
    }

    summary.activeMs += day.activeMs || 0;
    summary.idleMs += day.idleMs || 0;
    summary.keyboardCount += day.keyboardCount || 0;
    summary.mouseCount += day.mouseCount || 0;
    summary.appSwitches += day.appSwitches || 0;
    summary.browserEvents += day.browserEvents || 0;
    summary.desktopEvents += day.desktopEvents || 0;

    for (const [appName, durationMs] of Object.entries(day.appUsageMs || {})) {
      summary.appUsageMs[appName] = (summary.appUsageMs[appName] || 0) + (durationMs || 0);
    }
  }

  return summary;
}

function getEventTimestamp(item) {
  const raw = item?.event?.timestamp || item?.timestamp || 0;
  return Number(raw) || 0;
}

function getDayWindow(dateKey) {
  const start = new Date(`${dateKey}T00:00:00`).getTime();
  const end = start + DAY_MS;
  return { start, end };
}

function filterEventsByDate(items, dateKey) {
  const { start, end } = getDayWindow(dateKey);
  return (items || []).filter((item) => {
    const timestamp = getEventTimestamp(item);
    return timestamp >= start && timestamp < end;
  });
}

function deriveBrowserContext(browserEvents) {
  let incognito = 0;
  let normal = 0;

  for (const wrapper of browserEvents) {
    const event = wrapper?.event || wrapper;
    if (event?.isIncognito === true) {
      incognito += 1;
    } else if (event?.isIncognito === false) {
      normal += 1;
    }
  }

  return { incognito, normal };
}

function deriveExtensionRange(browserEvents) {
  let tabMs = 0;
  let idleMs = 0;
  let eventCount = 0;
  const domainTotals = {};

  for (const wrapper of browserEvents) {
    eventCount += 1;
    const event = wrapper?.event || wrapper;
    if (!event || typeof event !== "object") {
      continue;
    }

    if (event.type === "idle") {
      const idleDuration = Number(event.duration || 0);
      if (idleDuration > 0) {
        idleMs += idleDuration;
      }
      continue;
    }

    if (event.type !== "tab") {
      continue;
    }

    const duration = Number(event.duration || 0);
    if (duration <= 0) {
      continue;
    }

    tabMs += duration;

    let domain = "unknown";
    try {
      domain = new URL(event.url || "").hostname || "unknown";
    } catch {
      domain = "unknown";
    }
    domainTotals[domain] = (domainTotals[domain] || 0) + duration;
  }

  const topDomains = Object.entries(domainTotals)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 10)
    .map(([domain, durationMs]) => ({ domain, durationMs }));

  return {
    tabMs,
    idleMs,
    eventCount,
    topDomains
  };
}

function isDateBefore(left, right) {
  return typeof left === "string" && typeof right === "string" && left < right;
}

class SyncService {
  constructor({ dataStore, getDashboardPayload }) {
    this.dataStore = dataStore;
    this.getDashboardPayload = getDashboardPayload;
    this.timer = null;
  }

  start() {
    // Periodic ERP sync is intentionally disabled.
    // Sync is triggered only on office-out, with retry on next office-in.
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resolveWorkState(session) {
    if (!session?.isAuthenticated || !session?.token) {
      return "unauthenticated";
    }

    const employee = session.employee || null;
    if (!employee?.officeIn) {
      return "awaiting_office_in";
    }

    if (employee.isOnBreak) {
      return "on_break";
    }

    if (employee.officeOut) {
      return "office_out";
    }

    return "working";
  }

  isTrackingActive() {
    const session = this.dataStore.getAuthSession();
    return this.resolveWorkState(session) === "working";
  }

  resolveCurrentDateKey(session) {
    const employee = session?.employee || {};

    return (
      normalizeDateKey(employee.serverDate) ||
      extractDateKey(employee.serverNow) ||
      normalizeDateKey(employee.attendanceDate) ||
      todayDateKey()
    );
  }

  hasMeaningfulDayData(snapshot, dateKey) {
    const day = snapshot?.daily?.[dateKey];
    if (!day) {
      return false;
    }

    const hasTotals =
      (day.activeMs || 0) > 0 ||
      (day.idleMs || 0) > 0 ||
      (day.keyboardCount || 0) > 0 ||
      (day.mouseCount || 0) > 0 ||
      (day.appSwitches || 0) > 0 ||
      (day.browserEvents || 0) > 0 ||
      (day.desktopEvents || 0) > 0 ||
      Object.keys(day.appUsageMs || {}).length > 0;

    if (hasTotals) {
      return true;
    }

    const dayDesktopEvents = filterEventsByDate(snapshot?.events || [], dateKey);
    const dayBrowserEvents = filterEventsByDate(snapshot?.browserEvents || [], dateKey);
    const dayScreenshots = filterEventsByDate(snapshot?.screenshots || [], dateKey);

    return dayDesktopEvents.length > 0 || dayBrowserEvents.length > 0 || dayScreenshots.length > 0;
  }

  queueHistoricalSummaries(currentDateKey, reason = "date_rollover") {
    const snapshot = this.dataStore.getSnapshot();
    const dateKeys = Object.keys(snapshot.daily || {}).sort();
    const queuedDates = [];

    for (const dateKey of dateKeys) {
      if (!isDateBefore(dateKey, currentDateKey)) {
        continue;
      }

      if (!this.hasMeaningfulDayData(snapshot, dateKey)) {
        continue;
      }

      const result = this.queueDailySummarySnapshot(`${reason}:${dateKey}`, dateKey);
      if (result?.ok) {
        queuedDates.push(dateKey);
      }
    }

    return queuedDates;
  }

  async handleEmployeeStateChange(trigger = "profile_update") {
    const session = this.dataStore.getAuthSession();
    const currentState = this.resolveWorkState(session);
    const currentDateKey = this.resolveCurrentDateKey(session);
    const control = this.dataStore.getSyncControl();
    const previousState = control.lastWorkState || "unknown";
    const now = Date.now();

    const historicalQueuedDates = this.queueHistoricalSummaries(
      currentDateKey,
      `auto_close:${trigger}`
    );
    const hasPending = this.dataStore.hasPendingSyncQueue();

    if (currentState === "office_out" && previousState !== "office_out") {
      const officeOutDate = currentDateKey;
      const alreadyHandled =
        control.lastOfficeOutDate === officeOutDate && !hasPending;

      if (!alreadyHandled) {
        this.queueDailySummarySnapshot(`office_out:${trigger}`, officeOutDate);
        const syncResult = await this.flushQueue();
        this.dataStore.updateSyncControl({
          lastWorkState: currentState,
          lastOfficeOutDate: officeOutDate,
          lastKnownServerDate: currentDateKey,
          lastSyncTriggeredAt: now
        });
        this.dataStore.persist();

        return {
          ok: true,
          state: currentState,
          action: "office_out_sync",
          sync: syncResult
        };
      }
    }

    if (currentState === "working" && hasPending) {
      const syncResult = await this.flushQueue();
      this.dataStore.updateSyncControl({
        lastWorkState: currentState,
        lastKnownServerDate: currentDateKey,
        lastRetryAt: now,
        lastSyncTriggeredAt: now
      });
      this.dataStore.persist();

      return {
        ok: true,
        state: currentState,
        action: "retry_pending",
        sync: syncResult
      };
    }

    if (historicalQueuedDates.length > 0) {
      this.dataStore.updateSyncControl({
        lastWorkState: currentState,
        lastKnownServerDate: currentDateKey
      });
      this.dataStore.persist();

      return {
        ok: true,
        state: currentState,
        action: "queued_historical",
        queuedDates: historicalQueuedDates
      };
    }

    this.dataStore.updateSyncControl({
      lastWorkState: currentState,
      lastKnownServerDate: currentDateKey
    });
    this.dataStore.persist();

    return {
      ok: true,
      state: currentState,
      action: "state_updated"
    };
  }

  queueDesktopSnapshot(reason = "manual") {
    return this.queueDailySummarySnapshot(reason);
  }

  queueDailySummarySnapshot(reason = "manual", activityDate = null) {
    const authSession = this.dataStore.getAuthSession();
    if (!authSession?.token) {
      return { ok: false, reason: "not_authenticated" };
    }

    const dateKey = normalizeDateKey(activityDate) || this.resolveCurrentDateKey(authSession);
    const employeeId = authSession.employee?.id || "unknown";

    const payload = {
      source: "employee-desktop-tracker",
      reason,
      generatedAt: Date.now(),
      activityDate: dateKey,
      deviceId: `desktop-${employeeId}`,
      data: this.buildDailySummaryPayload(reason, dateKey)
    };

    this.dataStore.queueForSync({
      target: "daily_summary",
      endpoint: DEFAULTS.erpDesktopEndpoint,
      dedupeKey: `daily-summary-${employeeId}-${dateKey}`,
      payload
    });
    this.dataStore.persist();

    return { ok: true, activityDate: dateKey };
  }

  queueBrowserEvent() {
    // Browser events are batched into the office-out daily summary.
    return { ok: true, reason: "batched_in_daily_summary" };
  }

  buildDailySummaryPayload(reason, activityDate) {
    const snapshot = this.dataStore.getSnapshot();
    const authSession = this.dataStore.getAuthSession();
    const employee = authSession?.employee || null;
    const dailyMap = snapshot.daily || {};
    const day = dailyMap[activityDate] || {
      activeMs: 0,
      idleMs: 0,
      keyboardCount: 0,
      mouseCount: 0,
      appSwitches: 0,
      browserEvents: 0,
      desktopEvents: 0,
      appUsageMs: {}
    };

    const allDateKeys = Object.keys(dailyMap)
      .filter((key) => normalizeDateKey(key) && key <= activityDate)
      .sort();

    const weeklyEntries = allDateKeys.slice(-7).map((key) => dailyMap[key]);
    const monthlyEntries = allDateKeys.slice(-30).map((key) => dailyMap[key]);

    const dailyPeriod = {
      ...day,
      topApps: buildTopApps(day.appUsageMs, 10)
    };

    const weeklyPeriodRaw = aggregateDayEntries(weeklyEntries);
    const weeklyPeriod = {
      ...weeklyPeriodRaw,
      topApps: buildTopApps(weeklyPeriodRaw.appUsageMs, 10)
    };

    const monthlyPeriodRaw = aggregateDayEntries(monthlyEntries);
    const monthlyPeriod = {
      ...monthlyPeriodRaw,
      topApps: buildTopApps(monthlyPeriodRaw.appUsageMs, 10)
    };

    const dayBrowserEvents = filterEventsByDate(snapshot.browserEvents || [], activityDate);
    const extensionDaily = deriveExtensionRange(dayBrowserEvents);

    const dayDesktopEvents = filterEventsByDate(snapshot.events || [], activityDate);
    const dayScreenshots = filterEventsByDate(snapshot.screenshots || [], activityDate)
      .slice(-20)
      .reverse();

    const browserContext = deriveBrowserContext(dayBrowserEvents);
    const totalTrackedMs = (day.activeMs || 0) + (day.idleMs || 0);
    const extensionProductivity = extensionDaily.tabMs + extensionDaily.idleMs > 0
      ? Math.round((extensionDaily.tabMs / (extensionDaily.tabMs + extensionDaily.idleMs)) * 100)
      : 0;

    return {
      activityDate,
      reason,
      generatedAt: Date.now(),
      employee: {
        id: employee?.id || null,
        name: employee?.name || null,
        email: employee?.email || null,
        designation: employee?.designation || null,
        shiftLabel: employee?.shiftLabel || null,
        shiftStartTime: employee?.shiftStartTime || null,
        shiftEndTime: employee?.shiftEndTime || null,
        attendanceDate: employee?.attendanceDate || null,
        forgotToOut: employee?.forgotToOut === true
      },
      totals: {
        totalTrackedMs,
        totalIdleMs: day?.idleMs || 0,
        totalKeyboard: day?.keyboardCount || 0,
        totalMouse: day?.mouseCount || 0
      },
      periods: {
        daily: dailyPeriod,
        weekly: weeklyPeriod,
        monthly: monthlyPeriod
      },
      openedApps: Object.keys(day?.appUsageMs || {}).length,
      browserContext,
      installedBrowsers: snapshot?.installedBrowsers || {},
      browserStatus: snapshot?.browserStatus || {},
      extensionStatus: snapshot?.extensionStatus || {},
      extensionData: {
        totalTabMs: extensionDaily.tabMs,
        totalIdleMs: extensionDaily.idleMs,
        productivity: extensionProductivity,
        topDomains: extensionDaily.topDomains,
        daily: extensionDaily,
        weekly: extensionDaily,
        monthly: extensionDaily
      },
      mostUsedApps: buildTopApps(day?.appUsageMs || {}, 15),
      screenshots: dayScreenshots,
      desktopEvents: dayDesktopEvents,
      browserEvents: dayBrowserEvents,
      dailyBreakdown: [
        {
          date: activityDate,
          ...day
        }
      ]
    };
  }

  async flushQueue() {
    const snapshot = this.dataStore.getSnapshot();
    const pending = snapshot.syncQueue || [];
    if (pending.length === 0) {
      return { ok: true, sent: 0 };
    }

    const successIds = [];
    const attemptIds = [];
    const successfulSummaryDates = new Set();

    for (const item of pending) {
      attemptIds.push(item.id);
      try {
        const authSession = this.dataStore.getAuthSession();
        const token = authSession?.token || DEFAULTS.erpAuthToken;
        if (!token) {
          continue;
        }

        if (item.payload.target === "screenshot") {
          const payload = item.payload.payload || {};
          if (!payload.filePath || !fs.existsSync(payload.filePath)) {
            successIds.push(item.id);
            continue;
          }

          const form = new FormData();
          form.append("screenshot", fs.createReadStream(payload.filePath));
          form.append("generatedAt", String(payload.generatedAt || Date.now()));
          form.append("deviceId", String(payload.deviceId || ""));
          form.append("idleMs", String(payload.idleMs || 0));
          form.append("displayId", String(payload.displayId || ""));
          form.append("displayLabel", String(payload.displayLabel || ""));
          form.append("resolution", String(payload.resolution || ""));

          await axios.post(item.payload.endpoint, form, {
            timeout: 15000,
            headers: {
              Authorization: `Bearer ${token}`,
              ...form.getHeaders()
            }
          });
          successIds.push(item.id);
          continue;
        }

        if (item.payload.target === "browser" || item.payload.target === "desktop") {
          // Drop legacy per-event sync items to avoid high-volume ERP writes.
          successIds.push(item.id);
          continue;
        }

        await axios.post(item.payload.endpoint, item.payload.payload, {
          timeout: 10000,
          headers: { Authorization: `Bearer ${token}` }
        });
        successIds.push(item.id);

        if (item.payload.target === "daily_summary") {
          const dateKey = item.payload?.payload?.activityDate || todayDateKey();
          successfulSummaryDates.add(dateKey);
        }
      } catch {
        // Keep queued for retry.
      }
    }

    this.dataStore.markSyncAttempt(attemptIds);
    this.dataStore.markSyncSuccess(successIds);

    for (const activityDate of successfulSummaryDates) {
      this.dataStore.applyPostSyncResets(activityDate);
    }

    this.dataStore.persist();

    return {
      ok: true,
      sent: successIds.length,
      failed: attemptIds.length - successIds.length
    };
  }
}

module.exports = {
  SyncService
};
