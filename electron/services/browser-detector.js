const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const BROWSER_PATHS = {
  Chrome: [
    path.join(os.homedir(), "AppData/Local/Google/Chrome/User Data"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ],
  Edge: [
    path.join(os.homedir(), "AppData/Local/Microsoft/Edge/User Data"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ],
  Firefox: [
    path.join(os.homedir(), "AppData/Roaming/Mozilla/Firefox"),
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"
  ],
  Opera: [
    path.join(os.homedir(), "AppData/Roaming/Opera Software/Opera Stable"),
    "C:\\Program Files\\Opera\\opera.exe",
    "C:\\Program Files (x86)\\Opera\\opera.exe"
  ],
  Brave: [
    path.join(os.homedir(), "AppData/Local/BraveSoftware/Brave-Browser/User Data"),
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  ],
  Vivaldi: [
    path.join(os.homedir(), "AppData/Local/Vivaldi/User Data"),
    "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe"
  ]
};

const PROCESS_TO_BROWSER = {
  "chrome.exe": "Chrome",
  "msedge.exe": "Edge",
  "firefox.exe": "Firefox",
  "opera.exe": "Opera",
  "brave.exe": "Brave",
  "vivaldi.exe": "Vivaldi"
};

const EXTENSION_MANIFEST_FILE = "manifest.json";

/**
 * Check if browser executable exists
 */
function isBrowserExecutableInstalled(browserName) {
  const paths = BROWSER_PATHS[browserName] || [];
  for (const browserPath of paths) {
    if (fs.existsSync(browserPath) && browserPath.endsWith(".exe")) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a browser's user data directory exists
 */
function hasBrowserUserData(browserName) {
  const paths = BROWSER_PATHS[browserName] || [];
  for (const browserPath of paths) {
    if (fs.existsSync(browserPath) && !browserPath.endsWith(".exe")) {
      return true;
    }
  }
  return false;
}

/**
 * Check if browser has the extension installed (Chromium-based only)
 */
function hasExtensionInstalled(browserName, extensionId) {
  if (!["Chrome", "Edge", "Brave", "Opera", "Vivaldi"].includes(browserName)) {
    // Firefox and others use different extension format
    return false;
  }

  const paths = BROWSER_PATHS[browserName] || [];
  for (const basePath of paths) {
    if (basePath.includes("User Data")) {
      // Check for extension in Extensions folder
      const extensionPath = path.join(basePath, "Default/Extensions", extensionId);
      if (fs.existsSync(extensionPath)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect all installed browsers on the system
 */
function detectInstalledBrowsers() {
  const installed = {};

  let runningProcessText = "";
  try {
    runningProcessText = execSync("tasklist /FO CSV /NH", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    }).toLowerCase();
  } catch {
    runningProcessText = "";
  }

  for (const [browserName, _] of Object.entries(BROWSER_PATHS)) {
    const hasExecutable = isBrowserExecutableInstalled(browserName);
    const hasUserData = hasBrowserUserData(browserName);
    const processName = Object.keys(PROCESS_TO_BROWSER).find(
      (exeName) => PROCESS_TO_BROWSER[exeName] === browserName
    );
    const isRunning = Boolean(processName && runningProcessText.includes(`\"${processName}\"`));

    installed[browserName] = {
      name: browserName,
      installed: hasExecutable || hasUserData || isRunning,
      hasUserData,
      hasExecutable,
      isRunning,
      extensionDetected: false,
      lastDetected: Date.now()
    };
  }

  return installed;
}

/**
 * Detect which browsers have the extension installed
 */
function detectBrowsersWithExtension(extensionId = "hplbgjbglpipffimjbbipfclhbkfhfme") {
  const installed = detectInstalledBrowsers();
  const withExtension = {};

  for (const [browserName, info] of Object.entries(installed)) {
    if (info.installed) {
      const hasExt = hasExtensionInstalled(browserName, extensionId);
      withExtension[browserName] = {
        ...info,
        extensionDetected: hasExt
      };
    }
  }

  return withExtension;
}

/**
 * Get most used browser (heuristic: largest Cache size)
 */
function getMostUsedBrowser() {
  const installed = detectInstalledBrowsers();
  let mostUsed = null;
  let maxCacheSize = 0;

  for (const [browserName, info] of Object.entries(installed)) {
    if (!info.hasUserData) continue;

    try {
      const paths = BROWSER_PATHS[browserName] || [];
      for (const basePath of paths) {
        if (!basePath.includes("User Data")) continue;

        const cacheDir = path.join(basePath, "Default/Cache");
        if (fs.existsSync(cacheDir)) {
          const files = fs.readdirSync(cacheDir);
          if (files.length > maxCacheSize) {
            maxCacheSize = files.length;
            mostUsed = browserName;
          }
        }
      }
    } catch (err) {
      // Ignore permission errors
    }
  }

  return mostUsed;
}

module.exports = {
  detectInstalledBrowsers,
  detectBrowsersWithExtension,
  getMostUsedBrowser,
  isBrowserExecutableInstalled,
  hasBrowserUserData,
  hasExtensionInstalled
};
