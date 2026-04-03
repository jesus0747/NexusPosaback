import type { NexusEvent } from "../types/index.js";

export type OrderCreatedPayload = Record<string, unknown>;
export type OrderUpdatedPayload = Record<string, unknown>;
export type OrderPaidPayload = Record<string, unknown>;
export type OrderCanceledPayload = Record<string, unknown>;

export type OrderCreatedEvent = NexusEvent<OrderCreatedPayload> & {
  type: "ORDER_CREATED";
};

export type OrderUpdatedEvent = NexusEvent<OrderUpdatedPayload> & {
  type: "ORDER_UPDATED";
};

export type OrderPaidEvent = NexusEvent<OrderPaidPayload> & {
  type: "ORDER_PAID";
};

export type OrderCanceledEvent = NexusEvent<OrderCanceledPayload> & {
  type: "ORDER_CANCELED";
};
