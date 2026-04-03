const axios = require("axios");
const os = require("os");

function normalizeNullableText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const lowered = text.toLowerCase();
  if (
    lowered === "-" ||
    lowered === "null" ||
    lowered === "undefined" ||
    lowered === "n/a" ||
    lowered === "na"
  ) {
    return null;
  }

  return text;
}

function parseBooleanLike(value) {
  if (value === true || value === false) {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(lowered)) {
      return true;
    }
    if (["false", "0", "no", "n", "off", ""].includes(lowered)) {
      return false;
    }
  }

  return null;
}

function statusLooksLikeBreak(attendanceStatus) {
  if (!attendanceStatus) {
    return false;
  }

  const lowered = String(attendanceStatus).toLowerCase();
  if (!lowered.includes("break")) {
    return false;
  }

  return !(
    lowered.includes("end break") ||
    lowered.includes("break end") ||
    lowered.includes("break out") ||
    lowered.includes("resume") ||
    lowered.includes("office out")
  );
}

function statusLooksLikeOfficeOut(attendanceStatus) {
  if (!attendanceStatus) {
    return false;
  }

  const lowered = String(attendanceStatus).toLowerCase();
  return (
    lowered.includes("office out") ||
    lowered.includes("checked out") ||
    lowered.includes("clocked out")
  );
}

function parseTimeToSeconds(value) {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const timeMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!timeMatch) {
    return null;
  }

  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] || 0);

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

function inferBreakByTimes(breakIn, breakOut) {
  if (!breakIn) {
    return false;
  }

  if (!breakOut) {
    return true;
  }

  const breakInSeconds = parseTimeToSeconds(breakIn);
  const breakOutSeconds = parseTimeToSeconds(breakOut);
  if (breakInSeconds === null || breakOutSeconds === null) {
    return false;
  }

  return breakInSeconds > breakOutSeconds;
}

class AuthService {
  constructor({ dataStore, erpBaseUrl }) {
    this.dataStore = dataStore;
    this.erpBaseUrl = (erpBaseUrl || "https://erp.vendaxis.com").replace(/\/+$/, "");
  }

  async login({ email, password }) {
    const endpoint = `${this.erpBaseUrl}/api/admin/login`;
    const host = (os.hostname() || "desktop").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const response = await axios.post(endpoint, {
      email,
      password,
      user_type: "Employee",
      device_name: `desktop-${host}`
    }, {
      timeout: 15000
    });

    const body = response.data || {};
    if (!body.status || !body.token) {
      throw new Error(body.message || "Login failed");
    }

    this.dataStore.setAuthSession({
      token: body.token,
      userType: "Employee",
      employee: this.normalizeEmployee(body.user)
    });
    this.dataStore.persist();

    await this.refreshEmployeeProfile();
    return this.dataStore.getAuthSession();
  }

  async logout() {
    const session = this.dataStore.getAuthSession();
    if (session?.token) {
      try {
        await axios.post(`${this.erpBaseUrl}/api/admin/logout`, {}, {
          timeout: 10000,
          headers: { Authorization: `Bearer ${session.token}` }
        });
      } catch {
        // Ignore logout API errors, local cleanup still proceeds.
      }
    }

    this.dataStore.clearAuthSession();
    this.dataStore.persist();
    return this.dataStore.getAuthSession();
  }

  getSession() {
    return this.dataStore.getAuthSession();
  }

  async refreshEmployeeProfile() {
    const session = this.dataStore.getAuthSession();
    if (!session?.token) {
      return this.dataStore.getAuthSession();
    }

    const response = await axios.get(`${this.erpBaseUrl}/api/admin/tracker/me`, {
      timeout: 15000,
      params: { _t: Date.now() },
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      }
    });

    const body = response.data || {};
    const employee = this.normalizeEmployee(body.employee || session.employee);
    this.dataStore.updateAuthEmployee(employee);
    this.dataStore.persist();

    return this.dataStore.getAuthSession();
  }

  normalizeEmployee(employee) {
    if (!employee) {
      return null;
    }

    const officeIn = normalizeNullableText(employee.office_in ?? employee.officeIn);
    const attendanceStatus = normalizeNullableText(employee.attendance_status ?? employee.attendanceStatus);
    const explicitOfficeOut = normalizeNullableText(employee.office_out ?? employee.officeOut);
    const officeOut = explicitOfficeOut || (statusLooksLikeOfficeOut(attendanceStatus) ? attendanceStatus : null);
    const breakIn = normalizeNullableText(employee.break_in ?? employee.breakIn);
    const breakOut = normalizeNullableText(employee.break_out ?? employee.breakOut);
    const explicitBreakFlag = parseBooleanLike(employee.is_on_break ?? employee.isOnBreak);
    const inferredBreakFromTimes = inferBreakByTimes(breakIn, breakOut);
    const inferredBreakFromStatus = statusLooksLikeBreak(attendanceStatus);
    const isOnBreak =
      explicitBreakFlag === true ||
      inferredBreakFromTimes ||
      inferredBreakFromStatus;

    return {
      id: employee.id,
      name: employee.name || employee.full_name || "",
      email: employee.email || "",
      designation: employee.designation || employee.job_title || "",
      officeIn,
      officeOut,
      attendanceStatus,
      breakIn,
      breakOut,
      isOnBreak,
      forgotToOut: parseBooleanLike(employee.forgot_to_out ?? employee.forgotToOut) === true,
      attendanceDate: normalizeNullableText(employee.attendance_date ?? employee.attendanceDate),
      serverNow: normalizeNullableText(employee.server_now ?? employee.serverNow),
      serverDate: normalizeNullableText(employee.server_date ?? employee.serverDate),
      serverTime: normalizeNullableText(employee.server_time ?? employee.serverTime),
      erpTimezone: normalizeNullableText(employee.timezone),
      shiftStartTime: normalizeNullableText(employee.shift_start_time),
      shiftEndTime: normalizeNullableText(employee.shift_end_time),
      shiftLateAfter: normalizeNullableText(employee.shift_late_after),
      shiftHalfDayAfter: normalizeNullableText(employee.shift_half_day_after),
      shiftLabel: normalizeNullableText(employee.shift_label)
    };
  }

  async validateStoredAuthToken() {
    const session = this.dataStore.getAuthSession();
    if (!session?.token) {
      return session;
    }

    try {
      // Try to refresh profile with stored token
      const response = await axios.get(`${this.erpBaseUrl}/api/admin/tracker/me`, {
        timeout: 10000,
        headers: { Authorization: `Bearer ${session.token}` }
      });

      if (response.status === 200) {
        const body = response.data || {};
        const employee = this.normalizeEmployee(body.employee || session.employee);
        this.dataStore.updateAuthEmployee(employee);
        this.dataStore.persist();
        return this.dataStore.getAuthSession();
      }

      // Non-200 response is treated as invalid
      this.dataStore.clearAuthSession();
      this.dataStore.persist();
    } catch (error) {
      // Token is invalid, expired, or network error
      // If network error, assume offline and keep session
      // If 401/403, clear the session
      const isNetworkError = !error.response;
      const isAuthError = error.response?.status === 401 || error.response?.status === 403;
      
      if (isAuthError || (!isNetworkError && error.response?.status)) {
        // Clear invalid token
        this.dataStore.clearAuthSession();
        this.dataStore.persist();
      }
      // If network error, keep session and assume offline
    }

    return this.dataStore.getAuthSession();
  }
}

module.exports = {
  AuthService
};
