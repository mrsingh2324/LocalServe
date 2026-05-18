import { z } from "zod";

export const orderStatuses = [
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "COLLECTED",
  "CANCELLED"
] as const;

export const menuItemSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  name: z.string().max(60),
  description: z.string().max(200),
  price: z.number().nonnegative(),
  photoUrl: z.string().url(),
  category: z.string(),
  isAvailable: z.boolean()
});

export const vendorSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  locationTag: z.string(),
  phone: z.string(),
  upiId: z.string(),
  qrUrl: z.string(),
  storefrontUrl: z.string()
});

export const publicVendorSchema = vendorSchema.omit({
  phone: true,
  upiId: true
});

export const orderLineSchema = z.object({
  menuItemId: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  lineTotal: z.number().nonnegative()
});

export const orderSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  orderCode: z.string(),
  customerEmail: z.string().email(),
  customerPhone: z.string().optional(),
  status: z.enum(orderStatuses),
  items: z.array(orderLineSchema),
  totalAmount: z.number().nonnegative(),
  paymentId: z.string().optional(),
  paymentOrderId: z.string().optional(),
  createdAt: z.string(),
  readyAt: z.string().optional()
});

export type MenuItem = z.infer<typeof menuItemSchema>;
export type Vendor = z.infer<typeof vendorSchema>;
export type PublicVendor = z.infer<typeof publicVendorSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type Order = z.infer<typeof orderSchema>;
export type OrderStatus = (typeof orderStatuses)[number];
