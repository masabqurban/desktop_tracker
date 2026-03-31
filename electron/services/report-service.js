function getDateKeys(data) {
  return Object.keys(data.daily || {}).sort();
}

function aggregateDailyEntries(entries) {
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
    summary.activeMs += day.activeMs || 0;
    summary.idleMs += day.idleMs || 0;
    summary.keyboardCount += day.keyboardCount || 0;
    summary.mouseCount += day.mouseCount || 0;
    summary.appSwitches += day.appSwitches || 0;
    summary.browserEvents += day.browserEvents || 0;
    summary.desktopEvents += day.desktopEvents || 0;

    const usage = day.appUsageMs || {};
    for (const appName of Object.keys(usage)) {
      summary.appUsageMs[appName] = (summary.appUsageMs[appName] || 0) + usage[appName];
    }
  }

  return summary;
}

function topApps(appUsageMs, limit = 10) {
  return Object.entries(appUsageMs || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, durationMs]) => ({ name, durationMs }));
}

function buildRange(data, days) {
  const keys = getDateKeys(data);
  const selected = keys.slice(-days).map((key) => data.daily[key]);
  return aggregateDailyEntries(selected);
}

function createDashboardPayload(data) {
  const today = buildRange(data, 1);
  const weekly = buildRange(data, 7);
  const monthly = buildRange(data, 30);

  const extensionStatus = data.extensionStatus || {};
  const now = Date.now();
  let totalEnabledMs = extensionStatus.totalEnabledMs || 0;
  let totalDisabledMs = extensionStatus.totalDisabledMs || 0;
  
  if (extensionStatus.enabled) {
    totalEnabledMs += now - (extensionStatus.lastStateChange || now);
  } else {
    totalDisabledMs += now - (extensionStatus.lastStateChange || now);
  }

  const rawBrowserStatus = data.browserStatus || {};
  const browserStatus = Object.fromEntries(
    Object.entries(rawBrowserStatus).filter(([name]) => name && name !== "undefined" && name !== "Unknown")
  );

  return {
    generatedAt: Date.now(),
    totals: {
      totalTrackedMs: Object.values(data.appUsageMs || {}).reduce((sum, value) => sum + value, 0),
      totalIdleMs: Object.values(data.daily || {}).reduce((sum, day) => sum + (day.idleMs || 0), 0),
      totalKeyboard: Object.values(data.daily || {}).reduce((sum, day) => sum + (day.keyboardCount || 0), 0),
      totalMouse: Object.values(data.daily || {}).reduce((sum, day) => sum + (day.mouseCount || 0), 0)
    },
    openedApps: Object.keys(data.openedApps || {}).length,
    syncQueueSize: (data.syncQueue || []).length,
    extensionStatus: {
      currentlyEnabled: extensionStatus.enabled,
      totalEnabledMs,
      totalDisabledMs,
      enabledPercent: totalEnabledMs + totalDisabledMs > 0 
        ? Math.round((totalEnabledMs / (totalEnabledMs + totalDisabledMs)) * 100) 
        : 0
    },
    browserContext: data.browserContext || { incognito: 0, normal: 0 },
    browserStatus,
    installedBrowsers: data.installedBrowsers || {},
    extensionData: {
       topDomains: Array.isArray(data.extensionData?.topDomains) 
         ? data.extensionData.topDomains.slice(0, 10)
         : [],
      totalTabMs: data.extensionData?.totalTabMs || 0,
      totalIdleMs: data.extensionData?.totalIdleMs || 0,
      daily: data.extensionData?.daily || {},
      weekly: data.extensionData?.weekly || {},
      monthly: data.extensionData?.monthly || {},
      productivity: data.extensionData?.productivity || 0
    },
    screenshots: (data.screenshots || []).slice(-10).reverse(),
    periods: {
      daily: { ...today, topApps: topApps(today.appUsageMs) },
      weekly: { ...weekly, topApps: topApps(weekly.appUsageMs) },
      monthly: { ...monthly, topApps: topApps(monthly.appUsageMs) }
    },
    mostUsedApps: topApps(data.appUsageMs, 15),
    recentDesktopEvents: [...(data.events || [])].slice(-200).reverse(),
    recentBrowserEvents: [...(data.browserEvents || [])].slice(-300).reverse(),
    allBrowserEvents: [...(data.browserEvents || [])].reverse(),
    allDesktopEvents: [...(data.events || [])].reverse(),
    dailyBreakdown: getDateKeys(data).slice(-30).map((date) => ({
      date,
      ...(data.daily[date] || {})
    }))
  };
}

module.exports = {
  createDashboardPayload,
  topApps,
  buildRange
};
