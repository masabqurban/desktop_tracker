const axios = require("axios");

class AuthService {
  constructor({ dataStore, erpBaseUrl }) {
    this.dataStore = dataStore;
    this.erpBaseUrl = (erpBaseUrl || "http://127.0.0.1:8000").replace(/\/+$/, "");
  }

  async login({ email, password }) {
    const endpoint = `${this.erpBaseUrl}/api/admin/login`;
    const response = await axios.post(endpoint, {
      email,
      password,
      user_type: "Employee"
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
      headers: { Authorization: `Bearer ${session.token}` }
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

    return {
      id: employee.id,
      name: employee.name || employee.full_name || "",
      email: employee.email || "",
      designation: employee.designation || employee.job_title || "",
      officeIn: employee.office_in || null,
      officeOut: employee.office_out || null,
      attendanceStatus: employee.attendance_status || null,
      breakIn: employee.break_in || null,
      breakOut: employee.break_out || null,
      isOnBreak: employee.is_on_break === true
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
