import type { MenuItem, Order, OrderStatus, Vendor } from "@localserve/shared-types";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

export function getStoredVendorToken() {
  return localStorage.getItem("localserve_vendor_token") ?? "";
}

export function setStoredVendorToken(token: string) {
  localStorage.setItem("localserve_vendor_token", token);
}

function authHeaders() {
  return { authorization: `Bearer ${getStoredVendorToken()}` };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export function getStorefront(slug: string) {
  return request<{ vendor: Vendor; menuItems: MenuItem[] }>(`/v/${slug}`);
}

export function registerVendor(payload: { name: string; phone: string; locationTag: string; upiId: string; otpCode: string; password?: string }) {
  return request<{ vendor: Vendor; token: string }>("/vendor/register", {
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
    headers: authHeaders()
  });
}

export function updateVendorProfile(payload: { name: string; locationTag: string; upiId: string }) {
  return request<{ vendor: Vendor }>("/vendor/profile", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}

export function createOrder(payload: {
  vendorSlug: string;
  customerEmail: string;
  customerPhone?: string;
  items: { menuItemId: string; quantity: number }[];
}) {
  return request<{
    order: Order;
    orderUrl: string;
    payment: { mode: string; status: string; provider: string; keyId?: string; orderId?: string; amount?: number; currency?: string };
  }>("/orders", {
    method: "POST",
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

export function getOrder(id: string) {
  return request<{ order: Order; vendor: { name: string; locationTag: string } }>(`/orders/${id}`);
}

export function getVendorOrders() {
  return request<{ orders: Order[] }>("/vendor/orders", {
    headers: authHeaders()
  });
}

export function updateOrderStatus(id: string, status: OrderStatus) {
  return request<{ order: Order; notification?: { channel: string; to: string; message: string } }>(
    `/orders/${id}/status`,
    {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ status })
    }
  );
}

export function getVendorQr() {
  return request<{ vendor: Vendor }>("/vendor/qr", {
    headers: authHeaders()
  });
}

export function getVendorMenu() {
  return request<{ menuItems: MenuItem[] }>("/vendor/menu", {
    headers: authHeaders()
  });
}

export function createMenuItem(payload: Omit<MenuItem, "id" | "vendorId">) {
  return request<{ menuItem: MenuItem }>("/vendor/menu", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}

export function updateMenuItem(id: string, payload: Partial<MenuItem>) {
  return request<{ menuItem: MenuItem }>(`/vendor/menu/${id}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}

export async function uploadMenuItemPhoto(id: string, file: File) {
  const formData = new FormData();
  formData.append("photo", file);
  const response = await fetch(`${API_URL}/vendor/menu/${id}/photo`, {
    method: "POST",
    headers: authHeaders(),
    body: formData
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<{ menuItem: MenuItem }>;
}

export function deleteMenuItem(id: string) {
  return request<void>(`/vendor/menu/${id}`, {
    method: "DELETE",
    headers: authHeaders()
  });
}

export function getDashboard() {
  return request<{ totalOrders: number; revenue: number; pendingSettlement: number; recentOrders: Order[] }>("/vendor/dashboard", {
    headers: authHeaders()
  });
}
