import type { NexusEvent } from "../types/index.js";

export interface SoldItem {
  item_id: string;
  name: string;
  qty: number;
  unit_price: number;
  modifiers?: Array<{ modifier_id: string; option_id: string; name: string; price: number }>;
}

export interface ItemSoldPayload {
  order_id: string;
  table_number?: string;
  items: SoldItem[];
  total: number;
}

export type ItemSoldEvent = NexusEvent<ItemSoldPayload> & {
  type: "ITEM_SOLD";
};

export interface StockUpdatedPayload {
  item_id: string;
  qty_delta: number;
  new_qty: number;
  reason: "MANUAL_ADJUSTMENT" | "RESTOCK" | "SPOILAGE" | "CORRECTION";
  note?: string;
}

export type StockUpdatedEvent = NexusEvent<StockUpdatedPayload> & {
  type: "STOCK_UPDATED";
};
