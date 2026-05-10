import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import jwt from "jsonwebtoken";
import morgan from "morgan";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { Server } from "socket.io";
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
const vendorToken = process.env.DEV_VENDOR_TOKEN ?? "dev-vendor-token";
const jwtSecret = process.env.JWT_SECRET ?? "localserve-dev-secret-change-me";
const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "localserve-dev-webhook-secret";
const dataFile = path.resolve(process.cwd(), "data/localserve.json");
const useMongo = process.env.NODE_ENV !== "test" && (process.env.USE_MONGO === "true" || process.env.USE_MONGO === "1");
const mongoUri = process.env.MONGODB_URI ?? "mongodb://localserve:localserve@localhost:27017/localserve?authSource=admin";

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

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsOrigin = (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
  if (!origin) {
    callback(null, true);
    return;
  }
  const isAllowed = allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === "*") return true;
    if (allowedOrigin === origin) return true;
    if (!allowedOrigin.includes("*")) return false;
    const pattern = new RegExp(`^${allowedOrigin.split("*").map(escapeRegExp).join(".*")}$`);
    return pattern.test(origin);
  });
  callback(isAllowed ? null : new Error(`Origin ${origin} is not allowed by CORS`), isAllowed);
};
const io = new Server(server, {
  cors: { origin: corsOrigin }
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
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: corsOrigin }));
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/['']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
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
  let code = "";
  do {
    code =
      letters[Math.floor(Math.random() * letters.length)] +
      letters[Math.floor(Math.random() * letters.length)] +
      String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  } while ([...orders.values()].some((order) => order.vendorId === vendorId && order.orderCode === code));
  return code;
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

function queueReadyNotification(order: Order) {
  const vendor = getVendorById(order.vendorId);
  const notification: NotificationRecord = {
    id: crypto.randomUUID(),
    vendorId: order.vendorId,
    orderId: order.id,
    channel: "email",
    recipient: order.customerEmail,
    subject: `Order #${order.orderCode} is ready`,
    body: `Your order from ${vendor?.name ?? "LocalServe"} is ready for pickup. Show code ${order.orderCode} at the counter.`,
    status: "SENT",
    attempts: 1,
    createdAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString()
  };
  notifications.set(notification.id, notification);
  return notification;
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

app.post("/auth/vendor/login", authLimiter, asyncHandler(async (req, res) => {
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
  const slug = slugify(body.name);
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
    slug: slugify(body.name),
    locationTag: body.locationTag,
    upiId: body.upiId,
    storefrontUrl: `${publicAppUrl}/v/${slugify(body.name)}`
  });
  await persistState();
  res.json({ vendor: await buildVendorResponse(vendor) });
}));

app.post("/payments/razorpay/webhook", (req, res) => {
  const signature = req.header("x-razorpay-signature");
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
  const expected = crypto.createHmac("sha256", razorpayWebhookSecret).update(rawBody).digest("hex");
  const received = Buffer.from(signature ?? "");
  const expectedBuffer = Buffer.from(expected);
  if (!signature || received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) {
    res.status(401).json({ error: "Invalid Razorpay signature" });
    return;
  }
  res.json({ received: true });
});

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

  const order: Order = {
    id: crypto.randomUUID(),
    vendorId: vendor.id,
    orderCode: generateOrderCode(vendor.id),
    customerEmail: body.customerEmail,
    customerPhone: body.customerPhone,
    status: "CONFIRMED",
    items: lines,
    totalAmount: lines.reduce((sum, line) => sum + line.lineTotal, 0),
    paymentId: `pay_test_${crypto.randomBytes(6).toString("hex")}`,
    createdAt: new Date().toISOString()
  };

  orders.set(order.id, order);
  await persistState();
  io.to(`vendor:${vendor.id}`).emit("new_order", order);
  io.to(`order:${order.id}`).emit("order_updated", order);
  res.status(201).json({ order, payment: { mode: "test", status: "captured", provider: "razorpay-test" }, orderUrl: `${publicAppUrl}/order/${order.id}` });
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
  const notification = status === "READY" ? queueReadyNotification(updated) : undefined;
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
  const revenue = allOrders.filter((order) => order.status !== "CANCELLED").reduce((sum, order) => sum + order.totalAmount, 0);
  res.json({ totalOrders: allOrders.length, revenue, recentOrders: allOrders.slice(0, 5) });
});

app.get("/vendor/notifications", requireVendor, (req, res) => {
  const vendor = getAuthedVendor(req);
  const vendorNotifications = [...notifications.values()].filter((notification) => notification.vendorId === vendor?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ notifications: vendorNotifications });
});

io.on("connection", (socket) => {
  socket.on("join_vendor", (payload: { token: string }) => {
    if (payload.token === vendorToken) {
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
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.flatten() });
    return;
  }
  const status = typeof error === "object" && error && "status" in error && typeof error.status === "number" ? error.status : 500;
  const message = error instanceof Error ? error.message : "Internal server error";
  res.status(status).json({ error: status >= 500 ? "Internal server error" : message });
});

export async function initialize() {
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
