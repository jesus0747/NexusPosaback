// ─── BLOQUE 5: Per-tenant plan limits and usage tracking ─────────────────────
//
// Plan tiers control:
//   - Max registered devices per tenant
//   - Max events per day (soft limit, in-memory + DB count)
//   - Max events per month (for billing awareness)
//
// Rule: limits are enforced on PUSH — not on read.
// Rule: in-memory daily counter resets at UTC midnight automatically.
// Rule: on server restart, daily counter starts at 0 (soft limit — DB is source of truth).

export interface PlanLimits {
  maxDevices: number;
  maxEventsPerDay: number;
  maxEventsPerMonth: number;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  basic:      { maxDevices: 1,   maxEventsPerDay: 1_000,      maxEventsPerMonth: 20_000 },
  pro:        { maxDevices: 5,   maxEventsPerDay: 10_000,     maxEventsPerMonth: 200_000 },
  enterprise: { maxDevices: 100, maxEventsPerDay: 10_000_000, maxEventsPerMonth: 10_000_000 },
  // Legacy alias — starter rows in DB map to basic limits
  starter:    { maxDevices: 1,   maxEventsPerDay: 1_000,      maxEventsPerMonth: 20_000 },
};

// Default to basic limits for unknown plans (safe default = least privilege)
export function getLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS["basic"]!;
}

// ─── In-memory daily usage tracker ───────────────────────────────────────────

interface TenantUsage {
  tenantId: string;
  plan: string;
  eventsToday: number;
  dayStart: number; // UTC day start in ms
}

const usageMap = new Map<string, TenantUsage>();

function utcDayStart(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function getOrCreateUsage(tenantId: string, plan: string): TenantUsage {
  const dayStart = utcDayStart();
  const existing = usageMap.get(tenantId);
  // Reset counter if we've crossed into a new UTC day
  if (!existing || existing.dayStart !== dayStart) {
    const fresh: TenantUsage = { tenantId, plan, eventsToday: 0, dayStart };
    usageMap.set(tenantId, fresh);
    return fresh;
  }
  existing.plan = plan; // keep plan in sync
  return existing;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function checkTenantEventLimit(
  tenantId: string,
  plan: string,
  incomingCount: number
): { allowed: boolean; reason?: string; limit: number; used: number; remaining: number } {
  const limits = getLimits(plan);
  const usage = getOrCreateUsage(tenantId, plan);
  const projected = usage.eventsToday + incomingCount;

  if (projected > limits.maxEventsPerDay) {
    return {
      allowed: false,
      reason: `Daily event limit exceeded — ${plan} plan allows ${limits.maxEventsPerDay.toLocaleString()} events/day`,
      limit: limits.maxEventsPerDay,
      used: usage.eventsToday,
      remaining: Math.max(0, limits.maxEventsPerDay - usage.eventsToday),
    };
  }

  return {
    allowed: true,
    limit: limits.maxEventsPerDay,
    used: usage.eventsToday,
    remaining: limits.maxEventsPerDay - usage.eventsToday,
  };
}

export function recordTenantEvents(tenantId: string, plan: string, count: number): void {
  const usage = getOrCreateUsage(tenantId, plan);
  usage.eventsToday += count;
}

export function checkDeviceLimit(
  currentDeviceCount: number,
  plan: string,
  existingDeviceId?: string
): { allowed: boolean; reason?: string; limit: number } {
  const limits = getLimits(plan);
  // If device already registered, always allow (no double-counting)
  if (existingDeviceId) return { allowed: true, limit: limits.maxDevices };
  if (currentDeviceCount >= limits.maxDevices) {
    return {
      allowed: false,
      reason: `Device limit reached — ${plan} plan allows ${limits.maxDevices} device(s)`,
      limit: limits.maxDevices,
    };
  }
  return { allowed: true, limit: limits.maxDevices };
}

export function getTenantUsage(tenantId: string): TenantUsage | null {
  return usageMap.get(tenantId) ?? null;
}

export function getAllTenantUsage(): TenantUsage[] {
  const dayStart = utcDayStart();
  return [...usageMap.values()].filter((u) => u.dayStart === dayStart);
}

export function getTenantLimitSummary(tenantId: string, plan: string) {
  const limits = getLimits(plan);
  const usage = getOrCreateUsage(tenantId, plan);
  return {
    plan,
    limits,
    usage: {
      eventsToday: usage.eventsToday,
      dayStart: usage.dayStart,
    },
    remaining: {
      eventsPerDay: Math.max(0, limits.maxEventsPerDay - usage.eventsToday),
    },
  };
}
