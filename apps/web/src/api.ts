import type { Address, Customer, DayHours, Kyc, MenuItem, Order, OrderStatus, PublicVendor, Vendor } from "@localserve/shared-types";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

export function getStoredVendorToken() {
  return localStorage.getItem("localserve_vendor_token") ?? "";
}

export function setStoredVendorToken(token: string) {
  localStorage.setItem("localserve_vendor_token", token);
}

export function getStoredCustomerToken() {
  return localStorage.getItem("localserve_customer_token") ?? "";
}

export function setStoredCustomerToken(token: string) {
  localStorage.setItem("localserve_customer_token", token);
}

export function clearStoredCustomerToken() {
  localStorage.removeItem("localserve_customer_token");
}

export function getStoredAdminToken() {
  return localStorage.getItem("localserve_admin_token") ?? "";
}

export function setStoredAdminToken(token: string) {
  localStorage.setItem("localserve_admin_token", token);
}

export function clearStoredAdminToken() {
  localStorage.removeItem("localserve_admin_token");
}

function vendorAuthHeaders() {
  return { authorization: `Bearer ${getStoredVendorToken()}` };
}

function customerAuthHeaders() {
  return { authorization: `Bearer ${getStoredCustomerToken()}` };
}

function adminAuthHeaders() {
  return { authorization: `Bearer ${getStoredAdminToken()}` };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) {
    const raw = await response.text();
    let parsed: { error?: string; details?: { fieldErrors?: Record<string, string[]> } } | undefined;
    try {
      parsed = JSON.parse(raw) as { error?: string; details?: { fieldErrors?: Record<string, string[]> } };
    } catch {
      parsed = undefined;
    }
    const fieldMessage = parsed?.details?.fieldErrors
      ? Object.entries(parsed.details.fieldErrors)
          .flatMap(([field, messages]) => messages.map((message) => `${field}: ${message}`))
          .join("; ")
      : "";
    throw new Error(fieldMessage || parsed?.error || raw || "Request failed");
  }
  return response.json() as Promise<T>;
}

// ── Storefront ────────────────────────────────────────────────────────────────

export function getStorefront(slug: string) {
  return request<{
    vendor: PublicVendor & { deliveryEnabled: boolean; deliveryFeeFlat: number; isOpen: boolean; category: string; bannerUrl?: string; operatingHours?: DayHours[]; verified: boolean };
    menuItems: MenuItem[]
  }>(`/v/${slug}`);
}

// ── Shop Discovery ────────────────────────────────────────────────────────────

export type ShopSummary = {
  id: string;
  name: string;
  slug: string;
  locationTag: string;
  category: string;
  isOpen: boolean;
  deliveryEnabled: boolean;
  deliveryFeeFlat: number;
  storefrontUrl: string;
  bannerUrl?: string;
  verified: boolean;
  orderCount: number;
  createdAt: string;
};

export function getShops(params?: { category?: string; q?: string; deliveryOnly?: boolean }) {
  const qs = new URLSearchParams();
  if (params?.category) qs.set("category", params.category);
  if (params?.q) qs.set("q", params.q);
  if (params?.deliveryOnly) qs.set("deliveryOnly", "true");
  const query = qs.toString();
  return request<{ shops: ShopSummary[]; total: number }>(`/shops${query ? `?${query}` : ""}`);
}

// ── Vendor Auth ───────────────────────────────────────────────────────────────

export function registerVendor(payload: { name: string; phone: string; email?: string; locationTag: string; upiId: string; otpCode: string; password?: string }) {
  return request<{ vendor: Vendor; token: string }>("/vendor/register", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function requestVendorEmailOtp(email: string) {
  return request<{ status: string; channel: string; expiresInSeconds: number; devOtp?: string }>("/auth/vendor/email/otp/request", {
    method: "POST",
    body: JSON.stringify({ email })
  });
}

export function requestVendorEmailRegisterOtp(email: string) {
  return request<{ status: string; channel: string; expiresInSeconds: number; devOtp?: string }>("/auth/vendor/email/register/request", {
    method: "POST",
    body: JSON.stringify({ email })
  });
}

export function registerVendorByEmail(payload: { name: string; email: string; otpCode: string; locationTag: string; upiId: string; phone?: string }) {
  return request<{ vendor: Vendor; token: string }>("/vendor/register/email", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function verifyVendorEmailOtp(payload: { email: string; otpCode: string }) {
  return request<{ vendor: Vendor; token: string }>("/auth/vendor/email/otp/verify", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function requestVendorOtp(payload: { phone: string; purpose: "login" | "register" }) {
  return request<{ status: string; channel: string; expiresInSeconds: number; devOtp?: string }>("/auth/vendor/otp/request", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function verifyVendorOtp(payload: { phone: string; otpCode: string }) {
  return request<{ vendor: Vendor; token: string }>("/auth/vendor/otp/verify", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function loginVendor(payload: { phone: string; password: string }) {
  return request<{ vendor: Vendor; token: string }>("/auth/vendor/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getDemoVendors() {
  return request<{ vendors: Vendor[] }>("/demo-vendors");
}

export function getVendorMe() {
  return request<{ vendor: Vendor }>("/vendor/me", {
    headers: vendorAuthHeaders()
  });
}

export function updateVendorProfile(payload: {
  name: string;
  locationTag: string;
  upiId: string;
  email?: string;
  category?: string;
  isOpen?: boolean;
  deliveryEnabled?: boolean;
  deliveryFeeFlat?: number;
  bannerUrl?: string;
  operatingHours?: DayHours[];
  acceptWindowMinutes?: number;
}) {
  return request<{ vendor: Vendor }>("/vendor/profile", {
    method: "PATCH",
    headers: vendorAuthHeaders(),
    body: JSON.stringify(payload)
  });
}

// ── Customer Auth ─────────────────────────────────────────────────────────────

export function requestCustomerOtp(phone: string) {
  return request<{ status: string; channel: string; expiresInSeconds: number; devOtp?: string }>("/auth/customer/otp/request", {
    method: "POST",
    body: JSON.stringify({ phone })
  });
}

export function verifyCustomerOtp(payload: { phone: string; otpCode: string; name?: string; email?: string }) {
  return request<{ customer: Customer; token: string; isNew: boolean }>("/auth/customer/otp/verify", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function requestCustomerEmailOtp(email: string) {
  return request<{ status: string; channel: string; expiresInSeconds: number; devOtp?: string }>("/auth/customer/email/otp/request", {
    method: "POST",
    body: JSON.stringify({ email })
  });
}

export function verifyCustomerEmailOtp(payload: { email: string; otpCode: string; name?: string }) {
  return request<{ customer: Customer; token: string; isNew: boolean }>("/auth/customer/email/otp/verify", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getCustomerMe() {
  return request<{ customer: Customer }>("/customer/me", {
    headers: customerAuthHeaders()
  });
}

export function updateCustomerProfile(payload: { name: string; email?: string }) {
  return request<{ customer: Customer }>("/customer/profile", {
    method: "PATCH",
    headers: customerAuthHeaders(),
    body: JSON.stringify(payload)
  });
}

export function addCustomerAddress(payload: { label: string; line1: string; city: string; pincode: string }) {
  return request<{ address: Address }>("/customer/addresses", {
    method: "POST",
    headers: customerAuthHeaders(),
    body: JSON.stringify(payload)
  });
}

export function deleteCustomerAddress(id: string) {
  return request<void>(`/customer/addresses/${id}`, {
    method: "DELETE",
    headers: customerAuthHeaders()
  });
}

export function getCustomerOrders() {
  return request<{ orders: (Order & { vendorName: string; vendorSlug: string })[] }>("/customer/orders", {
    headers: customerAuthHeaders()
  });
}

// ── Orders ────────────────────────────────────────────────────────────────────

export function createOrder(payload: {
  vendorSlug: string;
  customerEmail: string;
  customerPhone?: string;
  customerId?: string;
  orderType: "pickup" | "delivery";
  deliveryAddress?: { line1: string; city: string; pincode: string };
  paymentMethod: "online" | "cash";
  items: { menuItemId: string; quantity: number }[];
}) {
  return request<{
    order: Order;
    orderUrl: string;
    payment: { mode: string; status: string; provider: string; keyId?: string; orderId?: string; amount?: number; currency?: string };
  }>("/orders", {
    method: "POST",
    headers: getStoredCustomerToken() ? customerAuthHeaders() : {},
    body: JSON.stringify(payload)
  });
}

export function confirmOrderPayment(
  id: string,
  payload: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
) {
  return request<{ order: Order; orderUrl: string }>(`/orders/${id}/confirm`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function cancelOrder(id: string) {
  const token = getStoredCustomerToken() || getStoredVendorToken();
  return request<{ order: Order; refundId?: string }>(`/orders/${id}/cancel`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
}

export function getOrder(id: string) {
  return request<{ order: Order; vendor: { name: string; locationTag: string } }>(`/orders/${id}`);
}

// ── Vendor Orders & Menu ──────────────────────────────────────────────────────

export function getVendorOrders() {
  return request<{ orders: Order[] }>("/vendor/orders", {
    headers: vendorAuthHeaders()
  });
}

export function updateOrderStatus(id: string, status: OrderStatus) {
  return request<{ order: Order; notification?: { channel: string; to: string; message: string } }>(
    `/orders/${id}/status`,
    {
      method: "PATCH",
      headers: vendorAuthHeaders(),
      body: JSON.stringify({ status })
    }
  );
}

export function getVendorQr() {
  return request<{ vendor: Vendor }>("/vendor/qr", {
    headers: vendorAuthHeaders()
  });
}

export function getVendorMenu() {
  return request<{ menuItems: MenuItem[] }>("/vendor/menu", {
    headers: vendorAuthHeaders()
  });
}

export function createMenuItem(payload: Omit<MenuItem, "id" | "vendorId">) {
  return request<{ menuItem: MenuItem }>("/vendor/menu", {
    method: "POST",
    headers: vendorAuthHeaders(),
    body: JSON.stringify(payload)
  });
}

export function updateMenuItem(id: string, payload: Partial<MenuItem>) {
  return request<{ menuItem: MenuItem }>(`/vendor/menu/${id}`, {
    method: "PATCH",
    headers: vendorAuthHeaders(),
    body: JSON.stringify(payload)
  });
}

export async function uploadMenuItemPhoto(id: string, file: File) {
  const formData = new FormData();
  formData.append("photo", file);
  const response = await fetch(`${API_URL}/vendor/menu/${id}/photo`, {
    method: "POST",
    headers: vendorAuthHeaders(),
    body: formData
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<{ menuItem: MenuItem }>;
}

export async function uploadVendorBanner(file: File) {
  const formData = new FormData();
  formData.append("banner", file);
  const response = await fetch(`${API_URL}/vendor/banner`, {
    method: "POST",
    headers: vendorAuthHeaders(),
    body: formData
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<{ vendor: Vendor }>;
}

export function deleteMenuItem(id: string) {
  return request<void>(`/vendor/menu/${id}`, {
    method: "DELETE",
    headers: vendorAuthHeaders()
  });
}

export function getDashboard() {
  return request<{ totalOrders: number; revenue: number; pendingSettlement: number; recentOrders: Order[] }>("/vendor/dashboard", {
    headers: vendorAuthHeaders()
  });
}

// ── Vendor KYC ────────────────────────────────────────────────────────────────

export function submitVendorKyc(payload: { ownerName: string; gstin?: string }) {
  return request<{ vendor: Vendor }>("/vendor/kyc", {
    method: "POST",
    headers: vendorAuthHeaders(),
    body: JSON.stringify(payload)
  });
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export type AdminVendor = {
  id: string;
  name: string;
  slug: string;
  phone: string;
  locationTag: string;
  category: string;
  kyc: Kyc;
  isOpen: boolean;
  deliveryEnabled: boolean;
  orderCount: number;
  revenue: number;
};

export type AdminMetrics = {
  totalVendors: number;
  verifiedVendors: number;
  pendingKyc: number;
  totalCustomers: number;
  totalOrders: number;
  activeOrders: number;
  collectedRevenue: number;
  grossOrderValue: number;
};

export function adminLogin(payload: { email: string; password: string }) {
  return request<{ token: string; email: string }>("/auth/admin/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getAdminVendors() {
  return request<{ vendors: AdminVendor[] }>("/admin/vendors", {
    headers: adminAuthHeaders()
  });
}

export function verifyVendor(id: string, payload: { status: "VERIFIED" | "REJECTED"; rejectionReason?: string }) {
  return request<{ vendor: Vendor }>(`/admin/vendors/${id}/verify`, {
    method: "PATCH",
    headers: adminAuthHeaders(),
    body: JSON.stringify(payload)
  });
}

export function getAdminMetrics() {
  return request<AdminMetrics>("/admin/metrics", {
    headers: adminAuthHeaders()
  });
}

export function getAdminOrders() {
  return request<{ orders: (Order & { vendorName: string })[] }>("/admin/orders", {
    headers: adminAuthHeaders()
  });
}

// ── Web Push ──────────────────────────────────────────────────────────────────

export function getVapidPublicKey() {
  return request<{ key: string | null }>("/push/vapid-public-key");
}

export function subscribeToPush(payload: {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  orderId?: string;
  customerId?: string;
}) {
  return request<{ ok: boolean }>("/push/subscribe", {
    method: "POST",
    headers: getStoredCustomerToken() ? customerAuthHeaders() : {},
    body: JSON.stringify(payload)
  });
}
