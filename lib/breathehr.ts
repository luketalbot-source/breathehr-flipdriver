import { getConfig } from './config';
import {
  BreatheEmployee,
  BreatheLeaveRequest,
  BreatheAbsence,
  BreatheOtherLeaveReason,
  BreatheHolidayAllowance,
} from './types';

/**
 * BreatheHR API Client
 *
 * Base URL: https://api.breathehr.com/v1
 * Auth: X-API-KEY header
 * Rate limit: 60 requests per 60 seconds
 */
export class BreatheHRClient {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    const config = getConfig();
    this.apiKey = config.breathehr.apiKey;
    this.baseUrl = config.breathehr.baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (queryParams) {
      const params = new URLSearchParams(queryParams);
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      'X-API-KEY': this.apiKey,
      'Accept': 'application/json',
    };

    const options: Record<string, unknown> = { method, headers };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    console.log(`[BreatheHR] ${method} ${url}`);

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[BreatheHR] Error ${response.status}: ${errorBody}`);
      throw new Error(
        `BreatheHR API error: ${response.status} ${response.statusText} - ${errorBody}`
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ============================================================
  // Employees
  // ============================================================

  /**
   * List all employees (paginated)
   */
  async listEmployees(page = 1, perPage = 100): Promise<{ employees: BreatheEmployee[] }> {
    return this.request('GET', '/employees', undefined, {
      page: page.toString(),
      per_page: perPage.toString(),
    });
  }

  /**
   * Get all employees (auto-paginate)
   */
  async getAllEmployees(): Promise<BreatheEmployee[]> {
    const allEmployees: BreatheEmployee[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await this.listEmployees(page, 100);
      const employees = result.employees || [];
      allEmployees.push(...employees);
      hasMore = employees.length === 100;
      page++;
    }

    return allEmployees;
  }

  /**
   * Get a single employee by ID
   */
  async getEmployee(employeeId: number): Promise<{ employees: BreatheEmployee[] }> {
    return this.request('GET', `/employees/${employeeId}`);
  }

  /**
   * Find an employee by their reference number (the "Ref" field)
   * Searches all employees and matches on employee_number or reference
   */
  async findEmployeeByRef(ref: string): Promise<BreatheEmployee | null> {
    const employees = await this.getAllEmployees();

    for (const emp of employees) {
      // Try multiple possible field names for the reference
      const empRef =
        emp.employee_number || emp.reference || (emp as Record<string, unknown>).ref;
      if (empRef && String(empRef) === ref) {
        return emp;
      }
    }

    return null;
  }

  // ============================================================
  // Leave Requests
  // ============================================================

  /**
   * Create a leave request for an employee
   */
  async createLeaveRequest(
    employeeId: number,
    startDate: string,
    endDate: string,
    options?: {
      halfStart?: boolean;
      halfEnd?: boolean;
      notes?: string;
      leaveReasonId?: number;
    }
  ): Promise<{ leave_requests: BreatheLeaveRequest[] }> {
    const body: Record<string, unknown> = {
      leave_request: {
        start_date: startDate,
        end_date: endDate,
        half_start: options?.halfStart ?? false,
        half_end: options?.halfEnd ?? false,
        ...(options?.notes && { notes: options.notes }),
        ...(options?.leaveReasonId && { leave_reason_id: options.leaveReasonId }),
      },
    };

    return this.request('POST', `/employees/${employeeId}/leave_requests`, body);
  }

  /**
   * Get a leave request by ID
   */
  async getLeaveRequest(leaveRequestId: number): Promise<{ leave_requests: BreatheLeaveRequest[] }> {
    return this.request('GET', `/leave_requests/${leaveRequestId}`);
  }

  /**
   * List leave requests (paginated)
   */
  async listLeaveRequests(
    page = 1,
    perPage = 100,
    filters?: Record<string, string>
  ): Promise<{ leave_requests: BreatheLeaveRequest[] }> {
    const params: Record<string, string> = {
      page: page.toString(),
      per_page: perPage.toString(),
      ...filters,
    };
    return this.request('GET', '/leave_requests', undefined, params);
  }

  // ============================================================
  // Absences
  // ============================================================

  /**
   * List absences (paginated, with optional filters)
   */
  async listAbsences(
    page = 1,
    perPage = 100,
    filters?: Record<string, string>
  ): Promise<{ absences: BreatheAbsence[] }> {
    const params: Record<string, string> = {
      page: page.toString(),
      per_page: perPage.toString(),
      ...filters,
    };
    return this.request('GET', '/absences', undefined, params);
  }

  /**
   * Get absences for a specific employee
   */
  async getEmployeeAbsences(
    employeeId: number,
    page = 1,
    perPage = 100
  ): Promise<{ absences: BreatheAbsence[] }> {
    return this.request('GET', `/employees/${employeeId}/absences`, undefined, {
      page: page.toString(),
      per_page: perPage.toString(),
    });
  }

  /**
   * Get all absences for an employee (auto-paginate)
   */
  async getAllEmployeeAbsences(employeeId: number): Promise<BreatheAbsence[]> {
    const allAbsences: BreatheAbsence[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await this.getEmployeeAbsences(employeeId, page, 100);
      const absences = result.absences || [];
      allAbsences.push(...absences);
      hasMore = absences.length === 100;
      page++;
    }

    return allAbsences;
  }

  /**
   * Cancel an absence
   */
  async cancelAbsence(absenceId: number): Promise<void> {
    await this.request('POST', `/absences/${absenceId}/cancel`);
  }

  // ============================================================
  // Holiday Allowances
  // ============================================================

  /**
   * List holiday allowances
   */
  async listHolidayAllowances(): Promise<{ holiday_allowances: BreatheHolidayAllowance[] }> {
    return this.request('GET', '/holiday_allowances');
  }

  // ============================================================
  // Other Leave Reasons (used as absence policy types)
  // ============================================================

  /**
   * List other leave reasons
   */
  async listOtherLeaveReasons(): Promise<{ other_leave_reasons: BreatheOtherLeaveReason[] }> {
    return this.request('GET', '/other_leave_reasons');
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Test connectivity to BreatheHR API
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.listEmployees(1, 1);
      return true;
    } catch {
      return false;
    }
  }
}
