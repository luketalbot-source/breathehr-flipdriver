import { BreatheHRClient } from './breathehr';
import { FlipClient } from './flip';
import { UserMapping, BreatheEmployee, FlipUser } from './types';

/**
 * User Mapping Service
 *
 * Maps users between Flip and BreatheHR using:
 *   Flip: custom user attribute "ExtHRRef"
 *   BreatheHR: "Ref" field (employee_number / reference)
 *
 * The mapping is built by iterating BreatheHR employees and looking up
 * the corresponding Flip user via ExtHRRef.
 */
export class UserMappingService {
  private breatheClient: BreatheHRClient;
  private flipClient: FlipClient;

  // In-memory cache (refreshed on each sync)
  private mappingByFlipUserId: Map<string, UserMapping> = new Map();
  private mappingByBreatheId: Map<number, UserMapping> = new Map();
  private mappingByRef: Map<string, UserMapping> = new Map();
  private lastRefresh: number = 0;
  private cacheTtlMs: number = 5 * 60 * 1000; // 5 minutes

  constructor(breatheClient?: BreatheHRClient, flipClient?: FlipClient) {
    this.breatheClient = breatheClient || new BreatheHRClient();
    this.flipClient = flipClient || new FlipClient();
  }

  /**
   * Build the full user mapping by:
   * 1. Fetching all BreatheHR employees
   * 2. For each employee with a "Ref", looking up the Flip user with matching ExtHRRef
   */
  async refreshMappings(): Promise<UserMapping[]> {
    console.log('[UserMapping] Refreshing user mappings...');

    const employees = await this.breatheClient.getAllEmployees();
    console.log(`[UserMapping] Found ${employees.length} BreatheHR employees`);

    const mappings: UserMapping[] = [];

    for (const emp of employees) {
      const ref = this.extractRef(emp);
      if (!ref) {
        console.log(
          `[UserMapping] Skipping employee ${emp.id} (${emp.first_name} ${emp.last_name}) - no ref`
        );
        continue;
      }

      const flipUser = await this.flipClient.findUserByExtHRRef(ref);
      if (!flipUser) {
        console.log(
          `[UserMapping] No Flip user found for ref "${ref}" (employee ${emp.id})`
        );
        continue;
      }

      const mapping: UserMapping = {
        flipUserId: flipUser.id,
        breatheEmployeeId: emp.id,
        breatheRef: ref,
      };

      mappings.push(mapping);
      this.mappingByFlipUserId.set(flipUser.id, mapping);
      this.mappingByBreatheId.set(emp.id, mapping);
      this.mappingByRef.set(ref, mapping);
    }

    this.lastRefresh = Date.now();
    console.log(`[UserMapping] Mapped ${mappings.length} users`);
    return mappings;
  }

  /**
   * Ensure mappings are fresh (refresh if cache has expired)
   */
  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastRefresh > this.cacheTtlMs || this.mappingByRef.size === 0) {
      await this.refreshMappings();
    }
  }

  /**
   * Look up the BreatheHR employee ID for a Flip user
   */
  async getBreatheEmployeeId(flipUserId: string): Promise<number | null> {
    await this.ensureFresh();
    const mapping = this.mappingByFlipUserId.get(flipUserId);
    return mapping?.breatheEmployeeId ?? null;
  }

  /**
   * Look up the Flip user ID for a BreatheHR employee
   */
  async getFlipUserId(breatheEmployeeId: number): Promise<string | null> {
    await this.ensureFresh();
    const mapping = this.mappingByBreatheId.get(breatheEmployeeId);
    return mapping?.flipUserId ?? null;
  }

  /**
   * Look up both IDs from a ref
   */
  async getMappingByRef(ref: string): Promise<UserMapping | null> {
    await this.ensureFresh();
    return this.mappingByRef.get(ref) ?? null;
  }

  /**
   * Get all current mappings
   */
  async getAllMappings(): Promise<UserMapping[]> {
    await this.ensureFresh();
    return Array.from(this.mappingByRef.values());
  }

  /**
   * Extract the reference number from a BreatheHR employee.
   * The field is called "employee_ref" in the BreatheHR API.
   */
  private extractRef(employee: BreatheEmployee): string | null {
    const ref = (employee as Record<string, unknown>).employee_ref as string | undefined;

    if (ref !== undefined && ref !== null && String(ref).trim() !== '') {
      return String(ref).trim();
    }

    return null;
  }
}
