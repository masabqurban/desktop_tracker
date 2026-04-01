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

function deriveExtensionDataFromEvents(data) {
  const browserEvents = Array.isArray(data.browserEvents) ? data.browserEvents : [];
  const now = Date.now();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dailyStart = dayStart.getTime();
  const weeklyStart = dailyStart - 6 * 24 * 60 * 60 * 1000;
  const monthlyStart = dailyStart - 29 * 24 * 60 * 60 * 1000;

  let totalTabMs = 0;
  let totalIdleMs = 0;
  const domainTotals = {};

  const rangeState = {
    daily: { tabMs: 0, idleMs: 0, eventCount: 0, domainTotals: {} },
    weekly: { tabMs: 0, idleMs: 0, eventCount: 0, domainTotals: {} },
    monthly: { tabMs: 0, idleMs: 0, eventCount: 0, domainTotals: {} }
  };

  const sortedIdle = browserEvents
    .map((item) => item?.event || item)
    .filter((event) => event?.type === "idle")
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const addIdleForRange = (start, end) => {
    let idleMs = 0;
    let state = "active";
    let cursor = start;

    for (const event of sortedIdle) {
      const t = event.timestamp || 0;
      if (t < start) {
        state = event.state || state;
        continue;
      }
      if (t > end) {
        break;
      }

      if ((state === "idle" || state === "locked") && t > cursor) {
        idleMs += t - cursor;
      }

      cursor = Math.max(cursor, t);
      state = event.state || state;
    }

    if ((state === "idle" || state === "locked") && end > cursor) {
      idleMs += end - cursor;
    }

    return idleMs;
  };

  for (const wrapper of browserEvents) {
    const event = wrapper?.event || wrapper;
    const timestamp = event?.timestamp || wrapper?.timestamp || 0;
    if (!timestamp) {
      continue;
    }

    if (timestamp >= dailyStart) {
      rangeState.daily.eventCount += 1;
    }
    if (timestamp >= weeklyStart) {
      rangeState.weekly.eventCount += 1;
    }
    if (timestamp >= monthlyStart) {
      rangeState.monthly.eventCount += 1;
    }

    if (event?.type !== "tab") {
      continue;
    }

    const duration = Number(event.duration || 0);
    if (duration <= 0) {
      continue;
    }

    totalTabMs += duration;

    let domain = "unknown";
    try {
      domain = new URL(event.url || "").hostname || "unknown";
    } catch {
      domain = "unknown";
    }
    domainTotals[domain] = (domainTotals[domain] || 0) + duration;

    if (timestamp >= dailyStart) {
      rangeState.daily.tabMs += duration;
      rangeState.daily.domainTotals[domain] = (rangeState.daily.domainTotals[domain] || 0) + duration;
    }
    if (timestamp >= weeklyStart) {
      rangeState.weekly.tabMs += duration;
      rangeState.weekly.domainTotals[domain] = (rangeState.weekly.domainTotals[domain] || 0) + duration;
    }
    if (timestamp >= monthlyStart) {
      rangeState.monthly.tabMs += duration;
      rangeState.monthly.domainTotals[domain] = (rangeState.monthly.domainTotals[domain] || 0) + duration;
    }
  }

  rangeState.daily.idleMs = addIdleForRange(dailyStart, now);
  rangeState.weekly.idleMs = addIdleForRange(weeklyStart, now);
  rangeState.monthly.idleMs = addIdleForRange(monthlyStart, now);
  totalIdleMs = addIdleForRange(0, now);

  const toTopDomains = (totals) =>
    Object.entries(totals || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, durationMs]) => ({ domain, durationMs }));

  const productivity = totalTabMs + totalIdleMs > 0
    ? Math.round((totalTabMs / (totalTabMs + totalIdleMs)) * 100)
    : 0;

  return {
    topDomains: toTopDomains(domainTotals),
    totalTabMs,
    totalIdleMs,
    daily: {
      tabMs: rangeState.daily.tabMs,
      idleMs: rangeState.daily.idleMs,
      eventCount: rangeState.daily.eventCount,
      topDomains: toTopDomains(rangeState.daily.domainTotals)
    },
    weekly: {
      tabMs: rangeState.weekly.tabMs,
      idleMs: rangeState.weekly.idleMs,
      eventCount: rangeState.weekly.eventCount,
      topDomains: toTopDomains(rangeState.weekly.domainTotals)
    },
    monthly: {
      tabMs: rangeState.monthly.tabMs,
      idleMs: rangeState.monthly.idleMs,
      eventCount: rangeState.monthly.eventCount,
      topDomains: toTopDomains(rangeState.monthly.domainTotals)
    },
    productivity
  };
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

  const storedExtensionData = data.extensionData || {};
  const needsExtensionFallback =
    !storedExtensionData.totalTabMs &&
    !storedExtensionData.totalIdleMs &&
    (!Array.isArray(storedExtensionData.topDomains) || storedExtensionData.topDomains.length === 0);
  const resolvedExtensionData = needsExtensionFallback
    ? deriveExtensionDataFromEvents(data)
    : {
        topDomains: Array.isArray(storedExtensionData.topDomains) ? storedExtensionData.topDomains : [],
        totalTabMs: storedExtensionData.totalTabMs || 0,
        totalIdleMs: storedExtensionData.totalIdleMs || 0,
        daily: storedExtensionData.daily || {},
        weekly: storedExtensionData.weekly || {},
        monthly: storedExtensionData.monthly || {},
        productivity: storedExtensionData.productivity || 0
      };

  return {
    generatedAt: Date.now(),
    auth: data.auth || {
      isAuthenticated: false,
      token: "",
      userType: "Employee",
      employee: null,
      loginAt: null,
      lastProfileRefreshAt: null
    },
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
      topDomains: Array.isArray(resolvedExtensionData.topDomains)
        ? resolvedExtensionData.topDomains.slice(0, 10)
        : [],
      totalTabMs: resolvedExtensionData.totalTabMs || 0,
      totalIdleMs: resolvedExtensionData.totalIdleMs || 0,
      daily: resolvedExtensionData.daily || {},
      weekly: resolvedExtensionData.weekly || {},
      monthly: resolvedExtensionData.monthly || {},
      productivity: resolvedExtensionData.productivity || 0
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
