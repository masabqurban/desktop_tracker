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

    const officeIn = normalizeNullableText(employee.office_in);
    const officeOut = normalizeNullableText(employee.office_out);
    const attendanceStatus = normalizeNullableText(employee.attendance_status);
    const breakIn = normalizeNullableText(employee.break_in);
    const breakOut = normalizeNullableText(employee.break_out);
    const explicitBreakFlag = parseBooleanLike(employee.is_on_break);
    const inferredBreakFromTimes = Boolean(breakIn && !breakOut);
    const inferredBreakFromStatus = statusLooksLikeBreak(attendanceStatus);
    const isOnBreak = explicitBreakFlag === null
      ? inferredBreakFromTimes || inferredBreakFromStatus
      : explicitBreakFlag;

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
      forgotToOut: parseBooleanLike(employee.forgot_to_out) === true,
      attendanceDate: normalizeNullableText(employee.attendance_date),
      serverNow: normalizeNullableText(employee.server_now),
      serverDate: normalizeNullableText(employee.server_date),
      serverTime: normalizeNullableText(employee.server_time),
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
