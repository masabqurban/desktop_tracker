const path = require("path");
const fs = require("fs");
const os = require("os");
const { powerMonitor, desktopCapturer, screen } = require("electron");
const { DEFAULTS } = require("./config");

class TrackerService {
  constructor({ dataStore, onUpdate }) {
    this.dataStore = dataStore;
    this.onUpdate = onUpdate;
    this.isTrackingEnabled = true; // Will be set based on office hours
    this.timer = null;
    this.currentWindow = null;
    this.lastTickAt = null;
    this.keyboardDelta = 0;
    this.mouseDelta = 0;
    this.idle = false;
    this.activeWinFn = null;
    this.uiohook = null;
    this.hooksReady = false;
    this.activeWinAvailable = false;
    this.activeWinWarningLogged = false;
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
      const idleCaptureMs = 60000;
      const displays = screen.getAllDisplays();
      if (displays.length === 0) {
        return;
      }

      const maxWidth = Math.max(
        1920,
        ...displays.map((display) => Math.round((display.size?.width || 0) * (display.scaleFactor || 1)))
      );
      const maxHeight = Math.max(
        1080,
        ...displays.map((display) => Math.round((display.size?.height || 0) * (display.scaleFactor || 1)))
      );

      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          width: maxWidth,
          height: maxHeight
        }
      });
      if (sources.length === 0) {
        return;
      }

      const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const activeId = String(activeDisplay?.id || "");
      const primaryDisplay = screen.getPrimaryDisplay();
      const pickByDisplay = (displayId) =>
        sources.find((item) => String(item.display_id) === String(displayId) && !item.thumbnail.isEmpty());

      const selectedSource =
        pickByDisplay(activeId) ||
        pickByDisplay(primaryDisplay?.id) ||
        sources.find((item) => !item.thumbnail.isEmpty()) ||
        null;

      if (!selectedSource) {
        this.dataStore.addDesktopEvent({
          type: "idle_screenshot_skipped",
          timestamp,
          reason: "no_capturable_sources",
          displayCount: displays.length,
          sourceCount: sources.length,
          appName: this.currentWindow?.appName || "idle"
        });
        return;
      }

      const sourceDisplayId = selectedSource.display_id || activeId || String(primaryDisplay?.id || "unknown");
      const matchedDisplay = displays.find((display) => String(display.id) === String(sourceDisplayId));
      const thumbnail = selectedSource.thumbnail;
      const imageSize = thumbnail.getSize();
      const filename = `idle-${timestamp}-display-${sourceDisplayId}-${Math.random().toString(16).slice(2)}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      fs.writeFileSync(filepath, thumbnail.toPNG());

      this.dataStore.recordScreenshot(filepath, idleCaptureMs, {
        displayId: sourceDisplayId,
        isActiveDisplay: String(sourceDisplayId) === activeId,
        displayLabel: matchedDisplay?.label || selectedSource.name || `Display ${sourceDisplayId}`,
        resolution: `${imageSize.width}x${imageSize.height}`
      });

      const authSession = this.dataStore.getAuthSession();
      const employeeId = authSession?.employee?.id || "unknown";
      this.dataStore.queueForSync({
        target: "screenshot",
        endpoint: DEFAULTS.erpScreenshotEndpoint,
        payload: {
          filePath: filepath,
          generatedAt: timestamp,
          deviceId: `desktop-${employeeId}`,
          idleMs: idleCaptureMs,
          displayId: sourceDisplayId,
          displayLabel: matchedDisplay?.label || selectedSource.name || `Display ${sourceDisplayId}`,
          resolution: `${imageSize.width}x${imageSize.height}`
        }
      });
      this.dataStore.persist();

      this.dataStore.addDesktopEvent({
        type: "idle_screenshot",
        screenshotPath: filepath,
        timestamp,
        idleMinutes: 1,
        displayId: sourceDisplayId,
        isActiveDisplay: String(sourceDisplayId) === activeId,
        resolution: `${imageSize.width}x${imageSize.height}`,
        appName: this.currentWindow?.appName || "idle"
      });
    } catch (err) {
      this.dataStore.addDesktopEvent({
        type: "idle_screenshot_error",
        timestamp,
        message: err?.message || "capture_failed",
        appName: this.currentWindow?.appName || "idle"
      });
    }
  }

  async prepareLibraries() {
    try {
      const activeWinModule = await import("active-win");
      this.activeWinFn =
        activeWinModule.activeWindow ||
        activeWinModule.default ||
        null;
      this.activeWinAvailable = typeof this.activeWinFn === "function";
    } catch {
      this.activeWinFn = null;
      this.activeWinAvailable = false;
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

  isWithinOfficeHours() {
    const session = this.dataStore.getAuthSession();
    if (!session?.isAuthenticated || !session?.employee) {
      // If not authenticated, allow tracking
      return true;
    }

    const employee = session.employee;
    if (employee.isOnBreak) {
      return false;
    }
    const officeInStr = employee.officeIn;
    const officeOutStr = employee.officeOut;

    if (!officeInStr || !officeOutStr) {
      // If office hours not set, allow tracking
      return true;
    }

    try {
      const now = new Date();
      const [inHour, inMin] = officeInStr.split(":").map(Number);
      const [outHour, outMin] = officeOutStr.split(":").map(Number);

      const officeIn = new Date();
      officeIn.setHours(inHour, inMin, 0, 0);

      const officeOut = new Date();
      officeOut.setHours(outHour, outMin, 0, 0);

      // Handle case where office out is next day (e.g., 9:00 to 17:00 assumed same day, but 10:00 to 2:00 crosses midnight)
      if (officeOut < officeIn) {
        officeOut.setDate(officeOut.getDate() + 1);
      }

      return now >= officeIn && now < officeOut;
    } catch {
      // If parsing fails, allow tracking
      return true;
    }
  }

  async poll() {
    const now = Date.now();
    const deltaMs = Math.max(0, now - (this.lastTickAt || now));
    this.lastTickAt = now;

    // Check if currently within office hours
    const wasTrackingEnabled = this.isTrackingEnabled;
    this.isTrackingEnabled = this.isWithinOfficeHours();

    // If office hours ended, finalize current window and stop tracking
    if (wasTrackingEnabled && !this.isTrackingEnabled) {
      await this.finalizeCurrentWindow("office_hours_ended");
      this.currentWindow = null;
      return;
    }

    // If office hours started, do not record activity before this moment
    if (!wasTrackingEnabled && this.isTrackingEnabled) {
      this.lastActivityAt = now; // Reset activity timestamp
      return;
    }

    // If outside office hours, don't track anything
    if (!this.isTrackingEnabled) {
      return;
    }

    const idleSeconds = powerMonitor.getSystemIdleTime();
    const timeSinceActivity = now - this.lastActivityAt;
    const currentlyIdle = timeSinceActivity >= this.idleTimeout || idleSeconds >= DEFAULTS.idleThresholdSeconds;

    const focused = await this.getActiveWindow();
    if (!focused && !this.activeWinAvailable && !this.activeWinWarningLogged) {
      this.activeWinWarningLogged = true;
      this.dataStore.addDesktopEvent({
        type: "active_window_unavailable",
        timestamp: now,
        appName: "system"
      });
    }
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
    } else if (!focused && deltaMs > 0) {
      // Fallback: keep total tracked/idle time moving even when active window detection is unavailable.
      const fallbackApp = "System Activity";
      this.dataStore.addOpenedApp(fallbackApp, now);
      this.dataStore.addAppUsage(fallbackApp, deltaMs, now, currentlyIdle);
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
        // Capture immediately when entering idle, then continue at the interval below.
        await this.captureIdleScreenshot(now);
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

    // Capture screenshot every 1 minute while still idle (testing)
    if (this.idle && this.idleStartTime && (now - this.idleStartTime >= 60000)) {
      await this.captureIdleScreenshot(now);
      this.idleStartTime = now; // Reset to capture again after next 1 minute
    }

    this.dataStore.touchSnapshot(now);
    this.dataStore.persist();

    if (this.onUpdate) {
      this.onUpdate({
        timestamp: now,
        activeWindow: this.currentWindow,
        idle: this.idle,
        isTrackingEnabled: this.isTrackingEnabled
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
