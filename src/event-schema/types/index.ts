export type EventType =
  | "ORDER_CREATED"
  | "ORDER_UPDATED"
  | "ORDER_PAID"
  | "ORDER_CANCELED"
  | "CONFIG_UPDATED"
  | "MENU_UPDATED"
  | "DEVICE_REGISTERED"
  | "SYNC_REQUESTED"
  | "ITEM_SOLD"
  | "STOCK_UPDATED";

export interface NexusEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  type: EventType;
  timestamp: number;
  device_id: string;
  tenant_id: string;
  payload: TPayload;
}
