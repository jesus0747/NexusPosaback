import type { NexusEvent } from "../types/index.js";

export interface MenuCategory {
  id: string;
  name: string;
  emoji?: string;
  sort_order: number;
  active?: boolean;
}

export interface MenuModifierOption {
  id: string;
  name: string;
  price: number;
}

export interface MenuModifier {
  id: string;
  item_id?: string | null;
  name: string;
  type: "SINGLE" | "MULTI";
  required: boolean;
  options: MenuModifierOption[];
  sort_order?: number;
}

export interface StructuredMenuItem {
  id: string;
  category_id: string;
  name: string;
  price: number;
  emoji?: string;
  description?: string;
  available?: boolean;
  sort_order?: number;
  modifier_ids?: string[];
}

export interface MenuUpdatedPayload {
  categories: MenuCategory[];
  items: StructuredMenuItem[];
  modifiers: MenuModifier[];
}

export type MenuUpdatedEvent = NexusEvent<MenuUpdatedPayload> & {
  type: "MENU_UPDATED";
};
