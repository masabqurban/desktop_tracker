const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { DEFAULTS } = require("./config");

class SyncService {
  constructor({ dataStore, getDashboardPayload }) {
    this.dataStore = dataStore;
    this.getDashboardPayload = getDashboardPayload;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(async () => {
      await this.flushQueue();
    }, DEFAULTS.syncIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  queueDesktopSnapshot(reason = "periodic") {
    const authSession = this.dataStore.getAuthSession();
    if (!authSession?.token) {
      return { ok: false, reason: "not_authenticated" };
    }

    const payload = {
      source: "employee-desktop-tracker",
      reason,
      generatedAt: Date.now(),
      deviceId: `desktop-${authSession.employee?.id || "unknown"}`,
      data: this.getDashboardPayload()
    };

    this.dataStore.queueForSync({
      target: "desktop",
      endpoint: DEFAULTS.erpDesktopEndpoint,
      payload
    });
    this.dataStore.persist();
  }

  queueBrowserEvent(browserBody) {
    const authSession = this.dataStore.getAuthSession();
    if (!authSession?.token) {
      return { ok: false, reason: "not_authenticated" };
    }

    const payload = {
      source: "browser-activity-tracker-extension",
      generatedAt: Date.now(),
      deviceId: `desktop-${authSession.employee?.id || "unknown"}`,
      data: browserBody
    };

    this.dataStore.queueForSync({
      target: "browser",
      endpoint: DEFAULTS.erpBrowserEndpoint,
      payload
    });
    this.dataStore.persist();
  }

  async flushQueue() {
    const snapshot = this.dataStore.getSnapshot();
    const pending = snapshot.syncQueue || [];
    if (pending.length === 0) {
      return { ok: true, sent: 0 };
    }

    const successIds = [];
    const attemptIds = [];

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

        await axios.post(item.payload.endpoint, item.payload.payload, {
          timeout: 10000,
          headers: { Authorization: `Bearer ${token}` }
        });
        successIds.push(item.id);
      } catch {
        // Keep queued for retry.
      }
    }

    this.dataStore.markSyncAttempt(attemptIds);
    this.dataStore.markSyncSuccess(successIds);
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
