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
import { z, ZodError } from "zod";
import {
  MenuItemModel,
  NotificationModel,
  OrderModel,
  VendorModel,
  connectMongo
} from "./models.js";
import type { MenuItem, Order, OrderLine, OrderStatus, Vendor } from "@localserve/shared-types";

type StoredVendor = Vendor & { passwordHash: string };
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
const smtpSecure = process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === "1";
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
      auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined
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
    passwordHash: demoPasswordHash
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
    passwordHash: demoPasswordHash
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

const createOrderBodySchema = z.object({
  vendorSlug: z.string(),
  customerEmail: z.string().email(),
  customerPhone: z.string().optional(),
  items: z.array(z.object({ menuItemId: z.string(), quantity: z.number().int().positive() })).min(1)
});
const menuItemBodySchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  price: z.number().nonnegative(),
  photoUrl: z.string().url(),
  category: z.string().min(1),
  isAvailable: z.boolean().default(true)
});
const vendorRegistrationSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(10).max(15),
  locationTag: z.string().min(2).max(120),
  upiId: z.string().min(3).max(80),
  otpCode: z.string().min(4).max(8),
  password: z.string().min(6).default("demo123")
});
const vendorProfileSchema = z.object({
  name: z.string().min(2).max(120),
  locationTag: z.string().min(2).max(120),
  upiId: z.string().min(3).max(80)
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
const paymentConfirmationSchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string()
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

function getVendorBySlug(slug: string) {
  return vendors.find((candidate) => candidate.slug === slug);
}

function getVendorById(id: string) {
  return vendors.find((candidate) => candidate.id === id);
}

function ensureDemoSeeds() {
  const requiredVendors = [
    { id: "vendor_ravi", name: "Ravi's Canteen", slug: "ravi-canteen", locationTag: "Office Block B, Ground Floor", phone: "+919876543210", upiId: "ravi@upi" },
    { id: "vendor_meera", name: "Meera Tea Point", slug: "meera-tea-point", locationTag: "Tower A Lobby", phone: "+919812345670", upiId: "meera@upi" }
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
}

function publicVendor(vendor: StoredVendor): Vendor {
  return { ...vendor, passwordHash: undefined, storefrontUrl: `${publicAppUrl}/v/${vendor.slug}` } as Vendor;
}

function otpKey(phone: string, purpose: "login" | "register") {
  return `${purpose}:${phone}`;
}

function hashOtp(phone: string, purpose: "login" | "register", code: string) {
  return crypto.createHmac("sha256", jwtSecret).update(`${purpose}:${phone}:${code}`).digest("hex");
}

function createOtpCode() {
  if (process.env.NODE_ENV !== "production") return otpDevCode;
  if (!twilioClient) throw Object.assign(new Error("Twilio is not configured for production OTP delivery"), { status: 503 });
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function setOtpChallenge(phone: string, purpose: "login" | "register", challenge: { codeHash: string; expiresAt: number; attempts: number }) {
  const key = otpKey(phone, purpose);
  if (redisClient?.status === "ready") {
    await redisClient.set(key, JSON.stringify(challenge), "PX", otpTtlMs);
    return;
  }
  otpChallenges.set(key, challenge);
}

async function getOtpChallenge(phone: string, purpose: "login" | "register") {
  const key = otpKey(phone, purpose);
  if (redisClient?.status === "ready") {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) as { codeHash: string; expiresAt: number; attempts: number } : undefined;
  }
  return otpChallenges.get(key);
}

async function deleteOtpChallenge(phone: string, purpose: "login" | "register") {
  const key = otpKey(phone, purpose);
  if (redisClient?.status === "ready") {
    await redisClient.del(key);
    return;
  }
  otpChallenges.delete(key);
}

async function updateOtpChallenge(phone: string, purpose: "login" | "register", challenge: { codeHash: string; expiresAt: number; attempts: number }) {
  if (redisClient?.status === "ready") {
    await redisClient.set(otpKey(phone, purpose), JSON.stringify(challenge), "PX", Math.max(challenge.expiresAt - Date.now(), 1));
    return;
  }
  otpChallenges.set(otpKey(phone, purpose), challenge);
}

async function sendOtp(phone: string, purpose: "login" | "register") {
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
      body: `Your LocalServe ${purpose} OTP is ${code}. It expires in ${Math.round(otpTtlMs / 60000)} minutes.`
    });
  }

  return code;
}

async function verifyOtp(phone: string, purpose: "login" | "register", code: string) {
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

function vendorMenu(vendorId: string, availableOnly = false) {
  return menuItems.filter((item) => item.vendorId === vendorId && (!availableOnly || item.isAvailable));
}

function vendorOrders(vendorId: string) {
  return [...orders.values()].filter((order) => order.vendorId === vendorId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    body: `Your order from ${vendor?.name ?? "LocalServe"} is ready for pickup. Show code ${order.orderCode} at the counter.`,
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
    const [dbVendors, dbMenuItems, dbOrders, dbNotifications] = await Promise.all([
      VendorModel.find().lean(),
      MenuItemModel.find().lean(),
      OrderModel.find().lean(),
      NotificationModel.find().lean()
    ]);
    if (dbVendors.length) {
      vendors = dbVendors.map((vendor) => ({
        id: String(vendor._id),
        name: vendor.name,
        slug: vendor.slug,
        locationTag: vendor.locationTag,
        phone: vendor.phone,
        upiId: vendor.upiId,
        qrUrl: vendor.qrUrl ?? "",
        storefrontUrl: `${publicAppUrl}/v/${vendor.slug}`,
        passwordHash: vendor.passwordHash ?? demoPasswordHash
      }));
      menuItems = dbMenuItems.map((item) => ({
        id: String(item._id),
        vendorId: item.vendorId,
        name: item.name,
        description: item.description,
        price: item.price,
        photoUrl: item.photoUrl,
        category: item.category,
        isAvailable: item.isAvailable
      }));
      orders.clear();
      for (const order of dbOrders) {
        orders.set(String(order._id), {
          id: String(order._id),
          vendorId: order.vendorId,
          orderCode: order.orderCode,
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone ?? undefined,
          status: order.status as OrderStatus,
          items: order.items as unknown as OrderLine[],
          totalAmount: order.totalAmount,
          paymentId: order.paymentId ?? undefined,
          paymentOrderId: order.paymentOrderId ?? undefined,
          createdAt: order.createdAt.toISOString(),
          readyAt: order.readyAt?.toISOString()
        });
      }
      notifications.clear();
      for (const notification of dbNotifications) {
        notifications.set(String(notification._id), {
          id: String(notification._id),
          vendorId: notification.vendorId,
          orderId: notification.orderId,
          channel: notification.channel as "email" | "sms",
          recipient: notification.recipient,
          subject: notification.subject,
          body: notification.body,
          status: notification.status as "QUEUED" | "SENT" | "FAILED",
          attempts: notification.attempts,
          createdAt: notification.createdAt.toISOString(),
          deliveredAt: notification.deliveredAt?.toISOString()
        });
      }
      ensureDemoSeeds();
      return;
    }
  }

  try {
    const parsed = JSON.parse(await fs.readFile(dataFile, "utf8")) as StoredState;
    if (parsed.vendors?.length) {
      vendors = parsed.vendors.map((vendor) => ({ ...vendor, storefrontUrl: `${publicAppUrl}/v/${vendor.slug}` }));
    } else if (parsed.vendor) {
      vendors = [{ ...parsed.vendor, passwordHash: demoPasswordHash, storefrontUrl: `${publicAppUrl}/v/${parsed.vendor.slug}` }];
    }
    menuItems = parsed.menuItems ?? menuItems;
    orders.clear();
    for (const order of parsed.orders ?? []) orders.set(order.id, order);
    notifications.clear();
    for (const notification of parsed.notifications ?? []) notifications.set(notification.id, notification);
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
        { $set: { name: vendor.name, slug: vendor.slug, phone: vendor.phone, locationTag: vendor.locationTag, upiId: vendor.upiId, qrUrl: vendor.qrUrl, passwordHash: vendor.passwordHash } },
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
    return;
  }

  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, JSON.stringify({ vendors, menuItems, orders: [...orders.values()], notifications: [...notifications.values()] }, null, 2));
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "localserve-api", storage: useMongo ? "mongoose-mongodb" : "local-json", realtime: "socket.io" });
});

app.get("/demo-vendors", asyncHandler(async (_req, res) => {
  res.json({ vendors: await Promise.all(vendors.map(buildVendorResponse)) });
}));

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
  const slug = uniqueSlug(body.name);
  const vendor: StoredVendor = {
    id: crypto.randomUUID(),
    passwordHash: bcrypt.hashSync(body.password, 10),
    qrUrl: "",
    name: body.name,
    slug,
    phone: body.phone,
    locationTag: body.locationTag,
    upiId: body.upiId,
    storefrontUrl: `${publicAppUrl}/v/${slug}`
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
  Object.assign(vendor, {
    name: body.name,
    locationTag: body.locationTag,
    upiId: body.upiId,
    storefrontUrl: `${publicAppUrl}/v/${vendor.slug}`
  });
  await persistState();
  res.json({ vendor: await buildVendorResponse(vendor) });
}));

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

app.get("/v/:vendorSlug", asyncHandler(async (req, res) => {
  const vendor = getVendorBySlug(req.params.vendorSlug);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  res.json({ vendor: await buildVendorResponse(vendor), menuItems: vendorMenu(vendor.id, true) });
}));

app.post("/orders", asyncHandler(async (req, res) => {
  const body = createOrderBodySchema.parse(req.body);
  const vendor = getVendorBySlug(body.vendorSlug);
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }

  const lines: OrderLine[] = body.items.map((cartItem) => {
    const menuItem = menuItems.find((item) => item.vendorId === vendor.id && item.id === cartItem.menuItemId && item.isAvailable);
    if (!menuItem) throw Object.assign(new Error(`Menu item unavailable: ${cartItem.menuItemId}`), { status: 400 });
    return { menuItemId: menuItem.id, name: menuItem.name, quantity: cartItem.quantity, unitPrice: menuItem.price, lineTotal: menuItem.price * cartItem.quantity };
  });

  const totalAmount = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const order: Order = {
    id: crypto.randomUUID(),
    vendorId: vendor.id,
    orderCode: generateOrderCode(vendor.id),
    customerEmail: body.customerEmail,
    customerPhone: body.customerPhone,
    status: razorpayClient ? "PENDING" : "CONFIRMED",
    items: lines,
    totalAmount,
    paymentId: razorpayClient ? undefined : `pay_test_${crypto.randomBytes(6).toString("hex")}`,
    createdAt: new Date().toISOString()
  };

  let razorpayOrder: { id: string; amount: number; currency: string } | undefined;
  if (razorpayClient) {
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
  await persistState();
  if (!razorpayClient) {
    io.to(`vendor:${vendor.id}`).emit("new_order", order);
    io.to(`order:${order.id}`).emit("order_updated", order);
  }
  res.status(201).json({
    order,
    payment: razorpayOrder
      ? { mode: "live", status: "created", provider: "razorpay", keyId: razorpayKeyId, orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency }
      : { mode: "test", status: "captured", provider: "razorpay-test" },
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

  const updated: Order = { ...order, status, readyAt: status === "READY" ? new Date().toISOString() : order.readyAt };
  orders.set(updated.id, updated);
  const notification = status === "READY" ? await queueReadyNotification(updated) : undefined;
  await persistState();
  io.to(`vendor:${vendor.id}`).emit("order_updated", updated);
  io.to(`order:${updated.id}`).emit(status === "READY" ? "order_ready" : "order_updated", updated);
  res.json({ order: updated, notification: notification ? { channel: notification.channel, to: notification.recipient, message: notification.body } : undefined });
}));

app.get("/vendor/orders", requireVendor, (req, res) => {
  const vendor = getAuthedVendor(req);
  res.json({ orders: vendor ? vendorOrders(vendor.id) : [] });
});

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
  doc.moveDown();
  doc.fontSize(14).text(`Total: Rs. ${order.totalAmount}`, { align: "right" });
  doc.moveDown();
  doc.fontSize(10).fillColor("#555").text(`Payment: ${order.paymentId ?? "N/A"}`);
  doc.text(`Status: ${order.status}`);
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

app.get("/vendor/dashboard", requireVendor, (req, res) => {
  const vendor = getAuthedVendor(req);
  const allOrders = vendor ? vendorOrders(vendor.id) : [];
  const revenue = allOrders.filter((order) => order.status === "COLLECTED").reduce((sum, order) => sum + order.totalAmount, 0);
  const pendingSettlement = allOrders
    .filter((order) => ["CONFIRMED", "PREPARING", "READY"].includes(order.status))
    .reduce((sum, order) => sum + order.totalAmount, 0);
  res.json({ totalOrders: allOrders.length, revenue, pendingSettlement, recentOrders: allOrders.slice(0, 5) });
});

app.get("/vendor/notifications", requireVendor, (req, res) => {
  const vendor = getAuthedVendor(req);
  const vendorNotifications = [...notifications.values()].filter((notification) => notification.vendorId === vendor?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ notifications: vendorNotifications });
});

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
}

export function resetLocalState() {
  vendors = [
    { id: "vendor_ravi", name: "Ravi's Canteen", slug: "ravi-canteen", locationTag: "Office Block B, Ground Floor", phone: "+919876543210", upiId: "ravi@upi", qrUrl: "", storefrontUrl: `${publicAppUrl}/v/ravi-canteen`, passwordHash: demoPasswordHash },
    { id: "vendor_meera", name: "Meera Tea Point", slug: "meera-tea-point", locationTag: "Tower A Lobby", phone: "+919812345670", upiId: "meera@upi", qrUrl: "", storefrontUrl: `${publicAppUrl}/v/meera-tea-point`, passwordHash: demoPasswordHash }
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
}

export { app };

if (process.env.NODE_ENV !== "test") {
  await initialize();
  server.listen(port, () => {
    console.log(`LocalServe API running on http://localhost:${port}`);
    console.log(`Seed storefront: ${publicAppUrl}/v/ravi-canteen`);
  });
}
