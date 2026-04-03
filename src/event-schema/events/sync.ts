import type { NexusEvent } from "../types/index.js";

export type SyncRequestedPayload = Record<string, unknown>;

export type SyncRequestedEvent = NexusEvent<SyncRequestedPayload> & {
  type: "SYNC_REQUESTED";
};
