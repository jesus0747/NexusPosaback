import type { NexusEvent } from "../types/index.js";

export type ConfigUpdatedPayload = Record<string, unknown>;

export type ConfigUpdatedEvent = NexusEvent<ConfigUpdatedPayload> & {
  type: "CONFIG_UPDATED";
};
