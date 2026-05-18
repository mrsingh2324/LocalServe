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

const deliveryAddressSchema = new Schema(
  {
    line1: { type: String, required: true },
    city: { type: String, required: true },
    pincode: { type: String, required: true }
  },
  { _id: false }
);

const savedAddressSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    line1: { type: String, required: true },
    city: { type: String, required: true },
    pincode: { type: String, required: true }
  },
  { _id: false }
);

const dayHoursSchema = new Schema(
  {
    closed: { type: Boolean, default: false },
    open: { type: String, default: "09:00" },
    close: { type: String, default: "21:00" }
  },
  { _id: false }
);

const kycSchema = new Schema(
  {
    ownerName: { type: String, required: true },
    gstin: { type: String },
    status: { type: String, enum: ["UNSUBMITTED", "PENDING", "VERIFIED", "REJECTED"], default: "PENDING" },
    rejectionReason: { type: String },
    submittedAt: { type: String },
    reviewedAt: { type: String }
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
    email: { type: String, index: true },
    upiId: { type: String, required: true },
    qrUrl: { type: String, default: "" },
    passwordHash: { type: String, required: true },
    tokenVersion: { type: Number, default: 1 },
    category: { type: String, default: "General Store" },
    isOpen: { type: Boolean, default: true },
    deliveryEnabled: { type: Boolean, default: false },
    deliveryFeeFlat: { type: Number, default: 0 },
    bannerUrl: { type: String },
    operatingHours: { type: [dayHoursSchema], default: undefined },
    acceptWindowMinutes: { type: Number, default: 15 },
    kyc: { type: kycSchema, default: undefined }
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

const pushSubscriptionSchema = new Schema(
  {
    _id: { type: String, required: true },
    orderId: { type: String, index: true },
    customerId: { type: String, index: true },
    endpoint: { type: String, required: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: { updatedAt: "updatedAt" } }
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
    isAvailable: { type: Boolean, default: true },
    stockQuantity: { type: Number }
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
    customerId: { type: String, index: true },
    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "PREPARING", "READY", "COLLECTED", "CANCELLED"],
      default: "PENDING"
    },
    orderType: { type: String, enum: ["pickup", "delivery"], default: "pickup" },
    deliveryAddress: { type: deliveryAddressSchema },
    deliveryFee: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ["online", "cash"], default: "online" },
    items: { type: [orderLineSchema], required: true },
    totalAmount: { type: Number, required: true },
    paymentId: { type: String },
    paymentOrderId: { type: String, index: true },
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

const customerSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, index: true, unique: true, sparse: true },
    email: { type: String, index: true, sparse: true },
    addresses: { type: [savedAddressSchema], default: [] }
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

export const VendorModel = mongoose.model("Vendor", vendorSchema);
export const MenuItemModel = mongoose.model("MenuItem", menuItemSchema);
export const OrderModel = mongoose.model("Order", orderSchema);
export const NotificationModel = mongoose.model("Notification", notificationSchema);
export const CustomerModel = mongoose.model("Customer", customerSchema);
export const PushSubscriptionModel = mongoose.model("PushSubscription", pushSubscriptionSchema);

export async function connectMongo(uri: string) {
  await mongoose.connect(uri, {
    autoIndex: true,
    serverSelectionTimeoutMS: 5000
  });
}
