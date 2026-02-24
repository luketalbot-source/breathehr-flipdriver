// ============================================================
// BreatheHR Types
// ============================================================

export interface BreatheEmployee {
  id: number;
  first_name: string;
  last_name: string;
  email?: string;
  employee_number?: string; // The "Ref" field in BreatheHR UI
  reference?: string; // Alternative name for the ref field
  status?: string;
  job_title?: string;
  department?: string;
  working_pattern?: BreatheWorkingPattern;
  holiday_allowance?: BreatheHolidayAllowance;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown; // Allow additional fields we haven't mapped
}

export interface BreatheWorkingPattern {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface BreatheHolidayAllowance {
  id: number;
  name: string;
  units: string; // "days" or "hours"
  amount: number;
  [key: string]: unknown;
}

export interface BreatheLeaveRequest {
  id: number;
  employee_id?: number;
  start_date: string;
  end_date: string;
  half_start?: boolean;
  half_end?: boolean;
  start_half_day?: boolean; // BreatheHR uses these names
  end_half_day?: boolean;
  status?: string;
  action?: string;
  notes?: string;
  leave_reason?: string;
  leave_reason_id?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface BreatheAbsence {
  id: number;
  employee: {
    id: number;
    first_name: string;
    last_name: string;
    [key: string]: unknown;
  };
  type?: string;
  start_date: string;
  end_date: string;
  half_start?: boolean;
  half_end?: boolean;
  deducted?: number;
  status?: string;
  leave_reason?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface BreatheOtherLeaveReason {
  id: number;
  name: string;
  colour?: string;
  deduct_from_holiday?: boolean;
  [key: string]: unknown;
}

export interface BreathePaginatedResponse<T> {
  [key: string]: T[] | number | undefined;
}

// ============================================================
// Flip Types (from YAML spec)
// ============================================================

export type AbsenceRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'ERROR';
export type AbsenceRequestDateType = 'FIRST_HALF' | 'SECOND_HALF';
export type AbsenceDurationUnit = 'DAYS' | 'HOURS';
export type BalanceTimeUnit = 'DAYS' | 'HOURS';
export type AbsencePolicyTimeUnit = 'DAYS' | 'HOURS';

export interface FlipAbsenceRequestDate {
  date: string; // YYYY-MM-DD
  type?: AbsenceRequestDateType;
}

export interface FlipAbsenceRequestDisplayDate {
  date: string; // Local datetime without timezone: 2025-10-09T14:23:00
  type?: AbsenceRequestDateType;
  time?: string; // Local time: 14:23:00
}

export interface FlipAbsenceDuration {
  amount: number;
  unit: AbsenceDurationUnit;
}

export interface FlipAbsenceRequest {
  id: string; // UUID
  external_id?: string | null;
  absentee: string; // Flip user ID
  approver?: string; // Flip user ID
  supervisor?: string; // Flip user ID
  duration?: FlipAbsenceDuration;
  policy_id: string; // UUID
  created_by: string; // Flip user ID
  requestor_comment?: string | null;
  status: AbsenceRequestStatus;
  created_at: string;
  updated_at: string;
  starts_from: FlipAbsenceRequestDisplayDate;
  ends_at: FlipAbsenceRequestDisplayDate;
  is_cancellable: boolean;
}

export interface FlipAbsenceRequestCreation {
  starts_from: FlipAbsenceRequestDate;
  ends_at: FlipAbsenceRequestDate;
  policy_id: string;
  requestor_comment?: string | null;
  external_id?: string | null;
}

export interface FlipSyncAbsenceRequest {
  id: string | null; // Flip absence request ID (nullable)
  external_id?: string | null; // BreatheHR absence ID
  approver: string | null; // Flip user ID
  absentee: string; // Flip user ID
  duration?: FlipAbsenceDuration;
  policy: FlipPolicyIdentifier;
  requestor_comment: string | null;
  status: AbsenceRequestStatus;
  last_updated: string | null;
  starts_from: FlipAbsenceRequestSyncDate;
  ends_at: FlipAbsenceRequestSyncDate;
}

export interface FlipAbsenceRequestSyncDate {
  date: string; // Local datetime without timezone
  type?: AbsenceRequestDateType;
}

export interface FlipPolicyIdentifier {
  id?: string; // Flip policy ID
  external_id?: string | null; // BreatheHR leave reason ID
}

export interface FlipAbsencePolicySync {
  id?: string; // Flip policy ID (for updates)
  name: string;
  half_days_allowed: boolean;
  time_unit: AbsencePolicyTimeUnit;
  time_units?: AbsencePolicyTimeUnit[];
  external_id?: string | null;
}

export interface FlipAbsencePolicy {
  id: string;
  name: string;
  half_days_allowed: boolean;
  time_unit: AbsencePolicyTimeUnit;
  time_units: AbsencePolicyTimeUnit[];
  external_id?: string | null;
  tenant: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface FlipSyncBalance {
  user_id: string; // Flip user ID
  policy: FlipPolicyIdentifier;
  balance: FlipBalance;
}

export interface FlipBalance {
  id?: string;
  external_id?: string | null;
  total: number;
  available: number;
  taken: number;
  unlimited?: boolean;
  time_unit: BalanceTimeUnit;
}

export interface FlipUser {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  username?: string;
  external_id?: string | null;
  status?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

// ============================================================
// Webhook payloads (Flip → Driver)
// ============================================================

export interface FlipWebhookPayload {
  event_type: string;
  data: Record<string, unknown>;
  timestamp: string;
  tenant_id?: string;
}

export interface AbsenceCreatedWebhookData {
  absence_request_id: string;
  user_id: string;
  policy_id: string;
  starts_from: FlipAbsenceRequestDate;
  ends_at: FlipAbsenceRequestDate;
  requestor_comment?: string | null;
  policy_external_id?: string | null;
}

export interface AbsenceCancelledWebhookData {
  absence_request_id: string;
  user_id: string;
  external_id?: string | null;
}

// ============================================================
// Internal mapping types
// ============================================================

export interface UserMapping {
  flipUserId: string;
  breatheEmployeeId: number;
  breatheRef: string; // The "Ref" / employee_number field
}
