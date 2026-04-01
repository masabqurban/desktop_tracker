import React, { useEffect, useMemo, useState } from "react";

function formatDuration(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function ratioPercent(part, total) {
  if (!total || total <= 0) {
    return 0;
  }
  return Math.round((part / total) * 100);
}

function MetricCard({ label, value }) {
  return (
    <article className="metric-card">
      <h3>{label}</h3>
      <strong>{value}</strong>
    </article>
  );
}

function PeriodCard({ title, activeMs, idleMs, switches }) {
  return (
    <article className="card">
      <h2>{title}</h2>
      <p>Tracked: {formatDuration(activeMs)}</p>
      <p>Idle: {formatDuration(idleMs)}</p>
      <p>Switches: {formatNumber(switches)}</p>
    </article>
  );
}

function BarChartCard({ title, rows, valueLabelFormatter }) {
  const maxValue = Math.max(1, ...rows.map((row) => row.value || 0));

  return (
    <article className="card">
      <h2>{title}</h2>
      <div className="chart-list">
        {rows.length === 0 ? <p className="chart-empty">No data available.</p> : null}
        {rows.map((row) => (
          <div key={row.label} className="chart-row">
            <div className="chart-head">
              <span className="chart-label">{row.label}</span>
              <span className="chart-value">{valueLabelFormatter(row.value)}</span>
            </div>
            <div className="chart-track">
              <div className="chart-fill" style={{ width: `${Math.max(4, (row.value / maxValue) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function App() {
  const PAGE_SIZE = 15;
  const SCREENSHOT_PAGE_SIZE = 3;
  const [dashboard, setDashboard] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("-");
  const [activeTab, setActiveTab] = useState("system");
  const [browserVisibleCount, setBrowserVisibleCount] = useState(PAGE_SIZE);
  const [desktopVisibleCount, setDesktopVisibleCount] = useState(PAGE_SIZE);
  const [screenshotPage, setScreenshotPage] = useState(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");

  const loadDashboard = async () => {
    const data = await window.trackerApi.getDashboard();
    setDashboard(data);
    setLastUpdated(new Date().toLocaleTimeString());
  };

  useEffect(() => {
    loadDashboard();

    const unsubscribe = window.trackerApi.onUpdate(() => {
      loadDashboard();
    });

    const dashboardTimer = setInterval(() => {
      loadDashboard();
    }, 15000);

    // Refresh employee profile every 5 minutes to keep office hours updated
    const profileRefreshTimer = setInterval(async () => {
      const session = await window.trackerApi.getSession();
      if (session?.isAuthenticated) {
        await window.trackerApi.refreshSession();
        await loadDashboard();
      }
    }, 5 * 60 * 1000);

    return () => {
      unsubscribe();
      clearInterval(dashboardTimer);
      clearInterval(profileRefreshTimer);
    };
  }, []);

  const topApps = useMemo(() => dashboard?.periods?.daily?.topApps || [], [dashboard]);
  const extensionDomains = useMemo(() => dashboard?.extensionData?.topDomains || [], [dashboard]);
  const screenshots = useMemo(() => dashboard?.screenshots || [], [dashboard]);
  const browserEvents = useMemo(() => dashboard?.allBrowserEvents || dashboard?.recentBrowserEvents || [], [dashboard]);
  const desktopEvents = useMemo(() => dashboard?.allDesktopEvents || dashboard?.recentDesktopEvents || [], [dashboard]);

  const visibleBrowserEvents = useMemo(
    () => browserEvents.slice(0, browserVisibleCount),
    [browserEvents, browserVisibleCount]
  );
  const visibleDesktopEvents = useMemo(
    () => desktopEvents.slice(0, desktopVisibleCount),
    [desktopEvents, desktopVisibleCount]
  );

  const totalScreenshotPages = Math.max(1, Math.ceil(screenshots.length / SCREENSHOT_PAGE_SIZE));
  const safeScreenshotPage = Math.min(screenshotPage, totalScreenshotPages);
  const visibleScreenshots = useMemo(() => {
    const start = (safeScreenshotPage - 1) * SCREENSHOT_PAGE_SIZE;
    return screenshots.slice(start, start + SCREENSHOT_PAGE_SIZE);
  }, [screenshots, safeScreenshotPage]);

  useEffect(() => {
    if (screenshotPage > totalScreenshotPages) {
      setScreenshotPage(totalScreenshotPages);
    }
  }, [screenshotPage, totalScreenshotPages]);

  const extensionPeriodRows = useMemo(
    () => [
      { label: "Daily", value: dashboard?.extensionData?.daily?.tabMs || 0 },
      { label: "Weekly", value: dashboard?.extensionData?.weekly?.tabMs || 0 },
      { label: "Monthly", value: dashboard?.extensionData?.monthly?.tabMs || 0 }
    ],
    [dashboard]
  );

  const topAppRows = useMemo(
    () => (topApps || []).slice(0, 8).map((row) => ({ label: row.name, value: row.durationMs || 0 })),
    [topApps]
  );

  const extensionDomainRows = useMemo(
    () => (extensionDomains || []).slice(0, 8).map((row) => ({ label: row.domain || "unknown", value: row.durationMs || 0 })),
    [extensionDomains]
  );

  const systemPerformanceRows = useMemo(() => {
    const entries = dashboard?.dailyBreakdown || [];
    return entries.slice(-7).map((day) => {
      const active = day.activeMs || 0;
      const idle = day.idleMs || 0;
      const interactions = (day.keyboardCount || 0) + (day.mouseCount || 0);
      const utilization = ratioPercent(active, active + idle);
      const interactionScore = Math.min(100, Math.round((interactions / 800) * 100));
      const score = Math.round(utilization * 0.7 + interactionScore * 0.3);
      return {
        label: (day.date || "").slice(5),
        value: score
      };
    });
  }, [dashboard]);

  const onSyncNow = async () => {
    setSyncing(true);
    await window.trackerApi.queueSync("manual");
    await window.trackerApi.forceSync();
    await loadDashboard();
    setSyncing(false);
  };

  const onLogin = async (event) => {
    event.preventDefault();
    if (!email || !password) {
      setAuthError("Email and password are required");
      return;
    }

    setAuthLoading(true);
    setAuthError("");
    const response = await window.trackerApi.login({ email, password });
    if (!response?.ok) {
      setAuthError(response?.error || "Login failed");
    } else {
      setPassword("");
      await loadDashboard();
    }
    setAuthLoading(false);
  };

  const onLogout = async () => {
    setAuthLoading(true);
    setAuthError("");
    await window.trackerApi.logout();
    await loadDashboard();
    setAuthLoading(false);
  };

  const onRefreshProfile = async () => {
    setAuthLoading(true);
    setAuthError("");
    const response = await window.trackerApi.refreshSession();
    if (!response?.ok) {
      setAuthError(response?.error || "Failed to refresh profile");
    }
    await loadDashboard();
    setAuthLoading(false);
  };

  const onOpenErpLogin = async () => {
    await window.trackerApi.openErpLogin();
  };

  const onOpenScreenshot = async (screenshotPath) => {
    if (!screenshotPath) {
      return;
    }

    const result = await window.trackerApi.openScreenshot(screenshotPath);
    if (!result?.ok) {
      alert(result?.error || "Failed to open screenshot file");
    }
  };

  if (!dashboard) {
    return <div className="loading">Loading tracker dashboard...</div>;
  }

  // Use installedBrowsers as source of truth for what exists on this system.
  const installedMap = dashboard.installedBrowsers || {};
  const auth = dashboard.auth || {};
  const employee = auth.employee || null;
  const isAuthenticated = Boolean(auth.isAuthenticated && auth.token);

  // Check if current time is within office hours
  const isWithinOfficeHours = (() => {
    if (!employee?.officeIn || !employee?.officeOut) {
      return true; // If no office hours set, consider tracking always active
    }

    try {
      const now = new Date();
      const [inHour, inMin] = employee.officeIn.split(":").map(Number);
      const [outHour, outMin] = employee.officeOut.split(":").map(Number);

      const officeIn = new Date();
      officeIn.setHours(inHour, inMin, 0, 0);

      const officeOut = new Date();
      officeOut.setHours(outHour, outMin, 0, 0);

      // Handle case where office out is next day
      if (officeOut < officeIn) {
        officeOut.setDate(officeOut.getDate() + 1);
      }

      return now >= officeIn && now < officeOut;
    } catch {
      return true;
    }
  })();
  const allBrowsers = Object.entries(installedMap)
    .filter(([, info]) => Boolean(info?.installed))
    .map(([name, info]) => {
      const status = dashboard.browserStatus?.[name] || {};
      return {
        name,
        installed: true,
        isRunning: Boolean(info?.isRunning),
        enabled: Boolean(status?.enabled),
        totalEnabledMs: status?.totalEnabledMs || 0
      };
    })
    .sort((a, b) => (Number(b.isRunning) - Number(a.isRunning)) || ((b.totalEnabledMs || 0) - (a.totalEnabledMs || 0)));

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-copy">
          <h1>Employee Desktop Tracker</h1>
          <p>Professional monitoring dashboard with separate browser extension and desktop tracking views.</p>
        </div>
        <div className="hero-actions">
          <button onClick={loadDashboard}>Refresh</button>
          <button onClick={onSyncNow} disabled={syncing || !isAuthenticated}>
            {syncing ? "Syncing..." : "Sync to ERP"}
          </button>
        </div>
      </header>

      <section className="toolbar">
        <div className="tabs">
          <button
            className={`tab-btn ${activeTab === "system" ? "active" : ""}`}
            onClick={() => setActiveTab("system")}
          >
            System Tracking
          </button>
          <button
            className={`tab-btn ${activeTab === "extension" ? "active" : ""}`}
            onClick={() => setActiveTab("extension")}
          >
            Extension Tracking
          </button>
        </div>
        <div className="updated-pill">Last updated: {lastUpdated}</div>
      </section>

      <section className="card auth-card">
        <div className="auth-header">
          <h2>Employee Authentication</h2>
          <span className={`auth-pill ${isAuthenticated ? "ok" : "warn"}`}>
            {isAuthenticated ? "Linked" : "Not Linked"}
          </span>
        </div>

        {!isAuthenticated && (
          <form className="auth-form" onSubmit={onLogin}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Employee email"
              autoComplete="username"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
            />
            <div className="auth-actions">
              <button type="submit" disabled={authLoading}>{authLoading ? "Signing in..." : "Sign In"}</button>
              <button type="button" className="secondary-btn" onClick={onOpenErpLogin}>Open ERP Login</button>
            </div>
          </form>
        )}

        {isAuthenticated && (
          <div className="auth-profile">
            <p><strong>Name:</strong> {employee?.name || "-"}</p>
            <p><strong>Email:</strong> {employee?.email || "-"}</p>
            <p><strong>Designation:</strong> {employee?.designation || "-"}</p>
            <p><strong>Office In:</strong> {employee?.officeIn || "-"}</p>
            <p><strong>Office Out:</strong> {employee?.officeOut || "-"}</p>
            {employee?.officeIn && employee?.officeOut && (
              <p className="office-hours-status">
                <strong>Status:</strong>
                <span className={`status-badge ${isWithinOfficeHours ? 'active' : 'inactive'}`}>
                  {isWithinOfficeHours ? '🟢 Tracking Active' : '🔴 Outside Office Hours'}
                </span>
              </p>
            )}
            <div className="auth-actions">
              <button type="button" onClick={onRefreshProfile} disabled={authLoading}>
                {authLoading ? "Refreshing..." : "Refresh Employee Info"}
              </button>
              <button type="button" className="secondary-btn" onClick={onLogout} disabled={authLoading}>
                Logout
              </button>
            </div>
          </div>
        )}

        {authError ? <p className="auth-error">{authError}</p> : null}
      </section>

      {activeTab === "extension" && (
        <>
          <section className="metrics-grid">
            <MetricCard
              label="Extension State"
              value={dashboard.extensionStatus?.currentlyEnabled ? "Enabled" : "Disabled"}
            />
            <MetricCard label="Total Tab Time" value={formatDuration(dashboard.extensionData?.totalTabMs || 0)} />
            <MetricCard label="Total Idle" value={formatDuration(dashboard.extensionData?.totalIdleMs || 0)} />
            <MetricCard label="Productivity" value={`${dashboard.extensionData?.productivity || 0}%`} />
          </section>

          <section className="status-grid">
            <article className="card">
              <h2>Installed Browsers</h2>
              <ul className="list">
                {allBrowsers.length === 0 ? <li>No installed browsers detected</li> : null}
                {allBrowsers.map((browser) => (
                  <li key={browser.name}>
                    <span>{browser.name}</span>
                    <span>
                      {browser.isRunning ? "Running" : "Idle"} | Ext {browser.enabled ? "Active" : "No Data"}
                    </span>
                  </li>
                ))}
              </ul>
            </article>

            <article className="card">
              <h2>Browser Context</h2>
              <p>Normal tabs: <strong>{formatNumber(dashboard.browserContext?.normal || 0)}</strong></p>
              <p>Incognito tabs: <strong>{formatNumber(dashboard.browserContext?.incognito || 0)}</strong></p>
              <p>Uptime: <strong>{dashboard.extensionStatus?.enabledPercent || 0}%</strong></p>
            </article>
          </section>

          <section className="layout-grid two-col">
            <article className="card">
              <h2>Top Domains</h2>
              <ul className="list">
                {extensionDomains.length === 0 ? <li>No domains tracked yet.</li> : null}
                {extensionDomains.map((row, idx) => (
                  <li key={row.domain || idx}>
                    <span>{row.domain || "unknown"}</span>
                    <span>{formatDuration(row.durationMs || 0)}</span>
                  </li>
                ))}
              </ul>
            </article>

            <article className="card">
              <h2>Extension Period Summary</h2>
              <p>Daily: {formatDuration(dashboard.extensionData?.daily?.tabMs || 0)}</p>
              <p>Weekly: {formatDuration(dashboard.extensionData?.weekly?.tabMs || 0)}</p>
              <p>Monthly: {formatDuration(dashboard.extensionData?.monthly?.tabMs || 0)}</p>
              <p>Enabled: {formatDuration(dashboard.extensionStatus?.totalEnabledMs || 0)}</p>
            </article>
          </section>

          <section className="chart-grid">
            <BarChartCard
              title="Top Domain Focus"
              rows={extensionDomainRows}
              valueLabelFormatter={(v) => formatDuration(v)}
            />
            <BarChartCard
              title="Extension Activity Comparison"
              rows={extensionPeriodRows}
              valueLabelFormatter={(v) => formatDuration(v)}
            />
          </section>

          <section className="card">
            <h2>Browser Events</h2>
            <ul className="list small">
              {visibleBrowserEvents.length === 0 ? <li>No browser events received yet.</li> : null}
              {visibleBrowserEvents.map((event, index) => (
                <li key={`${event.timestamp || index}-${index}`}>
                  <span>{event.event?.type || event.type || "event"} ({event.browser || "Unknown"})</span>
                  <span>{new Date(event.timestamp || Date.now()).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
            {browserVisibleCount < browserEvents.length && (
              <button
                onClick={() => setBrowserVisibleCount((prev) => prev + PAGE_SIZE)}
                className="toggle-btn"
              >
                Load More ({browserEvents.length - browserVisibleCount} remaining)
              </button>
            )}
          </section>
        </>
      )}

      {activeTab === "system" && (
        <>
          <section className="metrics-grid">
            <MetricCard label="Total Tracked" value={formatDuration(dashboard.totals.totalTrackedMs)} />
            <MetricCard label="Total Idle" value={formatDuration(dashboard.totals.totalIdleMs)} />
            <MetricCard label="Keyboard Events" value={formatNumber(dashboard.totals.totalKeyboard)} />
            <MetricCard label="Mouse Events" value={formatNumber(dashboard.totals.totalMouse)} />
            <MetricCard label="Opened Apps" value={formatNumber(dashboard.openedApps)} />
            <MetricCard label="Pending Queue" value={formatNumber(dashboard.syncQueueSize)} />
          </section>

          <section className="period-grid">
            <PeriodCard
              title="Daily"
              activeMs={dashboard.periods.daily.activeMs}
              idleMs={dashboard.periods.daily.idleMs}
              switches={dashboard.periods.daily.appSwitches}
            />
            <PeriodCard
              title="Weekly"
              activeMs={dashboard.periods.weekly.activeMs}
              idleMs={dashboard.periods.weekly.idleMs}
              switches={dashboard.periods.weekly.appSwitches}
            />
            <PeriodCard
              title="Monthly"
              activeMs={dashboard.periods.monthly.activeMs}
              idleMs={dashboard.periods.monthly.idleMs}
              switches={dashboard.periods.monthly.appSwitches}
            />
          </section>

          <section className="layout-grid two-col">
            <article className="card">
              <h2>Most Used Apps</h2>
              <ul className="list">
                {topApps.length === 0 ? <li>No app activity yet.</li> : null}
                {topApps.map((row) => (
                  <li key={row.name}>
                    <span>{row.name}</span>
                    <span>{formatDuration(row.durationMs)}</span>
                  </li>
                ))}
              </ul>
            </article>

            <article className="card">
              <h2>Desktop Events</h2>
              <ul className="list small">
                {visibleDesktopEvents.length === 0 ? <li>No desktop events yet.</li> : null}
                {visibleDesktopEvents.map((event, index) => (
                  <li key={`${event.timestamp || index}-${index}`}>
                    <span>{event.type || "desktop_event"}</span>
                    <span>{new Date(event.timestamp || Date.now()).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
              {desktopVisibleCount < desktopEvents.length && (
                <button
                  onClick={() => setDesktopVisibleCount((prev) => prev + PAGE_SIZE)}
                  className="toggle-btn"
                >
                  Load More ({desktopEvents.length - desktopVisibleCount} remaining)
                </button>
              )}
            </article>
          </section>

          <section className="chart-grid">
            <BarChartCard
              title="Top App Usage"
              rows={topAppRows}
              valueLabelFormatter={(v) => formatDuration(v)}
            />
            <BarChartCard
              title="System Performance (Last 7 Days)"
              rows={systemPerformanceRows}
              valueLabelFormatter={(v) => `${v}%`}
            />
          </section>
        </>
      )}

      {screenshots.length > 0 && (
        <section className="screenshots-section card">
          <div className="screenshots-header">
            <h2>Idle Activity Snapshots</h2>
            <div className="screenshots-pagination">
              <button
                type="button"
                className="page-btn"
                onClick={() => setScreenshotPage((prev) => Math.max(1, prev - 1))}
                disabled={safeScreenshotPage === 1}
              >
                Previous
              </button>
              <span>
                Page {safeScreenshotPage} of {totalScreenshotPages}
              </span>
              <button
                type="button"
                className="page-btn"
                onClick={() => setScreenshotPage((prev) => Math.min(totalScreenshotPages, prev + 1))}
                disabled={safeScreenshotPage === totalScreenshotPages}
              >
                Next
              </button>
            </div>
          </div>
          <div className="screenshots-grid">
            {visibleScreenshots.map((screenshot, index) => (
              <article key={index} className="screenshot-card">
                <p className="timestamp">{new Date(screenshot.timestamp).toLocaleString()}</p>
                <p className="idle-info">Idle for {Math.round((screenshot.idleMs || 0) / 60000)} min</p>
                <p className="idle-info">
                  Source: {screenshot.displayLabel || `Display ${screenshot.displayId || "Unknown"}`}
                  {screenshot.isActiveDisplay ? " (Active)" : ""}
                  {screenshot.resolution ? ` - ${screenshot.resolution}` : ""}
                </p>
                {screenshot.path && (
                  <button
                    type="button"
                    onClick={() => onOpenScreenshot(screenshot.path)}
                    className="screenshot-link"
                  >
                    View Screenshot
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <footer className="footer">Last updated: {lastUpdated}</footer>
    </div>
  );
}

export default App;
