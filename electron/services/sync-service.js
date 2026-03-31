const axios = require("axios");
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
    const payload = {
      source: "employee-desktop-tracker",
      reason,
      generatedAt: Date.now(),
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
    const payload = {
      source: "browser-activity-tracker-extension",
      generatedAt: Date.now(),
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
        await axios.post(item.payload.endpoint, item.payload.payload, {
          timeout: 10000,
          headers: DEFAULTS.erpAuthToken
            ? { Authorization: `Bearer ${DEFAULTS.erpAuthToken}` }
            : {}
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
