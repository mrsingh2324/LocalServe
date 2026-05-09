import { create } from "zustand";
import type { MenuItem } from "@localserve/shared-types";

type CartState = {
  quantities: Record<string, number>;
  setQuantity: (itemId: string, quantity: number) => void;
  clear: () => void;
};

export const useCartStore = create<CartState>((set) => ({
  quantities: {},
  setQuantity: (itemId, quantity) =>
    set((state) => {
      const next = { ...state.quantities };
      if (quantity <= 0) delete next[itemId];
      else next[itemId] = quantity;
      return { quantities: next };
    }),
  clear: () => set({ quantities: {} })
}));

export function buildCartLines(menuItems: MenuItem[], quantities: Record<string, number>) {
  return Object.entries(quantities)
    .map(([menuItemId, quantity]) => {
      const item = menuItems.find((candidate) => candidate.id === menuItemId);
      if (!item) return null;
      return { item, quantity, lineTotal: item.price * quantity };
    })
    .filter(Boolean) as { item: MenuItem; quantity: number; lineTotal: number }[];
}
