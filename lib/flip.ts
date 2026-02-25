import { getConfig } from './config';
import {
  FlipUser,
  FlipAbsencePolicy,
  FlipAbsencePolicySync,
  FlipSyncBalance,
  FlipSyncAbsenceRequest,
  FlipAbsenceRequest,
} from './types';

/**
 * Flip API Client
 *
 * Auth: OAuth2 Client Credentials → JWT Bearer token
 * Token URL: https://{domain}/auth/realms/{org}/protocol/openid-connect/token
 * Base URL: configured per tenant
 */
export class FlipClient {
  private clientId: string;
  private clientSecret: string;
  private baseUrl: string;
  private organization: string;

  // Token cache
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    const config = getConfig();
    this.clientId = config.flip.clientId;
    this.clientSecret = config.flip.clientSecret;
    this.baseUrl = config.flip.baseUrl;
    this.organization = config.flip.organization;
  }

  // ============================================================
  // OAuth2 Token Management
  // ============================================================

  /**
   * Get a valid access token, refreshing if needed.
   * Uses OAuth2 client_credentials grant.
   */
  async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 30s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30000) {
      return this.accessToken;
    }

    const tokenUrl = `${this.baseUrl}/auth/realms/${this.organization}/protocol/openid-connect/token`;

    console.log(`[Flip Auth] Requesting token from ${tokenUrl}`);

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Flip Auth] Token request failed ${response.status}: ${errorBody}`);
      throw new Error(
        `Flip OAuth2 token request failed: ${response.status} ${response.statusText} - ${errorBody}`
      );
    }

    const tokenData = await response.json() as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };

    this.accessToken = tokenData.access_token;
    this.tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;

    console.log(
      `[Flip Auth] Token acquired, expires in ${tokenData.expires_in}s`
    );

    return this.accessToken;
  }

  // ============================================================
  // HTTP Request Helper
  // ============================================================

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string>
  ): Promise<T> {
    const token = await this.getAccessToken();

    let url = `${this.baseUrl}${path}`;

    if (queryParams) {
      const params = new URLSearchParams(queryParams);
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    };

    const options: Record<string, unknown> = { method, headers };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    console.log(`[Flip] ${method} ${url}`);
    if (body) {
      console.log(`[Flip] Request body: ${JSON.stringify(body, null, 2)}`);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Flip] Error ${response.status}: ${errorBody}`);
      throw new Error(
        `Flip API error: ${response.status} ${response.statusText} - ${errorBody}`
      );
    }

    // Handle 200/201 with no content
    const contentType = response.headers.get('content-type');
    console.log(`[Flip] Response ${response.status}, content-type: ${contentType}`);

    if (!contentType || !contentType.includes('application/json')) {
      return {} as T;
    }

    const text = await response.text();
    console.log(`[Flip] Response body: ${text.substring(0, 1000)}`);
    if (!text || text.trim() === '') {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  // ============================================================
  // Users
  // ============================================================

  /**
   * Search users - can filter by custom attribute ExtHRRef
   */
  async searchUsers(params?: {
    searchTerm?: string;
    attributeName?: string;
    attributeValue?: string;
    externalId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ users: FlipUser[]; pagination: Record<string, unknown> }> {
    const queryParams: Record<string, string> = {};

    if (params?.searchTerm) queryParams.search_term = params.searchTerm;
    if (params?.attributeName) queryParams.attribute_technical_name = params.attributeName;
    if (params?.attributeValue) queryParams.attribute_value = params.attributeValue;
    if (params?.externalId) queryParams.external_id = params.externalId;
    if (params?.page) queryParams.page_number = params.page.toString();
    if (params?.limit) queryParams.page_limit = (params.limit || 100).toString();

    return this.request('GET', '/api/admin/users/v4/users', undefined, queryParams);
  }

  /**
   * Get a single user by ID
   */
  async getUser(userId: string): Promise<FlipUser> {
    return this.request('GET', `/api/admin/users/v4/users/${userId}`);
  }

  /**
   * Find a Flip user by their ExtHRRef custom attribute
   * This is the key lookup for user mapping
   */
  async findUserByExtHRRef(extHRRef: string): Promise<FlipUser | null> {
    try {
      const result = await this.searchUsers({
        attributeName: 'exthrref',
        attributeValue: extHRRef,
        limit: 1,
      });

      if (result.users && result.users.length > 0) {
        return result.users[0];
      }
      return null;
    } catch (error) {
      console.error(`[Flip] Error finding user by ExtHRRef "${extHRRef}":`, error);
      return null;
    }
  }

  /**
   * Get all users (auto-paginate)
   */
  async getAllUsers(): Promise<FlipUser[]> {
    const allUsers: FlipUser[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await this.searchUsers({ page, limit: 100 });
      const users = result.users || [];
      allUsers.push(...users);
      hasMore = users.length === 100;
      page++;
    }

    return allUsers;
  }

  // ============================================================
  // Absence Policies (Integration)
  // ============================================================

  /**
   * Sync an absence policy to Flip
   */
  async syncAbsencePolicy(
    policy: FlipAbsencePolicySync
  ): Promise<FlipAbsencePolicy> {
    return this.request('POST', '/api/hr/v4/integration/absence-policies', policy);
  }

  /**
   * Get absence policies (optionally filtered by external_id)
   */
  async getAbsencePolicies(
    externalId?: string
  ): Promise<{ items: FlipAbsencePolicy[] }> {
    const params: Record<string, string> = {};
    if (externalId) params.external_id = externalId;
    return this.request('GET', '/api/hr/v4/integration/absence-policies', undefined, params);
  }

  /**
   * Assign absence policy to users
   */
  async assignPolicyToUsers(
    policyId: string,
    userIds: string[]
  ): Promise<void> {
    await this.request(
      'POST',
      `/api/hr/v4/integration/absence-policies/${policyId}/assignments`,
      { user_ids: userIds }
    );
  }

  // ============================================================
  // Balances (Integration)
  // ============================================================

  /**
   * Sync balances to Flip (batch)
   */
  async syncBalances(balances: FlipSyncBalance[]): Promise<unknown> {
    return this.request('POST', '/api/hr/v4/integration/balances/sync', {
      items: balances,
    });
  }

  /**
   * Get balances (optionally filtered by policy and/or user)
   */
  async getBalances(params?: {
    policyId?: string;
    userId?: string;
  }): Promise<{ items: Array<{ user_id: string; policy_id: string; balance: Record<string, unknown> }> }> {
    const queryParams: Record<string, string> = {};
    if (params?.policyId) queryParams.policy_id = params.policyId;
    if (params?.userId) queryParams.user_id = params.userId;
    return this.request('GET', '/api/hr/v4/integration/balances', undefined, queryParams);
  }

  // ============================================================
  // Absence Requests (Integration)
  // ============================================================

  /**
   * Approve an absence request
   */
  async approveAbsenceRequest(
    approverId: string,
    identifier: { absence_request_id?: string; external_id?: string }
  ): Promise<void> {
    await this.request('POST', '/api/hr/v4/integration/absence-requests/approve', {
      approver: approverId,
      identifier,
    });
  }

  /**
   * Reject an absence request
   */
  async rejectAbsenceRequest(
    approverId: string,
    identifier: { absence_request_id?: string; external_id?: string }
  ): Promise<void> {
    await this.request('POST', '/api/hr/v4/integration/absence-requests/reject', {
      approver: approverId,
      identifier,
    });
  }

  /**
   * Set absence request to error status
   */
  async setAbsenceRequestError(
    identifier: { absence_request_id?: string; external_id?: string },
    supervisorId?: string
  ): Promise<FlipAbsenceRequest> {
    return this.request('POST', '/api/hr/v4/integration/absence-requests/error', {
      ...(supervisorId && { supervisor: supervisorId }),
      identifier,
    });
  }

  /**
   * Patch an absence request with an external ID
   */
  async patchAbsenceRequestExternalId(
    absenceRequestId: string,
    externalId: string
  ): Promise<void> {
    await this.request(
      'POST',
      `/api/hr/v4/integration/absence-requests/${absenceRequestId}/patch-external-id`,
      { external_id: externalId }
    );
  }

  /**
   * Get an absence request by external ID
   */
  async getAbsenceRequestByExternalId(
    externalId: string
  ): Promise<FlipAbsenceRequest> {
    return this.request(
      'GET',
      '/api/hr/v4/integration/absence-requests',
      undefined,
      { external_id: externalId }
    );
  }

  // ============================================================
  // Absence Request Sync (full sync lifecycle)
  // ============================================================

  /**
   * Start an absence request sync
   */
  async startAbsenceRequestSync(
    userId?: string
  ): Promise<{ sync_id: string; created_at: string }> {
    const body = userId ? { user_id: userId } : {};
    return this.request('POST', '/api/hr/v4/integration/absence-requests/sync/start', body);
  }

  /**
   * Push absence request items to an active sync
   */
  async syncAbsenceRequests(
    syncId: string,
    items: FlipSyncAbsenceRequest[]
  ): Promise<void> {
    await this.request(
      'POST',
      `/api/hr/v4/integration/absence-requests/sync/${syncId}`,
      { items }
    );
  }

  /**
   * Complete an absence request sync
   */
  async completeAbsenceRequestSync(syncId: string): Promise<void> {
    await this.request(
      'POST',
      `/api/hr/v4/integration/absence-requests/sync/${syncId}/complete`
    );
  }

  /**
   * Cancel an absence request sync
   */
  async cancelAbsenceRequestSync(syncId: string): Promise<void> {
    await this.request(
      'POST',
      `/api/hr/v4/integration/absence-requests/sync/${syncId}/cancel`
    );
  }

  /**
   * Get sync status
   */
  async getAbsenceRequestSyncStatus(
    syncId: string
  ): Promise<{ status: string; message?: string }> {
    return this.request(
      'GET',
      `/api/hr/v4/integration/absence-requests/sync/${syncId}`
    );
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Test connectivity to Flip API
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.searchUsers({ limit: 1 });
      return true;
    } catch {
      return false;
    }
  }
}
