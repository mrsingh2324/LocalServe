import mongoose, { Schema } from "mongoose";

const orderLineSchema = new Schema(
  {
    menuItemId: { type: String, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    lineTotal: { type: Number, required: true }
  },
  { _id: false }
);

const vendorSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    locationTag: { type: String, required: true },
    phone: { type: String, required: true, unique: true, index: true },
    upiId: { type: String, required: true },
    qrUrl: { type: String, default: "" },
    passwordHash: { type: String, required: true },
    tokenVersion: { type: Number, default: 1 }
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

const menuItemSchema = new Schema(
  {
    _id: { type: String, required: true },
    vendorId: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 60 },
    description: { type: String, required: true, maxlength: 200 },
    price: { type: Number, required: true },
    photoUrl: { type: String, required: true },
    category: { type: String, required: true },
    isAvailable: { type: Boolean, default: true }
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

const orderSchema = new Schema(
  {
    _id: { type: String, required: true },
    vendorId: { type: String, required: true, index: true },
    orderCode: { type: String, required: true },
    customerEmail: { type: String, required: true },
    customerPhone: { type: String },
    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "PREPARING", "READY", "COLLECTED", "CANCELLED"],
      default: "PENDING"
    },
    items: { type: [orderLineSchema], required: true },
    totalAmount: { type: Number, required: true },
    paymentId: { type: String },
    createdAt: { type: Date, default: Date.now },
    readyAt: { type: Date }
  },
  { timestamps: { updatedAt: "updatedAt" } }
);

orderSchema.index({ vendorId: 1, orderCode: 1 }, { unique: true });
orderSchema.index({ vendorId: 1, createdAt: -1 });

const notificationSchema = new Schema(
  {
    _id: { type: String, required: true },
    vendorId: { type: String, required: true, index: true },
    orderId: { type: String, required: true, index: true },
    channel: { type: String, enum: ["email", "sms"], required: true },
    recipient: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, enum: ["QUEUED", "SENT", "FAILED"], default: "QUEUED" },
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    deliveredAt: { type: Date }
  },
  { timestamps: { updatedAt: "updatedAt" } }
);

notificationSchema.index({ vendorId: 1, orderId: 1 });

export const VendorModel = mongoose.model("Vendor", vendorSchema);
export const MenuItemModel = mongoose.model("MenuItem", menuItemSchema);
export const OrderModel = mongoose.model("Order", orderSchema);
export const NotificationModel = mongoose.model("Notification", notificationSchema);

export async function connectMongo(uri: string) {
  await mongoose.connect(uri, {
    autoIndex: true,
    serverSelectionTimeoutMS: 5000
  });
}
