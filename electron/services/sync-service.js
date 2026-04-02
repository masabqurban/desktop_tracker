const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { DEFAULTS } = require("./config");

function todayDateKey() {
  const now = new Date();
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

  async handleEmployeeStateChange(trigger = "profile_update") {
    const session = this.dataStore.getAuthSession();
    const currentState = this.resolveWorkState(session);
    const control = this.dataStore.getSyncControl();
    const previousState = control.lastWorkState || "unknown";
    const hasPending = this.dataStore.hasPendingSyncQueue();
    const now = Date.now();

    if (currentState === "office_out" && previousState !== "office_out") {
      const officeOutDate = todayDateKey();
      const alreadyHandled =
        control.lastOfficeOutDate === officeOutDate && !hasPending;

      if (!alreadyHandled) {
        this.queueDailySummarySnapshot(`office_out:${trigger}`, officeOutDate);
        const syncResult = await this.flushQueue();
        this.dataStore.updateSyncControl({
          lastWorkState: currentState,
          lastOfficeOutDate: officeOutDate,
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

    if (currentState === "working" && previousState !== "working" && hasPending) {
      const syncResult = await this.flushQueue();
      this.dataStore.updateSyncControl({
        lastWorkState: currentState,
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

    this.dataStore.updateSyncControl({
      lastWorkState: currentState
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

    const dateKey = normalizeDateKey(activityDate) || todayDateKey();
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
    const dashboard = this.getDashboardPayload?.() || {};
    const periods = dashboard.periods || {};
    const extensionData = dashboard.extensionData || {};

    const pickPeriod = (period) => ({
      activeMs: period?.activeMs || 0,
      idleMs: period?.idleMs || 0,
      keyboardCount: period?.keyboardCount || 0,
      mouseCount: period?.mouseCount || 0,
      appSwitches: period?.appSwitches || 0,
      browserEvents: period?.browserEvents || 0,
      desktopEvents: period?.desktopEvents || 0,
      topApps: Array.isArray(period?.topApps) ? period.topApps.slice(0, 10) : []
    });

    const pickExtensionRange = (range) => ({
      tabMs: range?.tabMs || 0,
      idleMs: range?.idleMs || 0,
      eventCount: range?.eventCount || 0,
      topDomains: Array.isArray(range?.topDomains) ? range.topDomains.slice(0, 10) : []
    });

    return {
      activityDate,
      reason,
      generatedAt: Date.now(),
      employee: {
        id: dashboard?.auth?.employee?.id || null,
        name: dashboard?.auth?.employee?.name || null,
        email: dashboard?.auth?.employee?.email || null,
        designation: dashboard?.auth?.employee?.designation || null
      },
      totals: {
        totalTrackedMs: dashboard?.totals?.totalTrackedMs || 0,
        totalIdleMs: dashboard?.totals?.totalIdleMs || 0,
        totalKeyboard: dashboard?.totals?.totalKeyboard || 0,
        totalMouse: dashboard?.totals?.totalMouse || 0
      },
      periods: {
        daily: pickPeriod(periods.daily),
        weekly: pickPeriod(periods.weekly),
        monthly: pickPeriod(periods.monthly)
      },
      openedApps: dashboard?.openedApps || 0,
      browserContext: dashboard?.browserContext || { incognito: 0, normal: 0 },
      installedBrowsers: dashboard?.installedBrowsers || {},
      browserStatus: dashboard?.browserStatus || {},
      extensionStatus: dashboard?.extensionStatus || {},
      extensionData: {
        totalTabMs: extensionData.totalTabMs || 0,
        totalIdleMs: extensionData.totalIdleMs || 0,
        productivity: extensionData.productivity || 0,
        topDomains: Array.isArray(extensionData.topDomains)
          ? extensionData.topDomains.slice(0, 10)
          : [],
        daily: pickExtensionRange(extensionData.daily),
        weekly: pickExtensionRange(extensionData.weekly),
        monthly: pickExtensionRange(extensionData.monthly)
      },
      mostUsedApps: Array.isArray(dashboard?.mostUsedApps)
        ? dashboard.mostUsedApps.slice(0, 15)
        : [],
      dailyBreakdown: Array.isArray(dashboard?.dailyBreakdown)
        ? dashboard.dailyBreakdown.slice(-30)
        : []
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
