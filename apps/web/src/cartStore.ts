import { create } from "zustand";
import type { MenuItem } from "@localserve/shared-types";

export type CartSelection = {
  menuItemId: string;
  variantId?: string;
  addonIds: string[]; // stored sorted for deterministic keys
};

export type CartEntry = CartSelection & { quantity: number };

// Deterministic key so identical selections collapse onto one line.
export function cartKey(s: CartSelection): string {
  const parts = [s.menuItemId];
  if (s.variantId) parts.push(`v:${s.variantId}`);
  if (s.addonIds.length) parts.push(`a:${[...s.addonIds].sort().join(",")}`);
  return parts.join("|");
}

export function isPlainItemKey(key: string) {
  return !key.includes("|");
}

type CartState = {
  /** Map of cartKey → entry. Plain items (no selections) use the bare menuItemId as key. */
  entries: Record<string, CartEntry>;
  /** Back-compat shim: { [cartKey]: quantity } so existing direct-add callers still work. */
  quantities: Record<string, number>;
  /** Increment / set quantity by cartKey. Plain items can pass the bare menuItemId. */
  setQuantity: (key: string, quantity: number) => void;
  /** Add a customized selection (variants/addons). Increments if a matching line already exists. */
  addLine: (selection: CartSelection, quantity: number) => void;
  clear: () => void;
};

function syncQuantities(entries: Record<string, CartEntry>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(entries)) out[k] = v.quantity;
  return out;
}

export const useCartStore = create<CartState>((set) => ({
  entries: {},
  quantities: {},
  setQuantity: (key, quantity) =>
    set((state) => {
      const entries = { ...state.entries };
      if (quantity <= 0) {
        delete entries[key];
      } else if (entries[key]) {
        entries[key] = { ...entries[key], quantity };
      } else if (isPlainItemKey(key)) {
        // Plain-item direct add: synthesize a no-selection entry.
        entries[key] = { menuItemId: key, addonIds: [], quantity };
      }
      // Composite keys without a prior entry can't be created here — addLine handles that.
      return { entries, quantities: syncQuantities(entries) };
    }),
  addLine: (selection, quantity) =>
    set((state) => {
      if (quantity <= 0) return state;
      const sorted: CartSelection = {
        menuItemId: selection.menuItemId,
        variantId: selection.variantId,
        addonIds: [...selection.addonIds].sort()
      };
      const key = cartKey(sorted);
      const entries = { ...state.entries };
      const prev = entries[key];
      entries[key] = prev
        ? { ...prev, quantity: prev.quantity + quantity }
        : { ...sorted, quantity };
      return { entries, quantities: syncQuantities(entries) };
    }),
  clear: () => set({ entries: {}, quantities: {} })
}));

export type ResolvedCartLine = {
  key: string;
  item: MenuItem;
  selection: CartSelection;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  variantName?: string;
  addonNames: string[];
};

export function buildCartLines(menuItems: MenuItem[], entries: Record<string, CartEntry>): ResolvedCartLine[] {
  return Object.entries(entries)
    .map(([key, entry]) => {
      const item = menuItems.find((m) => m.id === entry.menuItemId);
      if (!item) return null;
      const variants = item.variants ?? [];
      const addons = item.addons ?? [];
      const variant = entry.variantId ? variants.find((v) => v.id === entry.variantId) : undefined;
      const chosenAddons = entry.addonIds
        .map((id) => addons.find((a) => a.id === id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a));
      const base = variant ? variant.price : item.price;
      const unitPrice = base + chosenAddons.reduce((sum, a) => sum + a.price, 0);
      const line: ResolvedCartLine = {
        key,
        item,
        selection: { menuItemId: entry.menuItemId, variantId: entry.variantId, addonIds: entry.addonIds },
        quantity: entry.quantity,
        unitPrice,
        lineTotal: unitPrice * entry.quantity,
        variantName: variant?.name,
        addonNames: chosenAddons.map((a) => a.name)
      };
      return line;
    })
    .filter((line): line is ResolvedCartLine => line !== null);
}
