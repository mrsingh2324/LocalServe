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
  phone: z.string().optional(),
  email: z.string().email().optional(),
  addresses: z.array(addressSchema).default([]),
  favoriteVendorIds: z.array(z.string()).default([]),
  createdAt: z.string(),
});

export const menuVariantSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(30),
  price: z.number().nonnegative()
});

export const menuAddonSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(30),
  price: z.number().nonnegative()
});

export const menuItemSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  name: z.string().max(60),
  description: z.string().max(200),
  price: z.number().nonnegative(),
  photoUrl: z.string().url(),
  category: z.string(),
  isAvailable: z.boolean(),
  stockQuantity: z.number().int().nonnegative().optional(),
  variants: z.array(menuVariantSchema).default([]),
  addons: z.array(menuAddonSchema).default([])
});

export const dayHoursSchema = z.object({
  closed: z.boolean(),
  open: z.string(),
  close: z.string()
});

export const kycStatuses = ["UNSUBMITTED", "PENDING", "VERIFIED", "REJECTED"] as const;

export const kycSchema = z.object({
  ownerName: z.string(),
  gstin: z.string().optional(),
  status: z.enum(kycStatuses),
  rejectionReason: z.string().optional(),
  submittedAt: z.string().optional(),
  reviewedAt: z.string().optional()
});

export const vendorSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  locationTag: z.string(),
  phone: z.string(),
  email: z.string().email().optional(),
  upiId: z.string(),
  qrUrl: z.string(),
  storefrontUrl: z.string(),
  category: z.string().default("General Store"),
  isOpen: z.boolean().default(true),
  deliveryEnabled: z.boolean().default(false),
  deliveryFeeFlat: z.number().default(0),
  cashEnabled: z.boolean().default(true),
  bannerUrl: z.string().optional(),
  operatingHours: z.array(dayHoursSchema).length(7).optional(),
  acceptWindowMinutes: z.number().int().positive().optional(),
  ratingSum: z.number().default(0),
  ratingCount: z.number().int().default(0),
  kyc: kycSchema.optional(),
});

export const publicVendorSchema = vendorSchema.omit({
  phone: true,
  email: true,
  upiId: true
});

export const orderLineSchema = z.object({
  menuItemId: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  lineTotal: z.number().nonnegative(),
  variantId: z.string().optional(),
  variantName: z.string().optional(),
  addonIds: z.array(z.string()).optional(),
  addonNames: z.array(z.string()).optional()
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
  readyAt: z.string().optional(),
  scheduledFor: z.string().optional(),
  rating: z.number().int().min(1).max(5).optional()
});

export type Address = z.infer<typeof addressSchema>;
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;
export type DayHours = z.infer<typeof dayHoursSchema>;
export type Kyc = z.infer<typeof kycSchema>;
export type KycStatus = (typeof kycStatuses)[number];
export type Customer = z.infer<typeof customerSchema>;
export type MenuVariant = z.infer<typeof menuVariantSchema>;
export type MenuAddon = z.infer<typeof menuAddonSchema>;
export type MenuItem = z.infer<typeof menuItemSchema>;
export type Vendor = z.infer<typeof vendorSchema>;
export type PublicVendor = z.infer<typeof publicVendorSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type Order = z.infer<typeof orderSchema>;
export type OrderStatus = (typeof orderStatuses)[number];
export type ShopCategory = (typeof shopCategories)[number];
