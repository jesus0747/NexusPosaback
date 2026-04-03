import type { NexusEvent } from "../types/index.js";

export type DeviceRegisteredPayload = Record<string, unknown>;

export type DeviceRegisteredEvent = NexusEvent<DeviceRegisteredPayload> & {
  type: "DEVICE_REGISTERED";
};
