import { z } from "zod";

export const orderStatuses = [
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "COLLECTED",
  "CANCELLED"
] as const;

export const shopCategories = [
  "General Store",
  "Food & Snacks",
  "Pharmacy",
  "Bakery",
  "Tea & Coffee",
  "Grocery",
  "Stationery",
  "Electronics",
  "Other"
] as const;

export const addressSchema = z.object({
  id: z.string(),
  label: z.string().max(40),
  line1: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  pincode: z.string().min(4).max(10),
});

export const deliveryAddressSchema = z.object({
  line1: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  pincode: z.string().min(4).max(10),
});

export const customerSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string().email().optional(),
  addresses: z.array(addressSchema).default([]),
  createdAt: z.string(),
});

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
  storefrontUrl: z.string(),
  category: z.string().default("General Store"),
  isOpen: z.boolean().default(true),
  deliveryEnabled: z.boolean().default(false),
  deliveryFeeFlat: z.number().default(0),
  bannerUrl: z.string().optional(),
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
  customerId: z.string().optional(),
  status: z.enum(orderStatuses),
  orderType: z.enum(["pickup", "delivery"]).default("pickup"),
  deliveryAddress: deliveryAddressSchema.optional(),
  deliveryFee: z.number().default(0),
  paymentMethod: z.enum(["online", "cash"]).default("online"),
  items: z.array(orderLineSchema),
  totalAmount: z.number().nonnegative(),
  paymentId: z.string().optional(),
  paymentOrderId: z.string().optional(),
  createdAt: z.string(),
  readyAt: z.string().optional()
});

export type Address = z.infer<typeof addressSchema>;
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type MenuItem = z.infer<typeof menuItemSchema>;
export type Vendor = z.infer<typeof vendorSchema>;
export type PublicVendor = z.infer<typeof publicVendorSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type Order = z.infer<typeof orderSchema>;
export type OrderStatus = (typeof orderStatuses)[number];
export type ShopCategory = (typeof shopCategories)[number];
