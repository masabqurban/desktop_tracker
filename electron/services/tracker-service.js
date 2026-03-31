const path = require("path");
const fs = require("fs");
const os = require("os");
const { powerMonitor, desktopCapturer } = require("electron");
const { DEFAULTS } = require("./config");

class TrackerService {
  constructor({ dataStore, onUpdate }) {
    this.dataStore = dataStore;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.currentWindow = null;
    this.lastTickAt = null;
    this.keyboardDelta = 0;
    this.mouseDelta = 0;
    this.idle = false;
    this.activeWinFn = null;
    this.uiohook = null;
    this.hooksReady = false;
    this.lastActivityAt = Date.now();
    this.idleTimeout = 60000; // 60 seconds of no input = idle
    this.idleStartTime = null;
    this.screenshotDir = path.join(os.homedir(), ".employee-tracker", "screenshots");
  }

  async start() {
    await this.prepareLibraries();
    this.lastTickAt = Date.now();

    // Create screenshot directory
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }

    this.timer = setInterval(async () => {
      await this.poll();
    }, DEFAULTS.pollIntervalMs);

    await this.poll();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.finalizeCurrentWindow("stop");

    if (this.hooksReady && this.uiohook) {
      this.uiohook.stop();
      this.hooksReady = false;
    }

    this.dataStore.persist();
  }

  async captureIdleScreenshot(timestamp) {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources.length === 0) {
        return;
      }

      const source = sources[0];
      const thumbnail = source.thumbnail;
      if (!thumbnail) {
        return;
      }

      const filename = `idle-${timestamp}-${Math.random().toString(16).slice(2)}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      fs.writeFileSync(filepath, thumbnail.toPNG());

      this.dataStore.recordScreenshot(filepath, 300000);
      this.dataStore.addDesktopEvent({
        type: "idle_screenshot",
        screenshotPath: filepath,
        timestamp,
        idleMinutes: 5,
        appName: this.currentWindow?.appName || "idle"
      });
    } catch (err) {
      // Silently fail - screenshots are optional
    }
  }

  async prepareLibraries() {
    try {
      const activeWinModule = await import("active-win");
      this.activeWinFn = activeWinModule.default;
    } catch {
      this.activeWinFn = null;
    }

    try {
      this.uiohook = require("uiohook-napi").uIOhook;
      this.uiohook.on("keydown", () => {
        this.keyboardDelta += 1;
      });
      this.uiohook.on("mousedown", () => {
        this.mouseDelta += 1;
      });
      this.uiohook.start();
      this.hooksReady = true;
    } catch {
      this.uiohook = null;
      this.hooksReady = false;
    }
  }

  async poll() {
    const now = Date.now();
    const deltaMs = Math.max(0, now - (this.lastTickAt || now));
    this.lastTickAt = now;

    const idleSeconds = powerMonitor.getSystemIdleTime();
    const timeSinceActivity = now - this.lastActivityAt;
    const currentlyIdle = timeSinceActivity >= this.idleTimeout || idleSeconds >= DEFAULTS.idleThresholdSeconds;

    const focused = await this.getActiveWindow();
    if (focused && focused.appName) {
      this.dataStore.addOpenedApp(focused.appName, now);
    }

    const changedApp = this.currentWindow && focused
      ? this.currentWindow.appName !== focused.appName || this.currentWindow.title !== focused.title
      : this.currentWindow !== focused;

    if (changedApp) {
      await this.finalizeCurrentWindow("app_switched");
      this.currentWindow = focused
        ? {
            ...focused,
            startedAt: now
          }
        : null;

      if (focused) {
        this.dataStore.incrementAppSwitch(now);
        this.dataStore.addDesktopEvent({
          type: "app_focus",
          appName: focused.appName,
          title: focused.title,
          timestamp: now
        });
      }
    }

    if (this.currentWindow && deltaMs > 0) {
      this.dataStore.addAppUsage(this.currentWindow.appName, deltaMs, now, currentlyIdle);
    }

    if (this.keyboardDelta > 0) {
      this.lastActivityAt = now;
      this.dataStore.addInputCount("keyboard", this.keyboardDelta, now);
      this.dataStore.addDesktopEvent({
        type: "keyboard_activity",
        count: this.keyboardDelta,
        timestamp: now,
        appName: this.currentWindow?.appName || "unknown"
      });
      this.keyboardDelta = 0;
    }

    if (this.mouseDelta > 0) {
      this.lastActivityAt = now;
      this.dataStore.addInputCount("mouse", this.mouseDelta, now);
      this.dataStore.addDesktopEvent({
        type: "mouse_activity",
        count: this.mouseDelta,
        timestamp: now,
        appName: this.currentWindow?.appName || "unknown"
      });
      this.mouseDelta = 0;
    }

    if (this.idle !== currentlyIdle) {
      this.idle = currentlyIdle;
      if (this.idle) {
        this.idleStartTime = now;
      } else {
        this.idleStartTime = null;
      }
      this.dataStore.addDesktopEvent({
        type: "idle_state",
        state: this.idle ? "idle" : "active",
        idleSeconds,
        timestamp: now,
        appName: this.currentWindow?.appName || "unknown"
      });
    }

    // Capture screenshot when idle for 5 minutes
    if (this.idle && this.idleStartTime && (now - this.idleStartTime >= 300000)) {
      await this.captureIdleScreenshot(now);
      this.idleStartTime = now; // Reset to capture again after next 5 minutes
    }

    this.dataStore.touchSnapshot(now);
    this.dataStore.persist();

    if (this.onUpdate) {
      this.onUpdate({
        timestamp: now,
        activeWindow: this.currentWindow,
        idle: this.idle
      });
    }
  }

  async getActiveWindow() {
    if (!this.activeWinFn) {
      return null;
    }

    try {
      const details = await this.activeWinFn();
      if (!details) {
        return null;
      }

      return {
        appName: details.owner?.name || details.owner?.path || "unknown",
        title: details.title || ""
      };
    } catch {
      return null;
    }
  }

  async finalizeCurrentWindow(reason) {
    if (!this.currentWindow) {
      return;
    }

    this.dataStore.addDesktopEvent({
      type: "app_blur",
      appName: this.currentWindow.appName,
      title: this.currentWindow.title,
      timestamp: Date.now(),
      reason
    });
  }
}

module.exports = {
  TrackerService
};
