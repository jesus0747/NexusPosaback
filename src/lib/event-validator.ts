// ─── BLOQUE 6: Strict per-event validation ────────────────────────────────────
//
// Goals:
//  1. Reject malformed events BEFORE they touch rate limiters, dedup, or DB.
//  2. Partial acceptance: valid events in a batch proceed even if others fail.
//  3. Clear rejection reasons that the Android app can log and skip on retry.
//
// Rules (immutable):
//  - event_id MUST be a valid UUID v4/v7 (prevents arbitrary string injection)
//  - timestamp MUST be within ±5 min future drift and ≤7 days old
//  - payload MUST be ≤8 KB per event
//  - batch total payload MUST be ≤256 KB
//  - type-specific required payload fields are enforced
//  - device_id in event body MUST match auth.device_id (no relay spoofing)
//    EXCEPTION: SYNC_REQUESTED is always allowed as a relay marker

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_PAYLOAD_BYTES = 8_192;          // 8 KB per event
const MAX_BATCH_PAYLOAD_BYTES = 262_144;  // 256 KB total batch
const MAX_FUTURE_DRIFT_MS = 5 * 60_000;  // 5 minutes ahead
const MAX_AGE_MS = 7 * 24 * 60 * 60_000; // 7 days old

// Type-specific required payload fields
const REQUIRED_PAYLOAD_FIELDS: Partial<Record<string, Array<{ key: string; type: "string" | "number" | "array" | "object" }>>> = {
  ORDER_CREATED:      [{ key: "order_id", type: "string" }, { key: "items", type: "array" }],
  ORDER_PAID:         [{ key: "order_id", type: "string" }, { key: "amount", type: "number" }],
  ORDER_CANCELED:     [{ key: "order_id", type: "string" }],
  ORDER_STATUS_CHANGED: [{ key: "order_id", type: "string" }, { key: "status", type: "string" }],
  PAYMENT_INITIATED:  [{ key: "order_id", type: "string" }, { key: "amount", type: "number" }],
  PAYMENT_SUCCESS:    [{ key: "order_id", type: "string" }, { key: "amount", type: "number" }],
  PAYMENT_FAILED:     [{ key: "order_id", type: "string" }],
  REFUND_CREATED:     [{ key: "order_id", type: "string" }, { key: "amount", type: "number" }],
  MENU_UPDATED:       [{ key: "items", type: "array" }],
  ITEM_SOLD:          [{ key: "item_id", type: "string" }, { key: "quantity", type: "number" }],
  STOCK_UPDATED:      [{ key: "item_id", type: "string" }],
};

export interface RejectedEvent {
  event_id: string;
  index: number;
  errors: string[];
}

export interface BatchValidationResult {
  valid: Array<{
    event_id: string;
    type: string;
    timestamp: number;
    device_id: string;
    tenant_id: string;
    payload: Record<string, unknown>;
  }>;
  rejected: RejectedEvent[];
  batchPayloadBytes: number;
}

function payloadBytes(payload: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    return 0;
  }
}

function checkPayloadField(
  payload: Record<string, unknown>,
  key: string,
  expectedType: "string" | "number" | "array" | "object"
): boolean {
  const val = payload[key];
  if (val === undefined || val === null) return false;
  switch (expectedType) {
    case "string": return typeof val === "string" && val.length > 0;
    case "number": return typeof val === "number" && isFinite(val);
    case "array": return Array.isArray(val);
    case "object": return typeof val === "object" && !Array.isArray(val);
  }
}

export function validateEventBatch(
  events: Array<{
    event_id: string;
    type: string;
    timestamp: number;
    device_id: string;
    tenant_id: string;
    payload: Record<string, unknown>;
  }>,
  authDeviceId: string
): BatchValidationResult {
  const now = Date.now();
  const valid: BatchValidationResult["valid"] = [];
  const rejected: RejectedEvent[] = [];
  let batchPayloadBytes = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const errors: string[] = [];

    // 1. UUID format for event_id
    if (!UUID_RE.test(e.event_id)) {
      errors.push(`event_id must be a valid UUID, got: "${e.event_id.slice(0, 32)}"`);
    }

    // 2. Timestamp range
    const delta = e.timestamp - now;
    if (delta > MAX_FUTURE_DRIFT_MS) {
      errors.push(`timestamp ${e.timestamp} is ${Math.round(delta / 1000)}s in the future (max ±5min drift)`);
    } else if (now - e.timestamp > MAX_AGE_MS) {
      errors.push(`timestamp ${e.timestamp} is older than 7 days — stale event rejected`);
    }

    // 3. Payload size
    const eBytes = payloadBytes(e.payload);
    if (eBytes > MAX_PAYLOAD_BYTES) {
      errors.push(`payload too large: ${eBytes} bytes (max ${MAX_PAYLOAD_BYTES})`);
    }
    batchPayloadBytes += eBytes;

    // 4. device_id must match auth device (relay protection)
    //    SYNC_REQUESTED is exempt — it's a signal-only event that KDS can relay
    if (e.device_id !== authDeviceId && e.type !== "SYNC_REQUESTED") {
      errors.push(`device_id "${e.device_id}" does not match authenticated device "${authDeviceId}"`);
    }

    // 5. Type-specific required payload fields
    const required = REQUIRED_PAYLOAD_FIELDS[e.type];
    if (required) {
      for (const { key, type } of required) {
        if (!checkPayloadField(e.payload, key, type)) {
          errors.push(`${e.type} requires payload.${key} (${type})`);
        }
      }
    }

    if (errors.length > 0) {
      rejected.push({ event_id: e.event_id, index: i, errors });
    } else {
      valid.push(e);
    }
  }

  // 6. Batch-level size check — if total exceeds limit, reject the rest
  if (batchPayloadBytes > MAX_BATCH_PAYLOAD_BYTES) {
    // Mark valid events past the threshold as rejected
    let running = 0;
    const stillValid: BatchValidationResult["valid"] = [];
    for (const e of valid) {
      const eBytes = payloadBytes(e.payload);
      if (running + eBytes > MAX_BATCH_PAYLOAD_BYTES) {
        rejected.push({
          event_id: e.event_id,
          index: events.findIndex((ev) => ev.event_id === e.event_id),
          errors: [`batch payload limit exceeded (${MAX_BATCH_PAYLOAD_BYTES} bytes total) — split into smaller batches`],
        });
      } else {
        running += eBytes;
        stillValid.push(e);
      }
    }
    return { valid: stillValid, rejected, batchPayloadBytes };
  }

  return { valid, rejected, batchPayloadBytes };
}
