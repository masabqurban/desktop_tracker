const path = require("path");
const fs = require("fs");
const os = require("os");
const { powerMonitor, desktopCapturer, screen } = require("electron");
const { DEFAULTS } = require("./config");

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_SCREENSHOT_INTERVAL_MS = 7 * 60 * 1000;
const MAX_TRACKABLE_GAP_MS = Math.max((DEFAULTS.pollIntervalMs || 10000) * 3, 2 * 60 * 1000);
const SHIFT_OVERRUN_GRACE_SECONDS = 2 * 60 * 60;

function parseTimeToSeconds(value) {
  if (typeof value !== "string") {
    return null;
  }

  const parts = value.trim().split(":");
  if (parts.length < 2) {
    return null;
  }

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2] || 0);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    Number.isNaN(seconds) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return null;
  }

  return (hours * 60 * 60) + (minutes * 60) + seconds;
}

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
    this.idleTimeout = IDLE_TIMEOUT_MS;
    this.idleStartTime = null;
    this.skipNextDelta = false;
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
      const idleCaptureMs = IDLE_SCREENSHOT_INTERVAL_MS;
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
        idleMinutes: 7,
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
    if (!session?.isAuthenticated || !session?.token) {
      return false;
    }

    const employee = session.employee;
    if (!employee) {
      return false;
    }

    if (!employee.officeIn) {
      return false;
    }

    if (employee.isOnBreak) {
      return false;
    }

    if (employee.officeOut) {
      return false;
    }

    if (this.hasShiftCutoffPassed(employee)) {
      return false;
    }

    return true;
  }

  hasShiftCutoffPassed(employee) {
    if (!employee?.shiftEndTime || !employee?.serverTime) {
      return false;
    }

    const shiftEndSeconds = parseTimeToSeconds(employee.shiftEndTime);
    const serverSeconds = parseTimeToSeconds(employee.serverTime);
    if (shiftEndSeconds === null || serverSeconds === null) {
      return false;
    }

    return serverSeconds >= shiftEndSeconds + SHIFT_OVERRUN_GRACE_SECONDS;
  }

  async handleSystemSuspend() {
    await this.finalizeCurrentWindow("system_suspend");
    this.lastTickAt = Date.now();
    this.skipNextDelta = true;
    this.keyboardDelta = 0;
    this.mouseDelta = 0;
    this.idleStartTime = null;
    this.dataStore.persist();
  }

  handleSystemResume() {
    this.lastTickAt = Date.now();
    this.lastActivityAt = Date.now();
    this.skipNextDelta = true;
    this.keyboardDelta = 0;
    this.mouseDelta = 0;
    this.idle = false;
    this.idleStartTime = null;
  }

  async poll() {
    const now = Date.now();
    let deltaMs = Math.max(0, now - (this.lastTickAt || now));
    this.lastTickAt = now;

    const gapExceeded = deltaMs > MAX_TRACKABLE_GAP_MS || this.skipNextDelta;
    if (gapExceeded) {
      deltaMs = 0;
      this.skipNextDelta = false;
      this.lastActivityAt = now;
      this.idleStartTime = null;
    }

    // Check if currently within office hours
    const wasTrackingEnabled = this.isTrackingEnabled;
    this.isTrackingEnabled = this.isWithinOfficeHours();

    // If office hours ended, finalize current window and stop tracking
    if (wasTrackingEnabled && !this.isTrackingEnabled) {
      await this.finalizeCurrentWindow("office_hours_ended");
      this.currentWindow = null;
      this.keyboardDelta = 0;
      this.mouseDelta = 0;
      this.idle = false;
      this.idleStartTime = null;
      return;
    }

    // If office hours started, do not record activity before this moment
    if (!wasTrackingEnabled && this.isTrackingEnabled) {
      this.lastActivityAt = now; // Reset activity timestamp
      return;
    }

    // If outside office hours, don't track anything
    if (!this.isTrackingEnabled) {
      this.keyboardDelta = 0;
      this.mouseDelta = 0;
      this.idle = false;
      this.idleStartTime = null;
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

    // Capture screenshot every 7 minutes while continuously idle.
    if (this.idle && this.idleStartTime && (now - this.idleStartTime >= IDLE_SCREENSHOT_INTERVAL_MS)) {
      await this.captureIdleScreenshot(now);
      this.idleStartTime = now;
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
