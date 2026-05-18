import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import nodemailer from "nodemailer";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import jwt from "jsonwebtoken";
import morgan from "morgan";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import Razorpay from "razorpay";
import { Redis } from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Server } from "socket.io";
import twilio from "twilio";
import webpush from "web-push";
import { z, ZodError } from "zod";
import {
  CustomerModel,
  MenuItemModel,
  NotificationModel,
  OrderModel,
  PushSubscriptionModel,
  VendorModel,
  connectMongo
} from "./models.js";
import type { Address, Customer, DayHours, DeliveryAddress, Kyc, MenuItem, Order, OrderLine, OrderStatus, Vendor } from "@localserve/shared-types";

type StoredVendor = Vendor & { passwordHash: string };
type StoredCustomer = Customer & { passwordHash?: string };
type StoredPushSubscription = {
  id: string;
  orderId?: string;
  customerId?: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
};
type NotificationRecord = {
  id: string;
  vendorId: string;
  orderId: string;
  channel: "email" | "sms";
  recipient: string;
  subject: string;
  body: string;
  status: "QUEUED" | "SENT" | "FAILED";
  attempts: number;
  createdAt: string;
  deliveredAt?: string;
};
type StoredState = {
  vendors: StoredVendor[];
  vendor?: Vendor;
  menuItems: MenuItem[];
  orders: Order[];
  notifications?: NotificationRecord[];
  customers?: StoredCustomer[];
  pushSubscriptions?: StoredPushSubscription[];
};

const port = Number(process.env.PORT ?? 4000);
const publicAppUrl = process.env.PUBLIC_APP_URL ?? "http://localhost:5173";
const corsOrigin = process.env.CORS_ORIGIN ?? "*";
const vendorToken = process.env.DEV_VENDOR_TOKEN ?? "dev-vendor-token";
const jwtSecret = process.env.JWT_SECRET ?? "localserve-dev-secret-change-me";
const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "localserve-dev-webhook-secret";
const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
const platformFeePercent = Number(process.env.PLATFORM_FEE_PERCENT ?? 2);
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioFromPhone = process.env.TWILIO_FROM_PHONE;
const emailFrom = process.env.EMAIL_FROM ?? "orders@localserve.local";
const smtpHost = process.env.SMTP_HOST;
const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
// Honour an explicit SMTP_SECURE flag; otherwise derive it from the port
// (465 = implicit TLS, 587/25 = STARTTLS). This avoids a common misconfig
// where port 465 is used without SMTP_SECURE set, causing the TLS handshake
// to fail and every email send to throw.
const smtpSecure = process.env.SMTP_SECURE !== undefined
  ? process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === "1"
  : smtpPort === 465;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const redisUrl = process.env.REDIS_URL;
const storageBucket = process.env.STORAGE_BUCKET;
const storageEndpoint = process.env.STORAGE_ENDPOINT;
const storageRegion = process.env.STORAGE_REGION ?? "auto";
const storageAccessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
const storageSecretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
const storagePublicBaseUrl = process.env.STORAGE_PUBLIC_BASE_URL;
const otpDevCode = process.env.OTP_DEV_CODE ?? "123456";
const otpTtlMs = Number(process.env.OTP_TTL_MINUTES ?? 5) * 60 * 1000;
const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@localserve.local").toLowerCase();
const adminConfigured = process.env.NODE_ENV !== "production" || Boolean(process.env.ADMIN_PASSWORD);
const adminPasswordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD ?? "admin123", 10);
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT ?? "mailto:orders@localserve.local";
const pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);
if (pushEnabled) webpush.setVapidDetails(vapidSubject, vapidPublicKey as string, vapidPrivateKey as string);
const dataFile = path.resolve(process.cwd(), "data/localserve.json");
const useMongo = process.env.NODE_ENV !== "test" && (process.env.USE_MONGO === "true" || process.env.USE_MONGO === "1");
const mongoUri = process.env.MONGODB_URI ?? "mongodb://localserve:localserve@localhost:27017/localserve?authSource=admin";
const razorpayClient = razorpayKeyId && razorpayKeySecret ? new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret }) : undefined;
const twilioClient = twilioAccountSid && twilioAuthToken && twilioFromPhone ? twilio(twilioAccountSid, twilioAuthToken) : undefined;
const redisClient = redisUrl && process.env.NODE_ENV !== "test" ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 }) : undefined;
const redisPubClient = redisClient;
const redisSubClient = redisClient ? redisClient.duplicate() : undefined;
const s3Client = storageBucket && storageAccessKeyId && storageSecretAccessKey
  ? new S3Client({
      region: storageRegion,
      endpoint: storageEndpoint,
      forcePathStyle: Boolean(storageEndpoint && !storageEndpoint.includes("amazonaws.com")),
      credentials: { accessKeyId: storageAccessKeyId, secretAccessKey: storageSecretAccessKey }
    })
  : undefined;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  }
});

const mailTransporter = smtpHost && smtpPort
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000
    })
  : undefined;

function requireEnv(name: string, value: string | undefined) {
  if (!value) throw new Error(`Missing required production env var: ${name}`);
}

function validateRuntimeConfig() {
  if (process.env.NODE_ENV !== "production") return;
  requireEnv("CORS_ORIGIN", process.env.CORS_ORIGIN);
  requireEnv("RAZORPAY_KEY_ID", razorpayKeyId);
  requireEnv("RAZORPAY_KEY_SECRET", razorpayKeySecret);
  requireEnv("RAZORPAY_WEBHOOK_SECRET", process.env.RAZORPAY_WEBHOOK_SECRET);
  requireEnv("TWILIO_ACCOUNT_SID", twilioAccountSid);
  requireEnv("TWILIO_AUTH_TOKEN", twilioAuthToken);
  requireEnv("TWILIO_FROM_PHONE", twilioFromPhone);
  requireEnv("SMTP_HOST", smtpHost);
  requireEnv("SMTP_PORT", process.env.SMTP_PORT);
  requireEnv("SMTP_USER", smtpUser);
  requireEnv("SMTP_PASS", smtpPass);
  requireEnv("EMAIL_FROM", process.env.EMAIL_FROM);
  requireEnv("REDIS_URL", redisUrl);
  requireEnv("STORAGE_BUCKET", storageBucket);
  requireEnv("STORAGE_ACCESS_KEY_ID", storageAccessKeyId);
  requireEnv("STORAGE_SECRET_ACCESS_KEY", storageSecretAccessKey);
  if (!adminConfigured) {
    console.warn("ADMIN_PASSWORD is not set — the admin console is disabled. Set ADMIN_PASSWORD to enable it.");
  }
}

const demoPasswordHash = bcrypt.hashSync("demo123", 10);

let vendors: StoredVendor[] = [
  {
    id: "vendor_ravi",
    name: "Ravi's Canteen",
    slug: "ravi-canteen",
    locationTag: "Office Block B, Ground Floor",
    phone: "+919876543210",
    upiId: "ravi@upi",
    qrUrl: "",
    storefrontUrl: `${publicAppUrl}/v/ravi-canteen`,
    passwordHash: demoPasswordHash,
    category: "Food & Snacks",
    isOpen: true,
    deliveryEnabled: false,
    deliveryFeeFlat: 0
  },
  {
    id: "vendor_meera",
    name: "Meera Tea Point",
    slug: "meera-tea-point",
    locationTag: "Tower A Lobby",
    phone: "+919812345670",
    upiId: "meera@upi",
    qrUrl: "",
    storefrontUrl: `${publicAppUrl}/v/meera-tea-point`,
    passwordHash: demoPasswordHash,
    category: "Tea & Coffee",
    isOpen: true,
    deliveryEnabled: true,
    deliveryFeeFlat: 20
  }
];

let menuItems: MenuItem[] = [
  {
    id: "mi_veg_sandwich",
    vendorId: "vendor_ravi",
    name: "Veg Sandwich",
    description: "Grilled vegetables, chutney, and soft bread.",
    price: 45,
    photoUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=800&q=80",
    category: "Snacks",
    isAvailable: true
  },
  {
    id: "mi_paneer_roll",
    vendorId: "vendor_ravi",
    name: "Paneer Roll",
    description: "Spiced paneer wrapped in a warm paratha.",
    price: 60,
    photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80",
    category: "Rolls",
    isAvailable: true
  },
  {
    id: "mi_chai",
    vendorId: "vendor_meera",
    name: "Masala Chai",
    description: "Fresh ginger-cardamom tea served hot.",
    price: 20,
    photoUrl: "https://images.unsplash.com/photo-1561336526-2914f13ceb36?auto=format&fit=crop&w=800&q=80",
    category: "Tea",
    isAvailable: true
  },
  {
    id: "mi_samosa",
    vendorId: "vendor_meera",
    name: "Samosa",
    description: "Crisp potato samosa with green chutney.",
    price: 25,
    photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80",
    category: "Snacks",
    isAvailable: true
  }
];

let customers: StoredCustomer[] = [];
let pushSubscriptions: StoredPushSubscription[] = [];
const orders = new Map<string, Order>();
const notifications = new Map<string, NotificationRecord>();
const otpChallenges = new Map<string, { codeHash: string; expiresAt: number; attempts: number }>();

const app = express();
const server = http.createServer(app);
const corsAllowList = corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean);
const allowAllCorsOrigins = corsAllowList.includes("*");
const corsOriginPatterns = corsAllowList
  .filter((origin) => origin.includes("*") && origin !== "*")
  .map((origin) => new RegExp(`^${origin.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (allowAllCorsOrigins || !origin || corsAllowList.includes(origin) || corsOriginPatterns.some((pattern) => pattern.test(origin))) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS origin denied"));
  }
};
const io = new Server(server, {
  cors: corsOptions
});

// ── Schemas ──────────────────────────────────────────────────────────────────

const createOrderBodySchema = z.object({
  vendorSlug: z.string(),
  customerEmail: z.string().email(),
  customerPhone: z.string().optional(),
  customerId: z.string().optional(),
  orderType: z.enum(["pickup", "delivery"]).default("pickup"),
  deliveryAddress: z.object({
    line1: z.string().min(1).max(200),
    city: z.string().min(1).max(100),
    pincode: z.string().min(4).max(10)
  }).optional(),
  paymentMethod: z.enum(["online", "cash"]).default("online"),
  items: z.array(z.object({ menuItemId: z.string(), quantity: z.number().int().positive() })).min(1)
});
const menuItemBodySchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  price: z.number().nonnegative(),
  photoUrl: z.string().url(),
  category: z.string().min(1),
  isAvailable: z.boolean().default(true),
  stockQuantity: z.number().int().nonnegative().optional()
});
const dayHoursBodySchema = z.object({
  closed: z.boolean(),
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/)
});
const vendorRegistrationSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(10).max(15),
  email: z.string().email().optional().or(z.literal("")),
  locationTag: z.string().min(2).max(120),
  upiId: z.string().min(3).max(80),
  otpCode: z.string().min(4).max(8),
  password: z.string().min(6).default("demo123")
});
const vendorProfileSchema = z.object({
  name: z.string().min(2).max(120),
  locationTag: z.string().min(2).max(120),
  upiId: z.string().min(3).max(80),
  email: z.string().email().optional().or(z.literal("")),
  category: z.string().min(1).max(60).optional(),
  isOpen: z.boolean().optional(),
  deliveryEnabled: z.boolean().optional(),
  deliveryFeeFlat: z.number().nonnegative().optional(),
  bannerUrl: z.string().url().optional().or(z.literal("")),
  operatingHours: z.array(dayHoursBodySchema).length(7).optional(),
  acceptWindowMinutes: z.number().int().min(1).max(240).optional()
});
const loginSchema = z.object({
  phone: z.string().min(10),
  password: z.string().min(6)
});
const otpRequestSchema = z.object({
  phone: z.string().min(10).max(15),
  purpose: z.enum(["login", "register"]).default("login")
});
const otpVerifySchema = z.object({
  phone: z.string().min(10).max(15),
  otpCode: z.string().min(4).max(8)
});
const emailOtpRequestSchema = z.object({
  email: z.string().email()
});
const emailOtpVerifySchema = z.object({
  email: z.string().email(),
  otpCode: z.string().min(4).max(8),
  name: z.string().min(1).max(120).optional()
});
const customerOtpRequestSchema = z.object({
  phone: z.string().min(10).max(15)
});
const customerOtpVerifySchema = z.object({
  phone: z.string().min(10).max(15),
  otpCode: z.string().min(4).max(8),
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional()
});
const customerProfileSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional().or(z.literal(""))
});
const customerAddressSchema = z.object({
  label: z.string().min(1).max(40),
  line1: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  pincode: z.string().min(4).max(10)
});
const paymentConfirmationSchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string()
});
const kycSubmitSchema = z.object({
  ownerName: z.string().min(2).max(120),
  gstin: z.string().max(20).optional().or(z.literal(""))
});
const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});
const vendorVerifySchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  rejectionReason: z.string().max(300).optional()
});
const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string(), auth: z.string() })
  }),
  orderId: z.string().optional(),
  customerId: z.string().optional()
});
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === "test" ? 1000 : 8, standardHeaders: true, legacyHeaders: false });

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buffer;
    }
  })
);
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));

function asyncHandler(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/['']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function uniqueSlug(value: string) {
  const base = slugify(value) || `vendor-${crypto.randomBytes(3).toString("hex")}`;
  let candidate = base;
  let suffix = 2;
  while (vendors.some((vendor) => vendor.slug === candidate)) {
    candidate = `${base.slice(0, 54)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createVendorToken(vendorId: string) {
  return jwt.sign({ vendorId, role: "vendor" }, jwtSecret, { expiresIn: "7d" });
}

function createCustomerToken(customerId: string) {
  return jwt.sign({ customerId, role: "customer" }, jwtSecret, { expiresIn: "30d" });
}

function createAdminToken() {
  return jwt.sign({ role: "admin" }, jwtSecret, { expiresIn: "1d" });
}

function getVendorBySlug(slug: string) {
  return vendors.find((candidate) => candidate.slug === slug);
}

function getVendorById(id: string) {
  return vendors.find((candidate) => candidate.id === id);
}

function getCustomerById(id: string) {
  return customers.find((c) => c.id === id);
}

function ensureDemoSeeds() {
  const requiredVendors = [
    { id: "vendor_ravi", name: "Ravi's Canteen", slug: "ravi-canteen", locationTag: "Office Block B, Ground Floor", phone: "+919876543210", upiId: "ravi@upi", category: "Food & Snacks", isOpen: true, deliveryEnabled: false, deliveryFeeFlat: 0 },
    { id: "vendor_meera", name: "Meera Tea Point", slug: "meera-tea-point", locationTag: "Tower A Lobby", phone: "+919812345670", upiId: "meera@upi", category: "Tea & Coffee", isOpen: true, deliveryEnabled: true, deliveryFeeFlat: 20 }
  ];
  for (const seed of requiredVendors) {
    if (!vendors.some((vendor) => vendor.id === seed.id || vendor.phone === seed.phone)) {
      vendors.push({ ...seed, qrUrl: "", storefrontUrl: `${publicAppUrl}/v/${seed.slug}`, passwordHash: demoPasswordHash });
    }
  }

  const requiredItems: MenuItem[] = [
    { id: "mi_veg_sandwich", vendorId: "vendor_ravi", name: "Veg Sandwich", description: "Grilled vegetables, chutney, and soft bread.", price: 45, photoUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=800&q=80", category: "Snacks", isAvailable: true },
    { id: "mi_paneer_roll", vendorId: "vendor_ravi", name: "Paneer Roll", description: "Spiced paneer wrapped in a warm paratha.", price: 60, photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80", category: "Rolls", isAvailable: true },
    { id: "mi_chai", vendorId: "vendor_meera", name: "Masala Chai", description: "Fresh ginger-cardamom tea served hot.", price: 20, photoUrl: "https://images.unsplash.com/photo-1561336526-2914f13ceb36?auto=format&fit=crop&w=800&q=80", category: "Tea", isAvailable: true },
    { id: "mi_samosa", vendorId: "vendor_meera", name: "Samosa", description: "Crisp potato samosa with green chutney.", price: 25, photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80", category: "Snacks", isAvailable: true }
  ];
  for (const seed of requiredItems) {
    if (!menuItems.some((item) => item.id === seed.id)) menuItems.push(seed);
  }

  const demoEmails: Record<string, string> = {
    vendor_ravi: "ravi@localserve.local",
    vendor_meera: "meera@localserve.local"
  };
  for (const demoId of ["vendor_ravi", "vendor_meera"]) {
    const demoVendor = vendors.find((vendor) => vendor.id === demoId);
    if (demoVendor && !demoVendor.kyc) {
      demoVendor.kyc = { ownerName: demoVendor.name, status: "VERIFIED", reviewedAt: new Date().toISOString() };
    }
    if (demoVendor && !demoVendor.email) {
      demoVendor.email = demoEmails[demoId];
    }
  }
}

function publicVendor(vendor: StoredVendor): Vendor {
  const { passwordHash: _pw, ...rest } = vendor as StoredVendor & { passwordHash?: string };
  return { ...rest, storefrontUrl: `${publicAppUrl}/v/${vendor.slug}` } as Vendor;
}

function publicStorefrontVendor(vendor: Vendor) {
  return {
    id: vendor.id,
    name: vendor.name,
    slug: vendor.slug,
    locationTag: vendor.locationTag,
    qrUrl: vendor.qrUrl,
    storefrontUrl: vendor.storefrontUrl,
    category: vendor.category ?? "General Store",
    isOpen: isVendorOpenNow(vendor),
    deliveryEnabled: vendor.deliveryEnabled ?? false,
    deliveryFeeFlat: vendor.deliveryFeeFlat ?? 0,
    bannerUrl: vendor.bannerUrl,
    operatingHours: vendor.operatingHours,
    verified: vendor.kyc?.status === "VERIFIED"
  };
}

function publicCustomer(customer: StoredCustomer): Customer {
  const { passwordHash: _pw, ...rest } = customer as StoredCustomer & { passwordHash?: string };
  return rest as Customer;
}

function otpKey(phone: string, purpose: string) {
  return `${purpose}:${phone}`;
}

function hashOtp(phone: string, purpose: string, code: string) {
  return crypto.createHmac("sha256", jwtSecret).update(`${purpose}:${phone}:${code}`).digest("hex");
}

function createOtpCode() {
  if (process.env.NODE_ENV !== "production") return otpDevCode;
  if (!twilioClient) throw Object.assign(new Error("Twilio is not configured for production OTP delivery"), { status: 503 });
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendEmailOtp(email: string, purpose: string): Promise<{ code: string; delivered: boolean }> {
  const code = process.env.NODE_ENV === "production"
    ? String(Math.floor(100000 + Math.random() * 900000))
    : otpDevCode;
  await setOtpChallenge(email, purpose, {
    codeHash: hashOtp(email, purpose, code),
    expiresAt: Date.now() + otpTtlMs,
    attempts: 0
  });

  if (!mailTransporter) {
    if (process.env.NODE_ENV === "production") {
      console.error("Email OTP requested but SMTP is not configured (set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)");
    }
    return { code, delivered: false };
  }

  try {
    await mailTransporter.sendMail({
      to: email,
      from: emailFrom,
      subject: "Your QuickOrder login code",
      text: `Your QuickOrder login code is ${code}. It expires in ${Math.round(otpTtlMs / 60000)} minutes.`
    });
    return { code, delivered: true };
  } catch (error) {
    console.error("Email OTP delivery failed", error);
    return { code, delivered: false };
  }
}

async function setOtpChallenge(phone: string, purpose: string, challenge: { codeHash: string; expiresAt: number; attempts: number }) {
  const key = otpKey(phone, purpose);
  if (redisClient?.status === "ready") {
    await redisClient.set(key, JSON.stringify(challenge), "PX", otpTtlMs);
    return;
  }
  otpChallenges.set(key, challenge);
}

async function getOtpChallenge(phone: string, purpose: string) {
  const key = otpKey(phone, purpose);
  if (redisClient?.status === "ready") {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) as { codeHash: string; expiresAt: number; attempts: number } : undefined;
  }
  return otpChallenges.get(key);
}

async function deleteOtpChallenge(phone: string, purpose: string) {
  const key = otpKey(phone, purpose);
  if (redisClient?.status === "ready") {
    await redisClient.del(key);
    return;
  }
  otpChallenges.delete(key);
}

async function updateOtpChallenge(phone: string, purpose: string, challenge: { codeHash: string; expiresAt: number; attempts: number }) {
  if (redisClient?.status === "ready") {
    await redisClient.set(otpKey(phone, purpose), JSON.stringify(challenge), "PX", Math.max(challenge.expiresAt - Date.now(), 1));
    return;
  }
  otpChallenges.set(otpKey(phone, purpose), challenge);
}

async function sendOtp(phone: string, purpose: string) {
  const code = createOtpCode();
  await setOtpChallenge(phone, purpose, {
    codeHash: hashOtp(phone, purpose, code),
    expiresAt: Date.now() + otpTtlMs,
    attempts: 0
  });

  if (twilioClient && twilioFromPhone && process.env.NODE_ENV === "production") {
    await twilioClient.messages.create({
      to: phone,
      from: twilioFromPhone,
      body: `Your LocalServe OTP is ${code}. It expires in ${Math.round(otpTtlMs / 60000)} minutes.`
    });
  }

  return code;
}

async function verifyOtp(phone: string, purpose: string, code: string) {
  const challenge = await getOtpChallenge(phone, purpose);
  if (!challenge || challenge.expiresAt < Date.now()) {
    await deleteOtpChallenge(phone, purpose);
    return false;
  }
  challenge.attempts += 1;
  if (challenge.attempts > 5) {
    await deleteOtpChallenge(phone, purpose);
    return false;
  }
  const actual = Buffer.from(hashOtp(phone, purpose, code));
  const expected = Buffer.from(challenge.codeHash);
  const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (valid) {
    await deleteOtpChallenge(phone, purpose);
  } else {
    await updateOtpChallenge(phone, purpose, challenge);
  }
  return valid;
}

function getAuthedVendor(req: express.Request) {
  const vendorId = (req as express.Request & { vendorId?: string }).vendorId;
  return vendorId ? getVendorById(vendorId) : undefined;
}

function getAuthedCustomerId(req: express.Request): string | undefined {
  return (req as express.Request & { customerId?: string }).customerId;
}

function requireVendor(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.header("authorization");
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const token = auth?.replace(/^Bearer\s+/i, "") ?? queryToken;
  if (token === vendorToken && (!useMongo || process.env.ALLOW_DEV_VENDOR_TOKEN === "true")) {
    (req as express.Request & { vendorId?: string }).vendorId = vendors[0]?.id;
    next();
    return;
  }

  try {
    const payload = jwt.verify(token ?? "", jwtSecret) as { vendorId?: string };
    if (payload.vendorId && getVendorById(payload.vendorId)) {
      (req as express.Request & { vendorId?: string }).vendorId = payload.vendorId;
      next();
      return;
    }
  } catch {
    // Common auth error below.
  }

  res.status(401).json({ error: "Vendor authentication required" });
}

function requireCustomer(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.header("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "");
  try {
    const payload = jwt.verify(token ?? "", jwtSecret) as { customerId?: string; role?: string };
    if (payload.customerId && payload.role === "customer" && getCustomerById(payload.customerId)) {
      (req as express.Request & { customerId?: string }).customerId = payload.customerId;
      next();
      return;
    }
  } catch {
    // Common auth error below.
  }
  res.status(401).json({ error: "Customer authentication required" });
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  try {
    const payload = jwt.verify(token ?? "", jwtSecret) as { role?: string };
    if (payload.role === "admin") {
      next();
      return;
    }
  } catch {
    // Common auth error below.
  }
  res.status(401).json({ error: "Admin authentication required" });
}

function optionalCustomer(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const auth = req.header("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "");
  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret) as { customerId?: string; role?: string };
      if (payload.customerId && payload.role === "customer") {
        (req as express.Request & { customerId?: string }).customerId = payload.customerId;
      }
    } catch {
      // Optional — ignore invalid customer token
    }
  }
  next();
}

function generateOrderCode(vendorId: string) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const today = businessDateKey(new Date());
  let code = "";
  do {
    code =
      letters[Math.floor(Math.random() * letters.length)] +
      letters[Math.floor(Math.random() * letters.length)] +
      String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  } while ([...orders.values()].some((order) => order.vendorId === vendorId && businessDateKey(new Date(order.createdAt)) === today && order.orderCode === code));
  return code;
}

function businessDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string) {
  if (!razorpayKeySecret) return false;
  const expected = crypto.createHmac("sha256", razorpayKeySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
}

async function buildVendorResponse(vendor: StoredVendor) {
  const storefrontUrl = `${publicAppUrl}/v/${vendor.slug}`;
  const qrUrl = await QRCode.toDataURL(storefrontUrl, { errorCorrectionLevel: "M", margin: 1, width: 512 });
  return { ...publicVendor(vendor), qrUrl };
}

function inStock(item: MenuItem) {
  return typeof item.stockQuantity !== "number" || item.stockQuantity > 0;
}

function vendorMenu(vendorId: string, availableOnly = false) {
  return menuItems.filter((item) => item.vendorId === vendorId && (!availableOnly || (item.isAvailable && inStock(item))));
}

function vendorOrders(vendorId: string) {
  return [...orders.values()].filter((order) => order.vendorId === vendorId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function customerOrders(customerId: string) {
  return [...orders.values()].filter((order) => order.customerId === customerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function isVendorOpenNow(vendor: Pick<Vendor, "isOpen" | "operatingHours">) {
  if (!vendor.isOpen) return false;
  const hours = vendor.operatingHours;
  if (!hours || hours.length !== 7) return true;
  const now = istNow();
  const today = hours[now.getDay()];
  if (!today || today.closed) return false;
  const [openH, openM] = today.open.split(":").map(Number);
  const [closeH, closeM] = today.close.split(":").map(Number);
  if ([openH, openM, closeH, closeM].some(Number.isNaN)) return true;
  const current = now.getHours() * 60 + now.getMinutes();
  return current >= openH * 60 + openM && current < closeH * 60 + closeM;
}

function restockOrder(order: Order) {
  for (const line of order.items) {
    const item = menuItems.find((candidate) => candidate.id === line.menuItemId);
    if (item && typeof item.stockQuantity === "number") {
      item.stockQuantity += line.quantity;
    }
  }
}

async function issueRefundIfNeeded(order: Order): Promise<string | undefined> {
  if (razorpayClient && order.paymentMethod === "online" && order.paymentId && !order.paymentId.startsWith("pay_test_") && !order.paymentId.startsWith("cash_")) {
    try {
      const refund = await razorpayClient.payments.refund(order.paymentId, { amount: Math.round(order.totalAmount * 100) });
      return refund.id;
    } catch (refundError) {
      console.error("Razorpay refund failed", refundError);
    }
  }
  return undefined;
}

async function sendPushToOrder(order: Order, payload: { title: string; body: string }) {
  if (!pushEnabled || pushSubscriptions.length === 0) return;
  const targets = pushSubscriptions.filter(
    (sub) => sub.orderId === order.id || (order.customerId !== undefined && sub.customerId === order.customerId)
  );
  if (targets.length === 0) return;
  const dead: string[] = [];
  await Promise.all(
    targets.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({ title: payload.title, body: payload.body, url: `${publicAppUrl}/order/${order.id}` })
        );
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) dead.push(sub.id);
      }
    })
  );
  if (dead.length) {
    pushSubscriptions = pushSubscriptions.filter((sub) => !dead.includes(sub.id));
    if (useMongo) await PushSubscriptionModel.deleteMany({ _id: { $in: dead } });
  }
}

async function runOrderMaintenance() {
  const now = Date.now();
  let changed = false;
  for (const order of orders.values()) {
    if (order.status === "PENDING" && new Date(order.createdAt).getTime() < now - 30 * 60 * 1000) {
      restockOrder(order);
      const cancelled: Order = { ...order, status: "CANCELLED" };
      orders.set(order.id, cancelled);
      io.to(`vendor:${order.vendorId}`).emit("order_updated", cancelled);
      io.to(`order:${order.id}`).emit("order_updated", cancelled);
      changed = true;
    } else if (order.status === "CONFIRMED") {
      const vendor = getVendorById(order.vendorId);
      const windowMinutes = vendor?.acceptWindowMinutes ?? 15;
      if (new Date(order.createdAt).getTime() < now - windowMinutes * 60 * 1000) {
        restockOrder(order);
        await issueRefundIfNeeded(order);
        const cancelled: Order = { ...order, status: "CANCELLED" };
        orders.set(order.id, cancelled);
        io.to(`vendor:${order.vendorId}`).emit("order_updated", cancelled);
        io.to(`order:${order.id}`).emit("order_updated", cancelled);
        await sendPushToOrder(cancelled, { title: "Order cancelled", body: `Order #${cancelled.orderCode} was cancelled — the shop did not accept it in time.` });
        changed = true;
      }
    }
  }
  if (changed) await persistState();
}

function extensionForMimeType(mimetype: string) {
  if (mimetype === "image/png") return "png";
  if (mimetype === "image/webp") return "webp";
  if (mimetype === "image/gif") return "gif";
  return "jpg";
}

function publicStorageUrl(key: string) {
  if (storagePublicBaseUrl) return `${storagePublicBaseUrl.replace(/\/+$/, "")}/${key}`;
  if (storageEndpoint) return `${storageEndpoint.replace(/\/+$/, "")}/${storageBucket}/${key}`;
  return `https://${storageBucket}.s3.${storageRegion}.amazonaws.com/${key}`;
}

async function uploadMenuPhoto(vendorId: string, itemId: string, file: Express.Multer.File) {
  if (!s3Client || !storageBucket) throw Object.assign(new Error("Menu photo storage is not configured"), { status: 503 });
  const key = `vendors/${vendorId}/menu/${itemId}/${crypto.randomUUID()}.${extensionForMimeType(file.mimetype)}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: storageBucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: "public, max-age=31536000, immutable"
  }));
  return publicStorageUrl(key);
}

async function queueReadyNotification(order: Order) {
  const vendor = getVendorById(order.vendorId);
  const notification: NotificationRecord = {
    id: crypto.randomUUID(),
    vendorId: order.vendorId,
    orderId: order.id,
    channel: "email",
    recipient: order.customerEmail,
    subject: `Order #${order.orderCode} is ready`,
    body: `Your order from ${vendor?.name ?? "LocalServe"} is ready for ${order.orderType === "delivery" ? "delivery" : "pickup"}. Show code ${order.orderCode} at the counter.`,
    status: "QUEUED",
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  notifications.set(notification.id, notification);

  if (!mailTransporter || process.env.NODE_ENV === "test") return notification;

  notification.attempts += 1;
  try {
    await mailTransporter.sendMail({
      to: notification.recipient,
      from: emailFrom,
      subject: notification.subject,
      text: notification.body
    });
    notification.status = "SENT";
    notification.deliveredAt = new Date().toISOString();
  } catch (error) {
    notification.status = "FAILED";
    console.error("Ready notification email failed", error);
  }
  return notification;
}

async function confirmOrderPayment(order: Order, paymentId: string) {
  const updated: Order = { ...order, status: "CONFIRMED", paymentId };
  orders.set(updated.id, updated);
  await persistState();
  io.to(`vendor:${updated.vendorId}`).emit("new_order", updated);
  io.to(`order:${updated.id}`).emit("order_updated", updated);
  return updated;
}

async function loadState() {
  if (useMongo) {
    const [dbVendors, dbMenuItems, dbOrders, dbNotifications, dbCustomers, dbPushSubs] = await Promise.all([
      VendorModel.find().lean(),
      MenuItemModel.find().lean(),
      OrderModel.find().lean(),
      NotificationModel.find().lean(),
      CustomerModel.find().lean(),
      PushSubscriptionModel.find().lean()
    ]);
    if (dbVendors.length) {
      vendors = dbVendors.map((vendor) => ({
        id: String(vendor._id),
        name: vendor.name,
        slug: vendor.slug,
        locationTag: vendor.locationTag,
        phone: vendor.phone,
        email: (vendor as unknown as { email?: string }).email,
        upiId: vendor.upiId,
        qrUrl: vendor.qrUrl ?? "",
        storefrontUrl: `${publicAppUrl}/v/${vendor.slug}`,
        passwordHash: vendor.passwordHash ?? demoPasswordHash,
        category: (vendor as unknown as { category?: string }).category ?? "General Store",
        isOpen: (vendor as unknown as { isOpen?: boolean }).isOpen ?? true,
        deliveryEnabled: (vendor as unknown as { deliveryEnabled?: boolean }).deliveryEnabled ?? false,
        deliveryFeeFlat: (vendor as unknown as { deliveryFeeFlat?: number }).deliveryFeeFlat ?? 0,
        bannerUrl: (vendor as unknown as { bannerUrl?: string }).bannerUrl,
        operatingHours: (vendor as unknown as { operatingHours?: DayHours[] }).operatingHours,
        acceptWindowMinutes: (vendor as unknown as { acceptWindowMinutes?: number }).acceptWindowMinutes ?? 15,
        kyc: (vendor as unknown as { kyc?: Kyc }).kyc
      }));
      menuItems = dbMenuItems.map((item) => ({
        id: String(item._id),
        vendorId: item.vendorId,
        name: item.name,
        description: item.description,
        price: item.price,
        photoUrl: item.photoUrl,
        category: item.category,
        isAvailable: item.isAvailable,
        stockQuantity: (item as unknown as { stockQuantity?: number }).stockQuantity
      }));
      orders.clear();
      for (const order of dbOrders) {
        const o = order as unknown as {
          _id: unknown; vendorId: string; orderCode: string; customerEmail: string; customerPhone?: string;
          customerId?: string; status: string; orderType?: string; deliveryAddress?: DeliveryAddress;
          deliveryFee?: number; paymentMethod?: string; items: unknown; totalAmount: number;
          paymentId?: string; paymentOrderId?: string; createdAt: Date; readyAt?: Date;
        };
        orders.set(String(o._id), {
          id: String(o._id),
          vendorId: o.vendorId,
          orderCode: o.orderCode,
          customerEmail: o.customerEmail,
          customerPhone: o.customerPhone ?? undefined,
          customerId: o.customerId ?? undefined,
          status: o.status as OrderStatus,
          orderType: (o.orderType ?? "pickup") as "pickup" | "delivery",
          deliveryAddress: o.deliveryAddress,
          deliveryFee: o.deliveryFee ?? 0,
          paymentMethod: (o.paymentMethod ?? "online") as "online" | "cash",
          items: o.items as unknown as OrderLine[],
          totalAmount: o.totalAmount,
          paymentId: o.paymentId ?? undefined,
          paymentOrderId: o.paymentOrderId ?? undefined,
          createdAt: o.createdAt.toISOString(),
          readyAt: o.readyAt?.toISOString()
        });
      }
      notifications.clear();
      for (const notification of dbNotifications) {
        const n = notification as unknown as {
          _id: unknown; vendorId: string; orderId: string; channel: string; recipient: string;
          subject: string; body: string; status: string; attempts: number; createdAt: Date; deliveredAt?: Date;
        };
        notifications.set(String(n._id), {
          id: String(n._id),
          vendorId: n.vendorId,
          orderId: n.orderId,
          channel: n.channel as "email" | "sms",
          recipient: n.recipient,
          subject: n.subject,
          body: n.body,
          status: n.status as "QUEUED" | "SENT" | "FAILED",
          attempts: n.attempts,
          createdAt: n.createdAt.toISOString(),
          deliveredAt: n.deliveredAt?.toISOString()
        });
      }
      customers = dbCustomers.map((c) => {
        const cust = c as unknown as {
          _id: unknown; name: string; phone: string; email?: string;
          addresses?: Address[]; createdAt: Date;
        };
        return {
          id: String(cust._id),
          name: cust.name,
          phone: cust.phone,
          email: cust.email,
          addresses: cust.addresses ?? [],
          createdAt: cust.createdAt.toISOString()
        };
      });
      pushSubscriptions = dbPushSubs.map((s) => {
        const sub = s as unknown as {
          _id: unknown; orderId?: string; customerId?: string; endpoint: string;
          keys: { p256dh: string; auth: string }; createdAt: Date;
        };
        return {
          id: String(sub._id),
          orderId: sub.orderId,
          customerId: sub.customerId,
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          createdAt: sub.createdAt.toISOString()
        };
      });
      ensureDemoSeeds();
      return;
    }
  }

  try {
    const parsed = JSON.parse(await fs.readFile(dataFile, "utf8")) as StoredState;
    if (parsed.vendors?.length) {
      vendors = parsed.vendors.map((vendor) => ({ ...vendor, storefrontUrl: `${publicAppUrl}/v/${vendor.slug}` }));
    } else if (parsed.vendor) {
      vendors = [{ ...parsed.vendor, passwordHash: demoPasswordHash, storefrontUrl: `${publicAppUrl}/v/${parsed.vendor.slug}`, category: "General Store", isOpen: true, deliveryEnabled: false, deliveryFeeFlat: 0 }];
    }
    menuItems = parsed.menuItems ?? menuItems;
    orders.clear();
    for (const order of parsed.orders ?? []) orders.set(order.id, order);
    notifications.clear();
    for (const notification of parsed.notifications ?? []) notifications.set(notification.id, notification);
    customers = parsed.customers ?? [];
    pushSubscriptions = parsed.pushSubscriptions ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Could not load local data store; using seed data.", error);
  }
  ensureDemoSeeds();
}

async function persistState() {
  if (useMongo) {
    for (const vendor of vendors) {
      await VendorModel.updateOne(
        { _id: vendor.id },
        { $set: { name: vendor.name, slug: vendor.slug, phone: vendor.phone, email: vendor.email, locationTag: vendor.locationTag, upiId: vendor.upiId, qrUrl: vendor.qrUrl, passwordHash: vendor.passwordHash, category: vendor.category, isOpen: vendor.isOpen, deliveryEnabled: vendor.deliveryEnabled, deliveryFeeFlat: vendor.deliveryFeeFlat, bannerUrl: vendor.bannerUrl, operatingHours: vendor.operatingHours, acceptWindowMinutes: vendor.acceptWindowMinutes, kyc: vendor.kyc } },
        { upsert: true }
      );
    }
    for (const item of menuItems) {
      await MenuItemModel.updateOne({ _id: item.id }, { $set: item }, { upsert: true });
    }
    for (const order of orders.values()) {
      await OrderModel.updateOne(
        { _id: order.id },
        { $set: { ...order, createdAt: new Date(order.createdAt), readyAt: order.readyAt ? new Date(order.readyAt) : undefined } },
        { upsert: true }
      );
    }
    for (const notification of notifications.values()) {
      await NotificationModel.updateOne(
        { _id: notification.id },
        { $set: { ...notification, createdAt: new Date(notification.createdAt), deliveredAt: notification.deliveredAt ? new Date(notification.deliveredAt) : undefined } },
        { upsert: true }
      );
    }
    for (const customer of customers) {
      await CustomerModel.updateOne(
        { _id: customer.id },
        { $set: { name: customer.name, phone: customer.phone, email: customer.email, addresses: customer.addresses } },
        { upsert: true }
      );
    }
    const knownSubIds = pushSubscriptions.map((sub) => sub.id);
    await PushSubscriptionModel.deleteMany({ _id: { $nin: knownSubIds } });
    for (const sub of pushSubscriptions) {
      await PushSubscriptionModel.updateOne(
        { _id: sub.id },
        { $set: { orderId: sub.orderId, customerId: sub.customerId, endpoint: sub.endpoint, keys: sub.keys, createdAt: new Date(sub.createdAt) } },
        { upsert: true }
      );
    }
    return;
  }

  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, JSON.stringify({ vendors, menuItems, orders: [...orders.values()], notifications: [...notifications.values()], customers, pushSubscriptions }, null, 2));
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "localserve-api", storage: useMongo ? "mongoose-mongodb" : "local-json", realtime: "socket.io" });
});

app.get("/demo-vendors", asyncHandler(async (_req, res) => {
  res.json({ vendors: await Promise.all(vendors.map(buildVendorResponse)) });
}));

// ── Shop Discovery ────────────────────────────────────────────────────────────

app.get("/shops", asyncHandler(async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.toLowerCase().trim() : undefined;
  const deliveryOnly = req.query.deliveryOnly === "true";

  let results = vendors;
  if (category) results = results.filter((v) => v.category === category);
  if (deliveryOnly) results = results.filter((v) => v.deliveryEnabled);
  if (q) results = results.filter((v) => v.name.toLowerCase().includes(q) || v.locationTag.toLowerCase().includes(q) || (v.category ?? "").toLowerCase().includes(q));

  const shopList = results.map((v) => ({
    id: v.id,
    name: v.name,
    slug: v.slug,
    locationTag: v.locationTag,
    category: v.category ?? "General Store",
    isOpen: isVendorOpenNow(v),
    deliveryEnabled: v.deliveryEnabled ?? false,
    deliveryFeeFlat: v.deliveryFeeFlat ?? 0,
    storefrontUrl: `${publicAppUrl}/v/${v.slug}`,
    bannerUrl: v.bannerUrl,
    verified: v.kyc?.status === "VERIFIED"
  }));

  res.json({ shops: shopList, total: shopList.length });
}));

// ── Vendor Auth ───────────────────────────────────────────────────────────────

app.post("/auth/vendor/otp/request", authLimiter, asyncHandler(async (req, res) => {
  const body = otpRequestSchema.parse(req.body);
  const vendor = vendors.find((candidate) => candidate.phone === body.phone);
  if (body.purpose === "login" && !vendor) {
    res.status(404).json({ error: "Vendor not found. Create a shop first." });
    return;
  }
  if (body.purpose === "register" && vendor) {
    res.status(409).json({ error: "Vendor already exists. Please login with the same mobile number." });
    return;
  }

  const code = await sendOtp(body.phone, body.purpose);
  res.json({
    status: "sent",
    channel: twilioClient && process.env.NODE_ENV === "production" ? "sms" : "dev",
    expiresInSeconds: Math.round(otpTtlMs / 1000),
    ...(twilioClient && process.env.NODE_ENV === "production" ? {} : { devOtp: code })
  });
}));

app.post("/auth/vendor/otp/verify", authLimiter, asyncHandler(async (req, res) => {
  const body = otpVerifySchema.parse(req.body);
  const vendor = vendors.find((candidate) => candidate.phone === body.phone);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found. Create a shop first." });
    return;
  }
  if (!(await verifyOtp(body.phone, "login", body.otpCode))) {
    res.status(401).json({ error: "Invalid or expired OTP" });
    return;
  }
  res.json({ vendor: await buildVendorResponse(vendor), token: createVendorToken(vendor.id) });
}));

app.post("/auth/vendor/email/otp/request", authLimiter, asyncHandler(async (req, res) => {
  const { email } = emailOtpRequestSchema.parse(req.body);
  const normalized = email.toLowerCase();
  const vendor = vendors.find((candidate) => candidate.email?.toLowerCase() === normalized);
  if (!vendor) {
    res.status(404).json({ error: "No shop is registered with this email. Add an email in your shop profile first." });
    return;
  }
  const { code, delivered } = await sendEmailOtp(normalized, "vendor-email");
  if (process.env.NODE_ENV === "production" && !delivered) {
    res.status(502).json({ error: "We couldn't send the login email right now. Please try again shortly or log in with your mobile number." });
    return;
  }
  res.json({
    status: "sent",
    channel: "email",
    expiresInSeconds: Math.round(otpTtlMs / 1000),
    ...(process.env.NODE_ENV === "production" ? {} : { devOtp: code })
  });
}));

app.post("/auth/vendor/email/otp/verify", authLimiter, asyncHandler(async (req, res) => {
  const body = emailOtpVerifySchema.parse(req.body);
  const normalized = body.email.toLowerCase();
  const vendor = vendors.find((candidate) => candidate.email?.toLowerCase() === normalized);
  if (!vendor) {
    res.status(404).json({ error: "No shop is registered with this email." });
    return;
  }
  if (!(await verifyOtp(normalized, "vendor-email", body.otpCode))) {
    res.status(401).json({ error: "Invalid or expired OTP" });
    return;
  }
  res.json({ vendor: await buildVendorResponse(vendor), token: createVendorToken(vendor.id) });
}));

app.post("/auth/vendor/login", authLimiter, asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_PASSWORD_LOGIN !== "true") {
    res.status(403).json({ error: "Password login is disabled. Use OTP login." });
    return;
  }
  const body = loginSchema.parse(req.body);
  const vendor = vendors.find((candidate) => candidate.phone === body.phone);
  if (!vendor || !bcrypt.compareSync(body.password, vendor.passwordHash)) {
    res.status(401).json({ error: "Invalid phone or password" });
    return;
  }
  res.json({ vendor: await buildVendorResponse(vendor), token: createVendorToken(vendor.id) });
}));

app.post("/vendor/register", authLimiter, asyncHandler(async (req, res) => {
  const body = vendorRegistrationSchema.parse(req.body);
  const existing = vendors.find((candidate) => candidate.phone === body.phone);
  if (existing) {
    res.status(409).json({ error: "Vendor already exists. Please login with the same credentials." });
    return;
  }
  if (!(await verifyOtp(body.phone, "register", body.otpCode))) {
    res.status(401).json({ error: "Invalid or expired OTP" });
    return;
  }
  const email = body.email ? body.email.toLowerCase() : undefined;
  if (email && vendors.some((candidate) => candidate.email?.toLowerCase() === email)) {
    res.status(409).json({ error: "Another shop already uses this email." });
    return;
  }
  const slug = uniqueSlug(body.name);
  const vendor: StoredVendor = {
    id: crypto.randomUUID(),
    passwordHash: bcrypt.hashSync(body.password, 10),
    qrUrl: "",
    name: body.name,
    slug,
    phone: body.phone,
    email,
    locationTag: body.locationTag,
    upiId: body.upiId,
    storefrontUrl: `${publicAppUrl}/v/${slug}`,
    category: "General Store",
    isOpen: true,
    deliveryEnabled: false,
    deliveryFeeFlat: 0
  };
  vendors.push(vendor);
  await persistState();
  res.status(201).json({ vendor: await buildVendorResponse(vendor), token: createVendorToken(vendor.id) });
}));

app.get("/vendor/me", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  res.json({ vendor: await buildVendorResponse(vendor) });
}));

app.patch("/vendor/profile", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  const body = vendorProfileSchema.parse(req.body);
  if (body.email) {
    const normalized = body.email.toLowerCase();
    if (vendors.some((candidate) => candidate.id !== vendor.id && candidate.email?.toLowerCase() === normalized)) {
      res.status(409).json({ error: "Another shop already uses this email." });
      return;
    }
  }
  Object.assign(vendor, {
    name: body.name,
    locationTag: body.locationTag,
    upiId: body.upiId,
    storefrontUrl: `${publicAppUrl}/v/${vendor.slug}`,
    ...(body.email !== undefined && { email: body.email ? body.email.toLowerCase() : undefined }),
    ...(body.category !== undefined && { category: body.category }),
    ...(body.isOpen !== undefined && { isOpen: body.isOpen }),
    ...(body.deliveryEnabled !== undefined && { deliveryEnabled: body.deliveryEnabled }),
    ...(body.deliveryFeeFlat !== undefined && { deliveryFeeFlat: body.deliveryFeeFlat }),
    ...(body.bannerUrl !== undefined && { bannerUrl: body.bannerUrl || undefined }),
    ...(body.operatingHours !== undefined && { operatingHours: body.operatingHours }),
    ...(body.acceptWindowMinutes !== undefined && { acceptWindowMinutes: body.acceptWindowMinutes })
  });
  await persistState();
  res.json({ vendor: await buildVendorResponse(vendor) });
}));

app.post("/vendor/kyc", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  const body = kycSubmitSchema.parse(req.body);
  vendor.kyc = {
    ownerName: body.ownerName,
    gstin: body.gstin || undefined,
    status: "PENDING",
    submittedAt: new Date().toISOString()
  };
  await persistState();
  res.json({ vendor: await buildVendorResponse(vendor) });
}));

// ── Admin ─────────────────────────────────────────────────────────────────────

app.post("/auth/admin/login", authLimiter, asyncHandler(async (req, res) => {
  if (!adminConfigured) {
    res.status(403).json({ error: "Admin console is not configured. Set ADMIN_PASSWORD to enable it." });
    return;
  }
  const body = adminLoginSchema.parse(req.body);
  if (body.email.toLowerCase() !== adminEmail || !bcrypt.compareSync(body.password, adminPasswordHash)) {
    res.status(401).json({ error: "Invalid admin credentials" });
    return;
  }
  res.json({ token: createAdminToken(), email: adminEmail });
}));

app.get("/admin/vendors", requireAdmin, asyncHandler(async (_req, res) => {
  const list = vendors.map((vendor) => {
    const vendorOrderList = vendorOrders(vendor.id);
    return {
      id: vendor.id,
      name: vendor.name,
      slug: vendor.slug,
      phone: vendor.phone,
      locationTag: vendor.locationTag,
      category: vendor.category ?? "General Store",
      kyc: vendor.kyc ?? { ownerName: vendor.name, status: "UNSUBMITTED" as const },
      isOpen: vendor.isOpen ?? true,
      deliveryEnabled: vendor.deliveryEnabled ?? false,
      orderCount: vendorOrderList.length,
      revenue: vendorOrderList.filter((order) => order.status === "COLLECTED").reduce((sum, order) => sum + order.totalAmount, 0)
    };
  });
  res.json({ vendors: list });
}));

app.patch("/admin/vendors/:id/verify", requireAdmin, asyncHandler(async (req, res) => {
  const vendor = getVendorById(req.params.id);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  const body = vendorVerifySchema.parse(req.body);
  const kyc: Kyc = {
    ownerName: vendor.kyc?.ownerName ?? vendor.name,
    gstin: vendor.kyc?.gstin,
    status: body.status,
    rejectionReason: body.status === "REJECTED" ? body.rejectionReason : undefined,
    submittedAt: vendor.kyc?.submittedAt,
    reviewedAt: new Date().toISOString()
  };
  vendor.kyc = kyc;
  await persistState();
  res.json({ vendor: publicVendor(vendor) });
}));

app.get("/admin/metrics", requireAdmin, asyncHandler(async (_req, res) => {
  const allOrders = [...orders.values()];
  const collected = allOrders.filter((order) => order.status === "COLLECTED");
  res.json({
    totalVendors: vendors.length,
    verifiedVendors: vendors.filter((vendor) => vendor.kyc?.status === "VERIFIED").length,
    pendingKyc: vendors.filter((vendor) => vendor.kyc?.status === "PENDING").length,
    totalCustomers: customers.length,
    totalOrders: allOrders.length,
    activeOrders: allOrders.filter((order) => ["CONFIRMED", "PREPARING", "READY"].includes(order.status)).length,
    collectedRevenue: collected.reduce((sum, order) => sum + order.totalAmount, 0),
    grossOrderValue: allOrders.filter((order) => order.status !== "CANCELLED").reduce((sum, order) => sum + order.totalAmount, 0)
  });
}));

app.get("/admin/orders", requireAdmin, asyncHandler(async (_req, res) => {
  const recent = [...orders.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100)
    .map((order) => ({ ...order, vendorName: getVendorById(order.vendorId)?.name ?? "Shop" }));
  res.json({ orders: recent });
}));

// ── Web Push ──────────────────────────────────────────────────────────────────

app.get("/push/vapid-public-key", (_req, res) => {
  res.json({ key: pushEnabled ? vapidPublicKey : null });
});

app.post("/push/subscribe", optionalCustomer, asyncHandler(async (req, res) => {
  const body = pushSubscribeSchema.parse(req.body);
  const customerId = getAuthedCustomerId(req) ?? body.customerId;
  pushSubscriptions = pushSubscriptions.filter((sub) => sub.endpoint !== body.subscription.endpoint);
  pushSubscriptions.push({
    id: crypto.randomUUID(),
    orderId: body.orderId,
    customerId,
    endpoint: body.subscription.endpoint,
    keys: body.subscription.keys,
    createdAt: new Date().toISOString()
  });
  await persistState();
  res.status(201).json({ ok: true });
}));

// ── Customer Auth ─────────────────────────────────────────────────────────────

app.post("/auth/customer/otp/request", authLimiter, asyncHandler(async (req, res) => {
  const body = customerOtpRequestSchema.parse(req.body);
  const code = await sendOtp(body.phone, "customer");
  res.json({
    status: "sent",
    channel: twilioClient && process.env.NODE_ENV === "production" ? "sms" : "dev",
    expiresInSeconds: Math.round(otpTtlMs / 1000),
    ...(twilioClient && process.env.NODE_ENV === "production" ? {} : { devOtp: code })
  });
}));

app.post("/auth/customer/otp/verify", authLimiter, asyncHandler(async (req, res) => {
  const body = customerOtpVerifySchema.parse(req.body);
  if (!(await verifyOtp(body.phone, "customer", body.otpCode))) {
    res.status(401).json({ error: "Invalid or expired OTP" });
    return;
  }

  let customer = customers.find((c) => c.phone === body.phone);
  const isNew = !customer;

  if (!customer) {
    customer = {
      id: crypto.randomUUID(),
      name: body.name ?? "Customer",
      phone: body.phone,
      email: body.email,
      addresses: [],
      createdAt: new Date().toISOString()
    };
    customers.push(customer);
    await persistState();
  } else if (body.name && body.name !== "Customer") {
    customer.name = body.name;
    if (body.email) customer.email = body.email;
    await persistState();
  }

  res.json({ customer: publicCustomer(customer), token: createCustomerToken(customer.id), isNew });
}));

app.post("/auth/customer/email/otp/request", authLimiter, asyncHandler(async (req, res) => {
  const { email } = emailOtpRequestSchema.parse(req.body);
  const { code, delivered } = await sendEmailOtp(email.toLowerCase(), "customer-email");
  if (process.env.NODE_ENV === "production" && !delivered) {
    res.status(502).json({ error: "We couldn't send the login email right now. Please try again shortly or continue with your mobile number." });
    return;
  }
  res.json({
    status: "sent",
    channel: "email",
    expiresInSeconds: Math.round(otpTtlMs / 1000),
    ...(process.env.NODE_ENV === "production" ? {} : { devOtp: code })
  });
}));

app.post("/auth/customer/email/otp/verify", authLimiter, asyncHandler(async (req, res) => {
  const body = emailOtpVerifySchema.parse(req.body);
  const email = body.email.toLowerCase();
  if (!(await verifyOtp(email, "customer-email", body.otpCode))) {
    res.status(401).json({ error: "Invalid or expired OTP" });
    return;
  }

  let customer = customers.find((c) => c.email?.toLowerCase() === email);
  const isNew = !customer;

  if (!customer) {
    customer = {
      id: crypto.randomUUID(),
      name: body.name ?? "Customer",
      email,
      addresses: [],
      createdAt: new Date().toISOString()
    };
    customers.push(customer);
    await persistState();
  } else if (body.name && body.name !== "Customer" && customer.name === "Customer") {
    customer.name = body.name;
    await persistState();
  }

  res.json({ customer: publicCustomer(customer), token: createCustomerToken(customer.id), isNew });
}));

app.get("/customer/me", requireCustomer, (req, res) => {
  const customerId = getAuthedCustomerId(req);
  const customer = customerId ? getCustomerById(customerId) : undefined;
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json({ customer: publicCustomer(customer) });
});

app.patch("/customer/profile", requireCustomer, asyncHandler(async (req, res) => {
  const customerId = getAuthedCustomerId(req);
  const customer = customerId ? getCustomerById(customerId) : undefined;
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const body = customerProfileSchema.parse(req.body);
  customer.name = body.name;
  if (body.email !== undefined) customer.email = body.email || undefined;
  await persistState();
  res.json({ customer: publicCustomer(customer) });
}));

app.post("/customer/addresses", requireCustomer, asyncHandler(async (req, res) => {
  const customerId = getAuthedCustomerId(req);
  const customer = customerId ? getCustomerById(customerId) : undefined;
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const body = customerAddressSchema.parse(req.body);
  const address: Address = { id: crypto.randomUUID(), ...body };
  customer.addresses = [...(customer.addresses ?? []), address];
  await persistState();
  res.status(201).json({ address });
}));

app.delete("/customer/addresses/:id", requireCustomer, asyncHandler(async (req, res) => {
  const customerId = getAuthedCustomerId(req);
  const customer = customerId ? getCustomerById(customerId) : undefined;
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  customer.addresses = (customer.addresses ?? []).filter((a) => a.id !== req.params.id);
  await persistState();
  res.status(204).send();
}));

app.get("/customer/orders", requireCustomer, asyncHandler(async (req, res) => {
  await runOrderMaintenance();
  const customerId = getAuthedCustomerId(req);
  if (!customerId) {
    res.json({ orders: [] });
    return;
  }
  const customerOrderList = customerOrders(customerId).map((order) => {
    const vendor = getVendorById(order.vendorId);
    return { ...order, vendorName: vendor?.name ?? "Shop" };
  });
  res.json({ orders: customerOrderList });
}));

// ── Payments ──────────────────────────────────────────────────────────────────

app.post("/payments/razorpay/webhook", asyncHandler(async (req, res) => {
  const signature = req.header("x-razorpay-signature");
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
  const expected = crypto.createHmac("sha256", razorpayWebhookSecret).update(rawBody).digest("hex");
  const received = Buffer.from(signature ?? "");
  const expectedBuffer = Buffer.from(expected);
  if (!signature || received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) {
    res.status(401).json({ error: "Invalid Razorpay signature" });
    return;
  }
  const paymentEntity = req.body?.payload?.payment?.entity;
  const providerOrderId = typeof paymentEntity?.order_id === "string" ? paymentEntity.order_id : undefined;
  const providerPaymentId = typeof paymentEntity?.id === "string" ? paymentEntity.id : undefined;
  if (providerOrderId && providerPaymentId) {
    const order = [...orders.values()].find((candidate) => candidate.paymentOrderId === providerOrderId);
    if (order && order.status === "PENDING") await confirmOrderPayment(order, providerPaymentId);
  }
  res.json({ received: true });
}));

// ── Storefront ────────────────────────────────────────────────────────────────

app.get("/v/:vendorSlug", asyncHandler(async (req, res) => {
  const vendor = getVendorBySlug(req.params.vendorSlug);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  const vendorResponse = await buildVendorResponse(vendor);
  res.json({ vendor: publicStorefrontVendor(vendorResponse), menuItems: vendorMenu(vendor.id, true) });
}));

// ── Orders ────────────────────────────────────────────────────────────────────

app.post("/orders", optionalCustomer, asyncHandler(async (req, res) => {
  const body = createOrderBodySchema.parse(req.body);
  const vendor = getVendorBySlug(body.vendorSlug);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  if (body.orderType === "delivery" && !vendor.deliveryEnabled) {
    res.status(400).json({ error: "This shop does not offer delivery" });
    return;
  }
  if (body.orderType === "delivery" && !body.deliveryAddress) {
    res.status(400).json({ error: "Delivery address is required for delivery orders" });
    return;
  }
  if (!isVendorOpenNow(vendor)) {
    res.status(400).json({ error: "This shop is currently closed and not accepting orders" });
    return;
  }

  const lines: OrderLine[] = body.items.map((cartItem) => {
    const menuItem = menuItems.find((item) => item.vendorId === vendor.id && item.id === cartItem.menuItemId && item.isAvailable);
    if (!menuItem) throw Object.assign(new Error(`Menu item unavailable: ${cartItem.menuItemId}`), { status: 400 });
    if (typeof menuItem.stockQuantity === "number" && menuItem.stockQuantity < cartItem.quantity) {
      throw Object.assign(new Error(menuItem.stockQuantity === 0 ? `${menuItem.name} is out of stock` : `Only ${menuItem.stockQuantity} ${menuItem.name} left in stock`), { status: 400 });
    }
    return { menuItemId: menuItem.id, name: menuItem.name, quantity: cartItem.quantity, unitPrice: menuItem.price, lineTotal: menuItem.price * cartItem.quantity };
  });

  const itemsTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const deliveryFee = body.orderType === "delivery" ? (vendor.deliveryFeeFlat ?? 0) : 0;
  const totalAmount = itemsTotal + deliveryFee;

  const customerId = getAuthedCustomerId(req) ?? body.customerId;

  const isCash = body.paymentMethod === "cash";
  const order: Order = {
    id: crypto.randomUUID(),
    vendorId: vendor.id,
    orderCode: generateOrderCode(vendor.id),
    customerEmail: body.customerEmail,
    customerPhone: body.customerPhone,
    customerId,
    status: isCash || !razorpayClient ? "CONFIRMED" : "PENDING",
    orderType: body.orderType,
    deliveryAddress: body.deliveryAddress,
    deliveryFee,
    paymentMethod: body.paymentMethod,
    items: lines,
    totalAmount,
    paymentId: isCash ? `cash_${crypto.randomBytes(6).toString("hex")}` : (razorpayClient ? undefined : `pay_test_${crypto.randomBytes(6).toString("hex")}`),
    createdAt: new Date().toISOString()
  };

  let razorpayOrder: { id: string; amount: number; currency: string } | undefined;
  if (!isCash && razorpayClient) {
    const providerOrder = await razorpayClient.orders.create({
      amount: Math.round(totalAmount * 100),
      currency: "INR",
      receipt: order.id,
      notes: {
        localserve_order_id: order.id,
        vendor_id: vendor.id,
        platform_fee_percent: String(platformFeePercent)
      }
    });
    razorpayOrder = { id: providerOrder.id, amount: Number(providerOrder.amount), currency: providerOrder.currency };
    order.paymentOrderId = providerOrder.id;
  }

  orders.set(order.id, order);
  for (const line of lines) {
    const item = menuItems.find((candidate) => candidate.id === line.menuItemId);
    if (item && typeof item.stockQuantity === "number") {
      item.stockQuantity = Math.max(0, item.stockQuantity - line.quantity);
    }
  }
  await persistState();
  if (isCash || !razorpayClient) {
    io.to(`vendor:${vendor.id}`).emit("new_order", order);
    io.to(`order:${order.id}`).emit("order_updated", order);
  }
  res.status(201).json({
    order,
    payment: razorpayOrder
      ? { mode: "live", status: "created", provider: "razorpay", keyId: razorpayKeyId, orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency }
      : { mode: isCash ? "cash" : "test", status: "captured", provider: isCash ? "cash" : "razorpay-test" },
    orderUrl: `${publicAppUrl}/order/${order.id}`
  });
}));

app.post("/orders/:id/confirm", asyncHandler(async (req, res) => {
  const body = paymentConfirmationSchema.parse(req.body);
  const order = orders.get(req.params.id);
  if (!order || order.paymentOrderId !== body.razorpay_order_id) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (!verifyRazorpaySignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
    res.status(401).json({ error: "Invalid Razorpay payment signature" });
    return;
  }
  const updated = await confirmOrderPayment(order, body.razorpay_payment_id);
  res.json({ order: updated, orderUrl: `${publicAppUrl}/order/${updated.id}` });
}));

app.post("/orders/:id/cancel", optionalCustomer, asyncHandler(async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  const customerId = getAuthedCustomerId(req);
  const isOrderOwner = customerId && order.customerId === customerId;
  const isVendor = (() => {
    try {
      const auth = req.header("authorization")?.replace(/^Bearer\s+/i, "");
      if (!auth) return false;
      const payload = jwt.verify(auth, jwtSecret) as { vendorId?: string };
      return payload.vendorId === order.vendorId;
    } catch {
      return false;
    }
  })();

  if (!isOrderOwner && !isVendor) {
    res.status(403).json({ error: "Not authorized to cancel this order" });
    return;
  }

  const cancellableStatuses: OrderStatus[] = ["PENDING", "CONFIRMED"];
  if (!cancellableStatuses.includes(order.status)) {
    res.status(400).json({ error: `Cannot cancel an order with status ${order.status}` });
    return;
  }

  const refundId = await issueRefundIfNeeded(order);
  restockOrder(order);

  const cancelled: Order = { ...order, status: "CANCELLED" };
  orders.set(cancelled.id, cancelled);
  await persistState();
  io.to(`vendor:${order.vendorId}`).emit("order_updated", cancelled);
  io.to(`order:${order.id}`).emit("order_updated", cancelled);
  await sendPushToOrder(cancelled, { title: "Order cancelled", body: `Order #${cancelled.orderCode} has been cancelled.` });
  res.json({ order: cancelled, refundId });
}));

app.get("/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  const vendor = order ? getVendorById(order.vendorId) : undefined;
  if (!order || !vendor) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json({ order, vendor: { name: vendor.name, locationTag: vendor.locationTag } });
});

app.patch("/orders/:id/status", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  const status = z.enum(["PREPARING", "READY", "COLLECTED", "CANCELLED"]).parse(req.body.status);
  const order = orders.get(req.params.id);
  if (!vendor || !order || order.vendorId !== vendor.id) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  if (status === "CANCELLED" && order.status !== "CANCELLED") {
    await issueRefundIfNeeded(order);
    restockOrder(order);
  }
  const updated: Order = { ...order, status, readyAt: status === "READY" ? new Date().toISOString() : order.readyAt };
  orders.set(updated.id, updated);
  const notification = status === "READY" ? await queueReadyNotification(updated) : undefined;
  await persistState();
  io.to(`vendor:${vendor.id}`).emit("order_updated", updated);
  io.to(`order:${updated.id}`).emit(status === "READY" ? "order_ready" : "order_updated", updated);
  const pushMessages: Record<OrderStatus, { title: string; body: string } | undefined> = {
    PENDING: undefined,
    CONFIRMED: undefined,
    PREPARING: { title: "Order in progress", body: `${vendor.name} has started preparing order #${updated.orderCode}.` },
    READY: { title: "Order ready", body: updated.orderType === "delivery" ? `Order #${updated.orderCode} is out for delivery.` : `Order #${updated.orderCode} is ready for pickup.` },
    COLLECTED: { title: "Order completed", body: `Order #${updated.orderCode} is complete. Thanks for ordering!` },
    CANCELLED: { title: "Order cancelled", body: `Order #${updated.orderCode} has been cancelled by the shop.` }
  };
  const pushMessage = pushMessages[status];
  if (pushMessage) await sendPushToOrder(updated, pushMessage);
  res.json({ order: updated, notification: notification ? { channel: notification.channel, to: notification.recipient, message: notification.body } : undefined });
}));

app.get("/vendor/orders", requireVendor, asyncHandler(async (req, res) => {
  await runOrderMaintenance();
  const vendor = getAuthedVendor(req);
  res.json({ orders: vendor ? vendorOrders(vendor.id) : [] });
}));

app.get("/vendor/orders/:id/receipt.pdf", requireVendor, (req, res) => {
  const vendor = getAuthedVendor(req);
  const order = orders.get(req.params.id);
  if (!vendor || !order || order.vendorId !== vendor.id) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.setHeader("content-type", "application/pdf");
  res.setHeader("content-disposition", `attachment; filename="${order.orderCode}-receipt.pdf"`);
  const doc = new PDFDocument({ margin: 48 });
  doc.pipe(res);
  doc.fontSize(22).text(vendor.name);
  doc.fontSize(11).fillColor("#555").text(vendor.locationTag);
  doc.moveDown();
  doc.fillColor("#111").fontSize(16).text(`Receipt #${order.orderCode}`);
  doc.fontSize(10).fillColor("#555").text(new Date(order.createdAt).toLocaleString("en-IN"));
  doc.moveDown();
  doc.fillColor("#111").fontSize(12);
  for (const item of order.items) {
    doc.text(`${item.name} x${item.quantity}`, { continued: true });
    doc.text(`Rs. ${item.lineTotal}`, { align: "right" });
  }
  if (order.deliveryFee) {
    doc.text("Delivery fee", { continued: true });
    doc.text(`Rs. ${order.deliveryFee}`, { align: "right" });
  }
  doc.moveDown();
  doc.fontSize(14).text(`Total: Rs. ${order.totalAmount}`, { align: "right" });
  doc.moveDown();
  doc.fontSize(10).fillColor("#555").text(`Payment: ${order.paymentMethod === "cash" ? "Cash" : (order.paymentId ?? "N/A")}`);
  doc.text(`Type: ${order.orderType === "delivery" ? "Delivery" : "Pickup"}`);
  doc.text(`Status: ${order.status}`);
  if (order.deliveryAddress) {
    doc.text(`Deliver to: ${order.deliveryAddress.line1}, ${order.deliveryAddress.city} - ${order.deliveryAddress.pincode}`);
  }
  doc.end();
});

app.get("/vendor/menu", requireVendor, (req, res) => {
  const vendor = getAuthedVendor(req);
  res.json({ menuItems: vendor ? vendorMenu(vendor.id) : [] });
});

app.post("/vendor/menu", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  const body = menuItemBodySchema.parse(req.body);
  const item: MenuItem = { id: crypto.randomUUID(), vendorId: vendor.id, ...body };
  menuItems = [item, ...menuItems];
  await persistState();
  res.status(201).json({ menuItem: item });
}));

app.patch("/vendor/menu/:id", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  const body = menuItemBodySchema.partial().parse(req.body);
  const item = menuItems.find((candidate) => candidate.vendorId === vendor?.id && candidate.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: "Menu item not found" });
    return;
  }
  Object.assign(item, body);
  await persistState();
  res.json({ menuItem: item });
}));

app.post("/vendor/menu/:id/photo", requireVendor, upload.single("photo"), asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  const item = menuItems.find((candidate) => candidate.vendorId === vendor?.id && candidate.id === req.params.id);
  if (!item || !vendor) {
    res.status(404).json({ error: "Menu item not found" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "Photo file is required" });
    return;
  }
  const photoUrl = await uploadMenuPhoto(vendor.id, item.id, req.file);
  item.photoUrl = photoUrl;
  await persistState();
  res.json({ menuItem: item });
}));

app.delete("/vendor/menu/:id", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  const before = menuItems.length;
  menuItems = menuItems.filter((item) => !(item.vendorId === vendor?.id && item.id === req.params.id));
  if (menuItems.length === before) {
    res.status(404).json({ error: "Menu item not found" });
    return;
  }
  await persistState();
  res.status(204).send();
}));

app.get("/vendor/qr", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  res.json({ vendor: await buildVendorResponse(vendor) });
}));

app.get("/vendor/qr.png", requireVendor, asyncHandler(async (req, res) => {
  const vendor = getAuthedVendor(req);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  const png = await QRCode.toBuffer(`${publicAppUrl}/v/${vendor.slug}`, { errorCorrectionLevel: "M", margin: 1, width: 1200 });
  res.setHeader("content-type", "image/png");
  res.setHeader("content-disposition", `attachment; filename="${vendor.slug}-qr.png"`);
  res.send(png);
}));

app.get("/vendor/dashboard", requireVendor, asyncHandler(async (req, res) => {
  await runOrderMaintenance();
  const vendor = getAuthedVendor(req);
  const allOrders = vendor ? vendorOrders(vendor.id) : [];
  const revenue = allOrders.filter((order) => order.status === "COLLECTED").reduce((sum, order) => sum + order.totalAmount, 0);
  const pendingSettlement = allOrders
    .filter((order) => ["CONFIRMED", "PREPARING", "READY"].includes(order.status))
    .reduce((sum, order) => sum + order.totalAmount, 0);
  res.json({ totalOrders: allOrders.length, revenue, pendingSettlement, recentOrders: allOrders.slice(0, 5) });
}));

app.get("/vendor/notifications", requireVendor, (req, res) => {
  const vendor = getAuthedVendor(req);
  const vendorNotifications = [...notifications.values()].filter((notification) => notification.vendorId === vendor?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ notifications: vendorNotifications });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  socket.on("join_vendor", (payload: { token: string }) => {
    if (payload.token === vendorToken && (!useMongo || process.env.ALLOW_DEV_VENDOR_TOKEN === "true")) {
      socket.join(`vendor:${vendors[0]?.id}`);
      return;
    }
    try {
      const payloadData = jwt.verify(payload.token, jwtSecret) as { vendorId?: string };
      if (payloadData.vendorId && getVendorById(payloadData.vendorId)) socket.join(`vendor:${payloadData.vendorId}`);
    } catch {
      // Ignore invalid socket auth attempts.
    }
  });
  socket.on("join_order", (payload: { orderId: string }) => socket.join(`order:${payload.orderId}`));
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Photo must be 2 MB or smaller" : error.message });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.flatten() });
    return;
  }
  const status = typeof error === "object" && error && "status" in error && typeof error.status === "number" ? error.status : 500;
  const message = error instanceof Error ? error.message : "Internal server error";
  res.status(status).json({ error: status >= 500 ? "Internal server error" : message });
});

export async function initialize() {
  validateRuntimeConfig();
  if (redisPubClient && redisSubClient) {
    try {
      await Promise.all([redisPubClient.connect(), redisSubClient.connect()]);
      io.adapter(createAdapter(redisPubClient, redisSubClient));
    } catch (error) {
      console.warn("Redis unavailable; continuing without the Socket.IO Redis adapter", error);
    }
  }
  if (useMongo) await connectMongo(mongoUri);
  await loadState();
  await persistState();
  if (mailTransporter) {
    mailTransporter
      .verify()
      .then(() => console.log("SMTP transport verified — email delivery is ready"))
      .catch((error) => console.error("SMTP transport verification failed — email OTP and notifications will not be delivered", error));
  }
}

export function resetLocalState() {
  vendors = [
    { id: "vendor_ravi", name: "Ravi's Canteen", slug: "ravi-canteen", locationTag: "Office Block B, Ground Floor", phone: "+919876543210", upiId: "ravi@upi", qrUrl: "", storefrontUrl: `${publicAppUrl}/v/ravi-canteen`, passwordHash: demoPasswordHash, category: "Food & Snacks", isOpen: true, deliveryEnabled: false, deliveryFeeFlat: 0 },
    { id: "vendor_meera", name: "Meera Tea Point", slug: "meera-tea-point", locationTag: "Tower A Lobby", phone: "+919812345670", upiId: "meera@upi", qrUrl: "", storefrontUrl: `${publicAppUrl}/v/meera-tea-point`, passwordHash: demoPasswordHash, category: "Tea & Coffee", isOpen: true, deliveryEnabled: true, deliveryFeeFlat: 20 }
  ];
  menuItems = menuItems.filter(() => false);
  menuItems.push(
    { id: "mi_veg_sandwich", vendorId: "vendor_ravi", name: "Veg Sandwich", description: "Grilled vegetables, chutney, and soft bread.", price: 45, photoUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=800&q=80", category: "Snacks", isAvailable: true },
    { id: "mi_paneer_roll", vendorId: "vendor_ravi", name: "Paneer Roll", description: "Spiced paneer wrapped in a warm paratha.", price: 60, photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80", category: "Rolls", isAvailable: true },
    { id: "mi_chai", vendorId: "vendor_meera", name: "Masala Chai", description: "Fresh ginger-cardamom tea served hot.", price: 20, photoUrl: "https://images.unsplash.com/photo-1561336526-2914f13ceb36?auto=format&fit=crop&w=800&q=80", category: "Tea", isAvailable: true },
    { id: "mi_samosa", vendorId: "vendor_meera", name: "Samosa", description: "Crisp potato samosa with green chutney.", price: 25, photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80", category: "Snacks", isAvailable: true }
  );
  orders.clear();
  notifications.clear();
  customers = [];
  pushSubscriptions = [];
}

export { app };

if (process.env.NODE_ENV !== "test") {
  await initialize();
  setInterval(() => {
    runOrderMaintenance().catch((maintenanceError) => console.error("Order maintenance failed", maintenanceError));
  }, 60 * 1000);
  server.listen(port, () => {
    console.log(`LocalServe API running on http://localhost:${port}`);
    console.log(`Seed storefront: ${publicAppUrl}/v/ravi-canteen`);
  });
}
