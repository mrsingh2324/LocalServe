import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import type { Address, Customer, DayHours, MenuItem, Order, OrderStatus, Vendor } from "@localserve/shared-types";
import {
  API_URL,
  type AdminMetrics,
  type AdminVendor,
  type ShopSummary,
  addCustomerAddress,
  adminLogin,
  cancelOrder,
  clearStoredAdminToken,
  clearStoredCustomerToken,
  confirmOrderPayment,
  createMenuItem,
  createOrder,
  deleteCustomerAddress,
  deleteMenuItem,
  getAdminMetrics,
  getAdminOrders,
  getAdminVendors,
  getDashboard,
  getDemoVendors,
  getCustomerMe,
  getCustomerOrders,
  getOrder,
  getShops,
  getStoredAdminToken,
  getStoredCustomerToken,
  getStoredVendorToken,
  getStorefront,
  getVapidPublicKey,
  getVendorMe,
  getVendorMenu,
  getVendorOrders,
  getVendorQr,
  registerVendor,
  requestCustomerEmailOtp,
  requestCustomerOtp,
  requestVendorEmailOtp,
  requestVendorOtp,
  setStoredAdminToken,
  setStoredCustomerToken,
  setStoredVendorToken,
  submitVendorKyc,
  subscribeToPush,
  updateCustomerProfile,
  updateMenuItem,
  updateOrderStatus,
  updateVendorProfile,
  uploadMenuItemPhoto,
  verifyCustomerEmailOtp,
  verifyCustomerOtp,
  verifyVendor,
  verifyVendorEmailOtp,
  verifyVendorOtp
} from "./api";
import { buildCartLines, useCartStore } from "./cartStore";
import "./styles.css";

const socket = io(API_URL, { autoConnect: true });

const SHOP_CATEGORIES = [
  "All",
  "Food & Snacks",
  "Tea & Coffee",
  "Grocery",
  "General Store",
  "Bakery",
  "Pharmacy",
  "Stationery",
  "Electronics",
  "Other"
];

const CATEGORY_EMOJIS: Record<string, string> = {
  "All": "🛍️",
  "Food & Snacks": "🍔",
  "Tea & Coffee": "☕",
  "Grocery": "🥦",
  "General Store": "🏪",
  "Bakery": "🥐",
  "Pharmacy": "💊",
  "Stationery": "✏️",
  "Electronics": "📱",
  "Other": "📦"
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function defaultOperatingHours(): DayHours[] {
  return Array.from({ length: 7 }, () => ({ closed: false, open: "09:00", close: "21:00" }));
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-razorpay-checkout]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load Razorpay checkout")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.dataset.razorpayCheckout = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Razorpay checkout"));
    document.body.appendChild(script);
  });
}

async function openRazorpayCheckout(options: {
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  email: string;
  phone: string;
  onSuccess: (payload: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => Promise<void>;
}) {
  await loadRazorpayScript();
  await new Promise<void>((resolve, reject) => {
    if (!window.Razorpay) {
      reject(new Error("Razorpay checkout unavailable"));
      return;
    }
    const checkout = new window.Razorpay({
      key: options.keyId,
      amount: options.amount,
      currency: options.currency,
      name: options.name,
      order_id: options.orderId,
      prefill: { email: options.email, contact: options.phone },
      handler: async (payload: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        try {
          await options.onSuccess(payload);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      modal: {
        ondismiss: () => reject(new Error("Payment cancelled"))
      }
    });
    checkout.open();
  });
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(Array.from(raw, (char) => char.charCodeAt(0)));
}

async function enablePushForOrder(orderId: string, customerId?: string) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push notifications are not supported in this browser");
  }
  const { key } = await getVapidPublicKey();
  if (!key) throw new Error("Push notifications are not configured on the server");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was denied");
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    });
  }
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Could not read push subscription");
  }
  await subscribeToPush({
    subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    orderId,
    customerId
  });
}

// ── Skeleton Components ───────────────────────────────────────────────────────

function ShopCardSkeleton() {
  return (
    <div className="shop-card-skel" aria-hidden="true">
      <div className="skeleton skel-banner" />
      <div className="skel-body">
        <div className="skel-row">
          <div className="skeleton skel-line skel-sm" />
          <div className="skeleton skel-badge" />
        </div>
        <div className="skeleton skel-title skel-xl" />
        <div className="skeleton skel-line skel-md" />
        <div className="skeleton skel-badge" style={{ width: 100 }} />
      </div>
    </div>
  );
}

function MenuCardSkeleton() {
  return (
    <div className="menu-card-skel" aria-hidden="true">
      <div className="skeleton skel-img-43" />
      <div className="skel-menu-body">
        <div className="skeleton skel-line skel-xs" />
        <div className="skeleton skel-title skel-lg" />
        <div className="skeleton skel-line skel-full" />
        <div className="skeleton skel-line skel-xl" />
        <div className="skel-action-row">
          <div className="skeleton skel-line skel-sm" />
          <div className="skeleton skel-qty" />
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onDismiss ? <button type="button" onClick={onDismiss}>Dismiss</button> : null}
    </div>
  );
}

// ── Customer Auth Context ─────────────────────────────────────────────────────

type CustomerContextType = {
  customer: Customer | null;
  setCustomer: (c: Customer | null) => void;
  logout: () => void;
};

const CustomerContext = React.createContext<CustomerContextType>({
  customer: null,
  setCustomer: () => undefined,
  logout: () => undefined
});

function useCustomer() {
  return React.useContext(CustomerContext);
}

// ── App Shell ─────────────────────────────────────────────────────────────────

function App() {
  const [customer, setCustomer] = React.useState<Customer | null>(null);

  React.useEffect(() => {
    const token = getStoredCustomerToken();
    if (token) {
      getCustomerMe()
        .then((data) => setCustomer(data.customer))
        .catch(() => clearStoredCustomerToken());
    }
  }, []);

  function logout() {
    clearStoredCustomerToken();
    setCustomer(null);
  }

  return (
    <CustomerContext.Provider value={{ customer, setCustomer, logout }}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<CustomerLoginPage />} />
          <Route path="/my-orders" element={<CustomerOrdersPage />} />
          <Route path="/v/:slug" element={<CustomerStorefront />} />
          <Route path="/order/:orderId" element={<OrderStatusPage />} />
          <Route path="/vendor" element={<VendorConsole />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </CustomerContext.Provider>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({ children, hideVendorNav = false }: { children: React.ReactNode; hideVendorNav?: boolean }) {
  const { customer, logout } = useCustomer();
  const location = useLocation();
  const p = location.pathname;

  function navClass(path: string) {
    return `bottom-nav-item${p === path ? " active" : ""}`;
  }

  return (
    <div>
      <header className="topbar">
        <Link to="/" className="brand">QuickOrder</Link>
        <nav>
          {customer ? (
            <>
              <Link to="/my-orders">My Orders</Link>
              <button className="nav-text-btn" onClick={logout}>Logout</button>
            </>
          ) : (
            <Link to="/login">Login</Link>
          )}
          {hideVendorNav ? null : <Link to="/vendor">For Shops</Link>}
        </nav>
      </header>
      {children}
      <nav className="bottom-nav" aria-label="Main navigation">
        <div className="bottom-nav-inner">
          <Link to="/" className={navClass("/")}>
            <span className="bottom-nav-icon">🏠</span>
            <span>Home</span>
          </Link>
          <Link to="/my-orders" className={navClass("/my-orders")}>
            <span className="bottom-nav-icon">📦</span>
            <span>Orders</span>
          </Link>
          {hideVendorNav ? null : (
            <Link to="/vendor" className={navClass("/vendor")}>
              <span className="bottom-nav-icon">🏪</span>
              <span>Sell</span>
            </Link>
          )}
          {customer ? (
            <button className="bottom-nav-item" onClick={logout}>
              <span className="bottom-nav-icon">👤</span>
              <span>Logout</span>
            </button>
          ) : (
            <Link to="/login" className={navClass("/login")}>
              <span className="bottom-nav-icon">👤</span>
              <span>Login</span>
            </Link>
          )}
        </div>
      </nav>
    </div>
  );
}

// ── Home Page ─────────────────────────────────────────────────────────────────

function HomePage() {
  const [shops, setShops] = React.useState<ShopSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState("");
  const [activeCategory, setActiveCategory] = React.useState("All");
  const [deliveryOnly, setDeliveryOnly] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    setLoading(true);
    const params: { category?: string; q?: string; deliveryOnly?: boolean } = {};
    if (activeCategory !== "All") params.category = activeCategory;
    if (search.trim()) params.q = search.trim();
    if (deliveryOnly) params.deliveryOnly = true;

    getShops(params)
      .then((data) => { setShops(data.shops); setLoading(false); })
      .catch((err) => { setError(messageFromError(err)); setLoading(false); });
  }, [activeCategory, deliveryOnly]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const params: { category?: string; q?: string; deliveryOnly?: boolean } = {};
    if (activeCategory !== "All") params.category = activeCategory;
    if (search.trim()) params.q = search.trim();
    if (deliveryOnly) params.deliveryOnly = true;
    getShops(params)
      .then((data) => { setShops(data.shops); setLoading(false); })
      .catch((err) => { setError(messageFromError(err)); setLoading(false); });
  }

  return (
    <Shell hideVendorNav={false}>
      <section className="home-hero">
        <div className="home-hero-content">
          <p className="eyebrow">Your neighbourhood, online</p>
          <h1>Pick up from local shops near you</h1>
          <p>Browse, order & skip the queue. No middlemen, just your local shop.</p>
          <form className="search-bar" onSubmit={handleSearch}>
            <input
              type="search"
              placeholder="Search shops by name or area..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="submit">Search</button>
          </form>
        </div>
      </section>

      <div className="value-strip">
        <div className="value-item">
          <span className="value-icon">⚡</span>
          <span>Skip the queue</span>
        </div>
        <div className="value-item">
          <span className="value-icon">🏪</span>
          <span>Local shops only</span>
        </div>
        <div className="value-item">
          <span className="value-icon">📱</span>
          <span>Scan QR & order</span>
        </div>
        <div className="value-item">
          <span className="value-icon">💳</span>
          <span>Pay online or cash</span>
        </div>
      </div>

      <main className="home-main">
        <div className="filter-row">
          <div className="category-chips">
            {SHOP_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`chip${activeCategory === cat ? " chip-active" : ""}`}
                onClick={() => setActiveCategory(cat)}
              >
                <span className="chip-emoji">{CATEGORY_EMOJIS[cat]}</span>
                <span>{cat}</span>
              </button>
            ))}
            <button
              type="button"
              className={`chip${deliveryOnly ? " chip-active" : ""}`}
              onClick={() => setDeliveryOnly((v) => !v)}
            >
              <span className="chip-emoji">🛵</span>
              <span>Delivery</span>
            </button>
          </div>
        </div>

        <ErrorBanner message={error} onDismiss={() => setError("")} />

        {loading ? (
          <div className="shops-grid" aria-label="Loading shops…">
            {Array.from({ length: 6 }).map((_, i) => <ShopCardSkeleton key={i} />)}
          </div>
        ) : shops.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">🏪</div>
            <p className="empty-title">No shops found</p>
            <p className="empty-sub">Try a different search term or category</p>
          </div>
        ) : (
          <>
            <p className="shops-section-title">{activeCategory === "All" ? "All Shops" : activeCategory} · {shops.length} near you</p>
            <div className="shops-grid">
              {shops.map((shop) => (
                <Link key={shop.id} to={`/v/${shop.slug}`} className="shop-card">
                  {shop.bannerUrl ? (
                    <img src={shop.bannerUrl} alt="" className="shop-banner" />
                  ) : (
                    <div className="shop-banner-placeholder">{CATEGORY_EMOJIS[shop.category ?? "Other"] ?? "🏪"}</div>
                  )}
                  <div className="shop-card-body">
                    <div className="shop-card-top">
                      <span className="shop-category">{shop.category}</span>
                      <span className={`shop-status ${shop.isOpen ? "open" : "closed"}`}>
                        {shop.isOpen ? "● Open" : "● Closed"}
                      </span>
                    </div>
                    <h3>
                      {shop.name}
                      {shop.verified ? <span className="verified-tick" title="Verified shop">✓</span> : null}
                    </h3>
                    <p className="shop-location">{shop.locationTag}</p>
                    <div className="shop-meta">
                      {shop.deliveryEnabled ? (
                        <span className="delivery-badge">Delivery ₹{shop.deliveryFeeFlat}</span>
                      ) : (
                        <span className="pickup-badge">Pickup only</span>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </main>
    </Shell>
  );
}

// ── Customer Login Page ───────────────────────────────────────────────────────

function CustomerLoginPage() {
  const { customer, setCustomer } = useCustomer();
  const navigate = useNavigate();
  const [method, setMethod] = React.useState<"phone" | "email">("phone");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [otp, setOtp] = React.useState("");
  const [name, setName] = React.useState("");
  const [otpSent, setOtpSent] = React.useState(false);
  const [isNew, setIsNew] = React.useState(false);
  const [devOtp, setDevOtp] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  if (customer) return <Navigate to="/" replace />;

  const identifier = method === "phone" ? phone : email;

  function switchMethod(next: "phone" | "email") {
    setMethod(next);
    setOtpSent(false);
    setOtp("");
    setDevOtp("");
    setError("");
  }

  async function sendOtp() {
    setError("");
    setLoading(true);
    try {
      const res = method === "phone" ? await requestCustomerOtp(phone) : await requestCustomerEmailOtp(email);
      setOtpSent(true);
      if (res.devOtp) setDevOtp(res.devOtp);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = method === "phone"
        ? await verifyCustomerOtp({ phone, otpCode: otp, name: name || undefined })
        : await verifyCustomerEmailOtp({ email, otpCode: otp, name: name || undefined });
      setStoredCustomerToken(res.token);
      setCustomer(res.customer);
      setIsNew(res.isNew);
      if (!res.isNew) navigate("/");
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell hideVendorNav>
      <main className="auth-page">
        <section className="panel auth-panel">
          <div className="auth-brand-mark">⚡</div>
          <h2>Welcome to QuickOrder</h2>
          <p className="muted">Continue with your mobile number or email. We'll send a one-time code.</p>
          <ErrorBanner message={error} onDismiss={() => setError("")} />
          <div className="auth-method-toggle">
            <button
              type="button"
              className={method === "phone" ? "toggle-btn active" : "toggle-btn"}
              onClick={() => switchMethod("phone")}
            >
              Mobile number
            </button>
            <button
              type="button"
              className={method === "email" ? "toggle-btn active" : "toggle-btn"}
              onClick={() => switchMethod("email")}
            >
              Email
            </button>
          </div>
          <form className="onboarding-form" onSubmit={verify}>
            {method === "phone" ? (
              <label>
                Mobile number
                <input
                  required
                  type="tel"
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); setOtpSent(false); setDevOtp(""); }}
                  placeholder="+91..."
                />
              </label>
            ) : (
              <label>
                Email address
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setOtpSent(false); setDevOtp(""); }}
                  placeholder="you@example.com"
                />
              </label>
            )}
            {!otpSent ? (
              <button type="button" onClick={sendOtp} disabled={!identifier || loading}>
                {loading ? "Sending..." : `Send code${method === "email" ? " to email" : ""}`}
              </button>
            ) : (
              <>
                <label>
                  One-time code
                  <input required value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6-digit code" />
                </label>
                {devOtp ? <p className="token-note">Dev OTP: {devOtp}</p> : null}
                {isNew ? (
                  <label>
                    Your name
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What should we call you?" />
                  </label>
                ) : null}
                <button type="submit" disabled={!otp || loading}>
                  {loading ? "Verifying..." : "Continue"}
                </button>
                <button type="button" className="quiet-button" onClick={sendOtp} disabled={loading}>
                  Resend code
                </button>
              </>
            )}
          </form>
        </section>
      </main>
    </Shell>
  );
}

// ── Customer Orders Page ──────────────────────────────────────────────────────

function CustomerOrdersPage() {
  const { customer } = useCustomer();
  const navigate = useNavigate();
  const [orders, setOrders] = React.useState<(Order & { vendorName: string })[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!customer) {
      navigate("/login");
      return;
    }
    getCustomerOrders()
      .then((data) => { setOrders(data.orders); setLoading(false); })
      .catch((err) => { setError(messageFromError(err)); setLoading(false); });
  }, [customer, navigate]);

  async function handleCancel(orderId: string) {
    if (!confirm("Cancel this order?")) return;
    try {
      const res = await cancelOrder(orderId);
      setOrders((prev) => prev.map((o) => o.id === orderId ? { ...o, ...res.order } : o));
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  return (
    <Shell>
      <section className="hero vendor-hero">
        <div>
          <p className="eyebrow">Your account</p>
          <h1>My Orders</h1>
        </div>
      </section>
      <main className="orders-page">
        <ErrorBanner message={error} onDismiss={() => setError("")} />
        {loading ? (
          <div className="empty">Loading your orders...</div>
        ) : orders.length === 0 ? (
          <div className="empty">
            <p>You haven't placed any orders yet.</p>
            <Link to="/" className="primary-link">Browse shops</Link>
          </div>
        ) : (
          <div className="order-history">
            {orders.map((order) => (
              <article className="order-history-card" key={order.id}>
                <div className="order-history-top">
                  <div>
                    <strong>{order.vendorName}</strong>
                    <span className="order-code">#{order.orderCode}</span>
                  </div>
                  <StatusBadge status={order.status} />
                </div>
                <p className="order-items-list">{order.items.map((i) => `${i.name} x${i.quantity}`).join(", ")}</p>
                <div className="order-history-bottom">
                  <div>
                    <span className="muted">{new Date(order.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
                    <span className="muted"> · {order.orderType === "delivery" ? "Delivery" : "Pickup"} · {order.paymentMethod === "cash" ? "Cash" : "Online"}</span>
                  </div>
                  <div className="button-row">
                    <strong>₹{order.totalAmount}</strong>
                    <Link to={`/order/${order.id}`} className="small-link">Track</Link>
                    {["PENDING", "CONFIRMED"].includes(order.status) ? (
                      <button className="danger-button small-btn" onClick={() => handleCancel(order.id)}>Cancel</button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        <section className="panel" style={{ marginTop: 32 }}>
          <h2>Saved addresses</h2>
          <AddressBook />
        </section>
      </main>
    </Shell>
  );
}

function AddressBook() {
  const { customer, setCustomer } = useCustomer();
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState({ label: "Home", line1: "", city: "", pincode: "" });
  const [error, setError] = React.useState("");

  if (!customer) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await addCustomerAddress(draft);
      const updated = await getCustomerMe();
      setCustomer(updated.customer);
      setShowForm(false);
      setDraft({ label: "Home", line1: "", city: "", pincode: "" });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function remove(id: string) {
    try {
      await deleteCustomerAddress(id);
      const updated = await getCustomerMe();
      setCustomer(updated.customer);
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError("")} />
      {(customer.addresses ?? []).map((addr: Address) => (
        <div key={addr.id} className="address-row">
          <div>
            <strong>{addr.label}</strong>
            <p className="muted">{addr.line1}, {addr.city} — {addr.pincode}</p>
          </div>
          <button className="danger-button small-btn" onClick={() => remove(addr.id)}>Remove</button>
        </div>
      ))}
      {showForm ? (
        <form className="onboarding-form" onSubmit={save} style={{ marginTop: 16 }}>
          <label>Label <input value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} placeholder="Home / Office" /></label>
          <label>Address line <input required value={draft.line1} onChange={(e) => setDraft((d) => ({ ...d, line1: e.target.value }))} /></label>
          <label>City <input required value={draft.city} onChange={(e) => setDraft((d) => ({ ...d, city: e.target.value }))} /></label>
          <label>Pincode <input required value={draft.pincode} onChange={(e) => setDraft((d) => ({ ...d, pincode: e.target.value }))} /></label>
          <div className="button-row">
            <button type="submit">Save address</button>
            <button type="button" className="quiet-button" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <button className="quiet-button" style={{ marginTop: 12 }} onClick={() => setShowForm(true)}>+ Add address</button>
      )}
    </div>
  );
}

// ── Customer Storefront ───────────────────────────────────────────────────────

function CustomerStorefront() {
  const { slug } = useParams<{ slug: string }>();
  const { customer } = useCustomer();
  const [vendor, setVendor] = React.useState<(ShopSummary & { qrUrl?: string; storefrontUrl?: string }) | null>(null);
  const [menuItems, setMenuItems] = React.useState<MenuItem[]>([]);
  const [storefrontLoading, setStorefrontLoading] = React.useState(true);
  const [email, setEmail] = React.useState(customer?.email ?? "");
  const [phone, setPhone] = React.useState(customer?.phone ?? "");
  const [orderType, setOrderType] = React.useState<"pickup" | "delivery">("pickup");
  const [paymentMethod, setPaymentMethod] = React.useState<"online" | "cash">("online");
  const [deliveryAddr, setDeliveryAddr] = React.useState({ line1: "", city: "", pincode: "" });
  const [selectedSavedAddr, setSelectedSavedAddr] = React.useState<string>("");
  const [isPaying, setIsPaying] = React.useState(false);
  const [placedOrder, setPlacedOrder] = React.useState<Order | null>(null);
  const [pendingPayment, setPendingPayment] = React.useState<{
    order: Order;
    payment: { keyId?: string; orderId?: string; amount?: number; currency?: string };
  } | null>(null);
  const [error, setError] = React.useState("");
  const { quantities, setQuantity, clear } = useCartStore();

  React.useEffect(() => {
    if (!slug) return;
    setError("");
    setStorefrontLoading(true);
    getStorefront(slug)
      .then((data) => {
        setVendor(data.vendor as unknown as typeof vendor);
        setMenuItems(data.menuItems);
      })
      .catch((loadError) => setError(messageFromError(loadError)))
      .finally(() => setStorefrontLoading(false));
  }, [slug]);

  React.useEffect(() => {
    if (customer) {
      setEmail(customer.email ?? "");
      setPhone(customer.phone ?? "");
    }
  }, [customer]);

  const cartLines = buildCartLines(menuItems, quantities);
  const itemsTotal = cartLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const deliveryFee = orderType === "delivery" ? ((vendor as { deliveryFeeFlat?: number })?.deliveryFeeFlat ?? 0) : 0;
  const total = itemsTotal + deliveryFee;

  const savedAddresses = customer?.addresses ?? [];
  const deliveryEnabled = (vendor as { deliveryEnabled?: boolean })?.deliveryEnabled ?? false;

  function getEffectiveAddress() {
    if (selectedSavedAddr) {
      const saved = savedAddresses.find((a: Address) => a.id === selectedSavedAddr);
      if (saved) return { line1: saved.line1, city: saved.city, pincode: saved.pincode };
    }
    return deliveryAddr;
  }

  async function openPayment(order: Order, payment: { keyId?: string; orderId?: string; amount?: number; currency?: string }) {
    if (!payment.keyId || !payment.orderId) return;
    await openRazorpayCheckout({
      keyId: payment.keyId,
      orderId: payment.orderId,
      amount: payment.amount ?? order.totalAmount * 100,
      currency: payment.currency ?? "INR",
      name: (vendor as { name?: string })?.name ?? "QuickOrder",
      email,
      phone,
      onSuccess: async (payload) => {
        const confirmed = await confirmOrderPayment(order.id, payload);
        setPlacedOrder(confirmed.order);
        setPendingPayment(null);
        clear();
      }
    });
  }

  async function placeOrder() {
    setIsPaying(true);
    setError("");
    try {
      const addr = orderType === "delivery" ? getEffectiveAddress() : undefined;
      if (orderType === "delivery" && (!addr?.line1 || !addr?.city || !addr?.pincode)) {
        throw new Error("Please fill in your delivery address");
      }
      const response = await createOrder({
        vendorSlug: slug!,
        customerEmail: email,
        customerPhone: phone || undefined,
        customerId: customer?.id,
        orderType,
        deliveryAddress: addr,
        paymentMethod,
        items: cartLines.map((line) => ({ menuItemId: line.item.id, quantity: line.quantity }))
      });
      if (paymentMethod === "online" && response.payment.provider === "razorpay" && response.payment.keyId && response.payment.orderId) {
        setPendingPayment({ order: response.order, payment: response.payment });
        await openPayment(response.order, response.payment);
      } else {
        setPlacedOrder(response.order);
        clear();
      }
    } catch (payError) {
      setError(messageFromError(payError));
    } finally {
      setIsPaying(false);
    }
  }

  async function retryPayment() {
    if (!pendingPayment) return;
    setIsPaying(true);
    setError("");
    try {
      await openPayment(pendingPayment.order, pendingPayment.payment);
    } catch (payError) {
      setError(messageFromError(payError));
    } finally {
      setIsPaying(false);
    }
  }

  if (storefrontLoading) return (
    <Shell hideVendorNav>
      <div className="skeleton" style={{ width: "100%", minHeight: 200, borderRadius: 0 }} aria-hidden="true" />
      <main className="customer-grid">
        <section>
          <div className="menu-grid" aria-label="Loading menu…">
            {Array.from({ length: 8 }).map((_, i) => <MenuCardSkeleton key={i} />)}
          </div>
        </section>
        <aside className="cart-panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="skeleton skel-title" style={{ width: "60%", marginBottom: 8 }} aria-hidden="true" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton skel-line skel-full" style={{ height: 14 }} aria-hidden="true" />
          ))}
        </aside>
      </main>
    </Shell>
  );

  if (!vendor) return <Shell hideVendorNav><div className="empty"><div className="empty-icon">⚠️</div><p className="empty-title">{error || "Shop not found"}</p></div></Shell>;

  return (
    <Shell hideVendorNav>
      <section
        className="hero store-hero"
        style={(vendor as { bannerUrl?: string }).bannerUrl ? {
          backgroundImage: `linear-gradient(90deg,rgba(33,31,45,.74),rgba(33,31,45,.26)),url(${(vendor as { bannerUrl?: string }).bannerUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center"
        } : undefined}
      >
        <div>
          <p className="eyebrow">
            {(vendor as { category?: string }).category ?? "Shop"} ·{" "}
            <span className={(vendor as { isOpen?: boolean }).isOpen ? "open-text" : "closed-text"}>
              {(vendor as { isOpen?: boolean }).isOpen ? "Open" : "Closed"}
            </span>
          </p>
          <h1>
            {(vendor as { name?: string }).name}
            {(vendor as { verified?: boolean }).verified ? <span className="verified-tick hero-tick" title="Verified shop">✓</span> : null}
          </h1>
          <p>{(vendor as { locationTag?: string }).locationTag}</p>
          {deliveryEnabled ? (
            <p className="hero-delivery-note">Delivery available · ₹{(vendor as { deliveryFeeFlat?: number }).deliveryFeeFlat ?? 0} delivery fee</p>
          ) : null}
        </div>
      </section>

      {placedOrder ? (
        <OrderConfirmation order={placedOrder} vendorName={(vendor as { name?: string }).name ?? "Shop"} />
      ) : (
        <main className="customer-grid">
          <section>
            <div className="section-head">
              <h2>Menu</h2>
              <span>{menuItems.length} available</span>
            </div>
            <div className="menu-grid">
              {menuItems.map((item) => {
                const lowStock = typeof item.stockQuantity === "number" && item.stockQuantity <= 5;
                const stockCap = typeof item.stockQuantity === "number" ? item.stockQuantity : Infinity;
                return (
                  <article className="menu-card" key={item.id}>
                    <img src={item.photoUrl} alt="" />
                    <div className="menu-card-body">
                      <div>
                        <p className="category">{item.category}</p>
                        <h3>{item.name}</h3>
                        <p>{item.description}</p>
                        {lowStock ? <span className="low-stock-badge">Only {item.stockQuantity} left</span> : null}
                      </div>
                      <div className="menu-action">
                        <strong>₹{item.price}</strong>
                        <QuantityControl
                          value={quantities[item.id] ?? 0}
                          onChange={(quantity) => setQuantity(item.id, Math.min(quantity, stockCap))}
                        />
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <aside className="cart-panel">
            <h2>Your order</h2>
            <ErrorBanner message={error} onDismiss={() => setError("")} />
            {pendingPayment ? (
              <div className="payment-pending">
                <strong>Payment pending for order #{pendingPayment.order.orderCode}</strong>
                <span>Complete payment to confirm this order.</span>
                <button type="button" onClick={retryPayment} disabled={isPaying}>
                  {isPaying ? "Opening payment..." : "Retry payment"}
                </button>
              </div>
            ) : null}
            {cartLines.length === 0 ? (
              <p className="muted">Add items to start your order.</p>
            ) : (
              <div className="cart-lines">
                {cartLines.map((line) => (
                  <div className="cart-line" key={line.item.id}>
                    <span>{line.item.name} x{line.quantity}</span>
                    <strong>₹{line.lineTotal}</strong>
                  </div>
                ))}
              </div>
            )}

            {deliveryEnabled ? (
              <div className="order-type-toggle">
                <button
                  type="button"
                  className={orderType === "pickup" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => setOrderType("pickup")}
                >
                  Pickup
                </button>
                <button
                  type="button"
                  className={orderType === "delivery" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => setOrderType("delivery")}
                >
                  Delivery +₹{(vendor as { deliveryFeeFlat?: number }).deliveryFeeFlat ?? 0}
                </button>
              </div>
            ) : null}

            {orderType === "delivery" ? (
              <div className="delivery-address-form">
                {savedAddresses.length > 0 ? (
                  <label>
                    Saved address
                    <select
                      value={selectedSavedAddr}
                      onChange={(e) => setSelectedSavedAddr(e.target.value)}
                    >
                      <option value="">Enter new address</option>
                      {savedAddresses.map((a: Address) => (
                        <option key={a.id} value={a.id}>{a.label} — {a.line1}, {a.city}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {!selectedSavedAddr ? (
                  <>
                    <label>
                      Address line
                      <input required value={deliveryAddr.line1} onChange={(e) => setDeliveryAddr((d) => ({ ...d, line1: e.target.value }))} placeholder="House / flat / street" />
                    </label>
                    <label>
                      City
                      <input required value={deliveryAddr.city} onChange={(e) => setDeliveryAddr((d) => ({ ...d, city: e.target.value }))} />
                    </label>
                    <label>
                      Pincode
                      <input required value={deliveryAddr.pincode} onChange={(e) => setDeliveryAddr((d) => ({ ...d, pincode: e.target.value }))} />
                    </label>
                  </>
                ) : null}
              </div>
            ) : null}

            {!customer ? (
              <>
                <label>
                  Email for notification
                  <input required value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
                </label>
                <label>
                  Phone (optional)
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" />
                </label>
              </>
            ) : null}

            <div className="payment-method-toggle">
              <button
                type="button"
                className={paymentMethod === "online" ? "toggle-btn active" : "toggle-btn"}
                onClick={() => setPaymentMethod("online")}
              >
                Pay online
              </button>
              <button
                type="button"
                className={paymentMethod === "cash" ? "toggle-btn active" : "toggle-btn"}
                onClick={() => setPaymentMethod("cash")}
              >
                Cash {orderType === "delivery" ? "on delivery" : "on pickup"}
              </button>
            </div>

            {orderType === "delivery" && deliveryFee > 0 ? (
              <div className="cart-line fee-line">
                <span>Delivery fee</span>
                <strong>₹{deliveryFee}</strong>
              </div>
            ) : null}

            <div className="total-row">
              <span>Total</span>
              <strong>₹{total}</strong>
            </div>

            <button
              disabled={
                !cartLines.length ||
                (!customer && !email) ||
                isPaying ||
                Boolean(pendingPayment)
              }
              onClick={placeOrder}
            >
              {isPaying
                ? "Placing order..."
                : paymentMethod === "cash"
                ? `Place order · ₹${total}`
                : `Pay ₹${total} online`}
            </button>
            {!customer ? (
              <p className="fine-print"><Link to="/login">Login</Link> to save addresses and track all your orders.</p>
            ) : null}
          </aside>
        </main>
      )}
    </Shell>
  );
}

function QuantityControl({ value, onChange }: { value: number; onChange: (quantity: number) => void }) {
  return (
    <div className="qty">
      <button onClick={() => onChange(value - 1)} aria-label="Decrease quantity">-</button>
      <span>{value}</span>
      <button onClick={() => onChange(value + 1)} aria-label="Increase quantity">+</button>
    </div>
  );
}

function OrderConfirmation({ order, vendorName }: { order: Order; vendorName: string }) {
  return (
    <section className="confirmation">
      <div className="success-mark">✓</div>
      <p className="eyebrow">{order.paymentMethod === "cash" ? "Order placed" : "Payment confirmed"}</p>
      <h2>Order confirmed</h2>
      <div className="order-code">{order.orderCode}</div>
      <p>
        {order.orderType === "delivery"
          ? "Your order is on its way. Track live status below."
          : "Your order is confirmed. Keep this code ready for pickup."}
      </p>
      <Link className="primary-link" to={`/order/${order.id}`}>Track live status</Link>
    </section>
  );
}

// ── Order Status Page ─────────────────────────────────────────────────────────

function OrderStatusPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { customer } = useCustomer();
  const [order, setOrder] = React.useState<Order | null>(null);
  const [vendor, setVendor] = React.useState<{ name: string; locationTag: string } | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const [pushState, setPushState] = React.useState<"idle" | "enabling" | "enabled">("idle");
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!orderId) return;
    getOrder(orderId).then((data) => {
      setOrder(data.order);
      setVendor(data.vendor);
    });
    socket.emit("join_order", { orderId });
    socket.on("order_updated", (updated: Order) => { if (updated.id === orderId) setOrder(updated); });
    socket.on("order_ready", (updated: Order) => { if (updated.id === orderId) setOrder(updated); });
    return () => {
      socket.off("order_updated");
      socket.off("order_ready");
    };
  }, [orderId]);

  async function handleCancel() {
    if (!orderId || !confirm("Are you sure you want to cancel this order?")) return;
    setCancelling(true);
    setError("");
    try {
      const res = await cancelOrder(orderId);
      setOrder(res.order);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCancelling(false);
    }
  }

  async function handleEnablePush() {
    if (!orderId) return;
    setPushState("enabling");
    setError("");
    try {
      await enablePushForOrder(orderId, customer?.id);
      setPushState("enabled");
    } catch (err) {
      setPushState("idle");
      setError(messageFromError(err));
    }
  }

  if (!order || !vendor) return <Shell><div className="empty">Loading order...</div></Shell>;

  const isOwner = customer && order.customerId === customer.id;
  const canCancel = isOwner && ["PENDING", "CONFIRMED"].includes(order.status);
  const orderLive = !["COLLECTED", "CANCELLED"].includes(order.status);

  return (
    <Shell>
      <section className="status-page">
        <p className="eyebrow">{vendor.name}</p>
        <h1>Order #{order.orderCode}</h1>
        <StatusBadge status={order.status} />
        <div className="timeline">
          <TimelineRow active done label="Order received" time={new Date(order.createdAt).toLocaleTimeString()} />
          <TimelineRow active={["PREPARING", "READY", "COLLECTED"].includes(order.status)} done={["PREPARING", "READY", "COLLECTED"].includes(order.status)} label="Preparing" />
          <TimelineRow
            active={order.status === "READY" || order.status === "COLLECTED"}
            done={order.status === "READY" || order.status === "COLLECTED"}
            label={order.orderType === "delivery" ? "Out for delivery" : "Ready for pickup"}
            time={order.readyAt ? new Date(order.readyAt).toLocaleTimeString() : undefined}
          />
        </div>

        {order.orderType === "delivery" && order.deliveryAddress ? (
          <div className="ready-box muted-box">
            Delivering to: {order.deliveryAddress.line1}, {order.deliveryAddress.city} — {order.deliveryAddress.pincode}
          </div>
        ) : null}

        {order.status === "READY" ? (
          <div className="ready-box">{order.orderType === "delivery" ? "Your order is on the way!" : `Your order is ready. Show code ${order.orderCode} at pickup.`}</div>
        ) : order.status === "PENDING" ? (
          <div className="ready-box muted-box">Payment is still pending. The vendor will receive the order after payment confirmation.</div>
        ) : order.status === "CANCELLED" ? (
          <div className="ready-box cancelled-box">This order has been cancelled.{order.paymentMethod === "online" ? " Refund will be processed in 5–7 business days." : ""}</div>
        ) : (
          <div className="ready-box muted-box">Keep this page open. It updates automatically.</div>
        )}

        <ErrorBanner message={error} onDismiss={() => setError("")} />

        {orderLive ? (
          <div className="push-optin">
            {pushState === "enabled" ? (
              <p className="muted small">✓ Notifications on — we'll alert you when this order updates.</p>
            ) : (
              <button className="quiet-button push-button" onClick={handleEnablePush} disabled={pushState === "enabling"}>
                {pushState === "enabling" ? "Enabling..." : "🔔 Notify me on updates"}
              </button>
            )}
          </div>
        ) : null}

        {canCancel ? (
          <button className="danger-button" style={{ marginTop: 16 }} onClick={handleCancel} disabled={cancelling}>
            {cancelling ? "Cancelling..." : "Cancel order"}
          </button>
        ) : null}

        <div style={{ marginTop: 24 }}>
          <Link to="/" className="small-link">← Back to shops</Link>
        </div>
      </section>
    </Shell>
  );
}

// ── Vendor Console ────────────────────────────────────────────────────────────

function VendorConsole() {
  const [orders, setOrders] = React.useState<Order[]>([]);
  const [menu, setMenu] = React.useState<MenuItem[]>([]);
  const [vendor, setVendor] = React.useState<Vendor | null>(null);
  const [demoVendors, setDemoVendors] = React.useState<Vendor[]>([]);
  const [summary, setSummary] = React.useState({ totalOrders: 0, revenue: 0, pendingSettlement: 0 });
  const [authMode, setAuthMode] = React.useState<"entry" | "login" | "signup">("entry");
  const [loginDraft, setLoginDraft] = React.useState({ phone: "", email: "", otpCode: "" });
  const [loginMethod, setLoginMethod] = React.useState<"phone" | "email">("phone");
  const [profileDraft, setProfileDraft] = React.useState({
    name: "",
    phone: "",
    email: "",
    locationTag: "",
    upiId: "",
    otpCode: "",
    password: "",
    category: "Food & Snacks",
    isOpen: true,
    deliveryEnabled: false,
    deliveryFeeFlat: "0",
    operatingHours: defaultOperatingHours(),
    acceptWindowMinutes: "15"
  });
  const [menuDraft, setMenuDraft] = React.useState({
    id: "",
    name: "",
    description: "",
    price: "50",
    photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80",
    category: "Snacks",
    isAvailable: true,
    stockQuantity: ""
  });
  const [menuPhotoFile, setMenuPhotoFile] = React.useState<File | null>(null);
  const [issuedToken, setIssuedToken] = React.useState("");
  const [loginOtpSent, setLoginOtpSent] = React.useState(false);
  const [registerOtpSent, setRegisterOtpSent] = React.useState(false);
  const [authMessage, setAuthMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const showDemoShortcuts = import.meta.env.DEV;
  const isLoggedIn = Boolean(vendor && getStoredVendorToken());

  function goToPanel(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const refresh = React.useCallback(async () => {
    if (!getStoredVendorToken()) return;
    const [orderData, menuData, qrData, dashboard] = await Promise.all([
      getVendorOrders(),
      getVendorMenu(),
      getVendorQr(),
      getDashboard()
    ]);
    setOrders(orderData.orders);
    setMenu(menuData.menuItems);
    setVendor(qrData.vendor);
    setSummary({ totalOrders: dashboard.totalOrders, revenue: dashboard.revenue, pendingSettlement: dashboard.pendingSettlement });
  }, []);

  React.useEffect(() => {
    getDemoVendors().then((data) => setDemoVendors(data.vendors)).catch(() => undefined);
    const token = getStoredVendorToken();
    if (token) {
      getVendorMe()
        .then((data) => {
          setVendor(data.vendor);
          setProfileDraft((draft) => ({
            ...draft,
            name: data.vendor.name,
            phone: data.vendor.phone,
            email: data.vendor.email ?? "",
            locationTag: data.vendor.locationTag,
            upiId: data.vendor.upiId,
            category: data.vendor.category ?? "Food & Snacks",
            isOpen: data.vendor.isOpen ?? true,
            deliveryEnabled: data.vendor.deliveryEnabled ?? false,
            deliveryFeeFlat: String(data.vendor.deliveryFeeFlat ?? 0),
            operatingHours: data.vendor.operatingHours ?? defaultOperatingHours(),
            acceptWindowMinutes: String(data.vendor.acceptWindowMinutes ?? 15)
          }));
          refresh();
          socket.emit("join_vendor", { token });
        })
        .catch(() => undefined);
    }
    socket.on("new_order", (order: Order) => setOrders((current) => [order, ...current]));
    socket.on("order_updated", (order: Order) =>
      setOrders((current) => current.map((candidate) => (candidate.id === order.id ? order : candidate)))
    );
    return () => {
      socket.off("new_order");
      socket.off("order_updated");
    };
  }, [refresh]);

  async function setStatus(order: Order, status: OrderStatus) {
    setError("");
    try {
      const response = await updateOrderStatus(order.id, status);
      setOrders((current) => current.map((candidate) => (candidate.id === order.id ? response.order : candidate)));
      refresh();
    } catch (statusError) {
      setError(messageFromError(statusError));
    }
  }

  async function toggleItem(item: MenuItem) {
    setError("");
    try {
      const response = await updateMenuItem(item.id, { isAvailable: !item.isAvailable });
      setMenu((current) => current.map((candidate) => (candidate.id === item.id ? response.menuItem : candidate)));
    } catch (toggleError) {
      setError(messageFromError(toggleError));
    }
  }

  async function saveMenuItem(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const payload = {
      name: menuDraft.name,
      description: menuDraft.description,
      price: Number(menuDraft.price),
      photoUrl: menuDraft.photoUrl,
      category: menuDraft.category,
      isAvailable: menuDraft.isAvailable,
      stockQuantity: menuDraft.stockQuantity.trim() === "" ? undefined : Number(menuDraft.stockQuantity)
    };
    try {
      if (menuDraft.id) {
        let response = await updateMenuItem(menuDraft.id, payload);
        if (menuPhotoFile) response = await uploadMenuItemPhoto(response.menuItem.id, menuPhotoFile);
        setMenu((current) => current.map((candidate) => (candidate.id === response.menuItem.id ? response.menuItem : candidate)));
      } else {
        let response = await createMenuItem(payload);
        if (menuPhotoFile) response = await uploadMenuItemPhoto(response.menuItem.id, menuPhotoFile);
        setMenu((current) => [response.menuItem, ...current]);
      }
      setMenuDraft({ id: "", name: "", description: "", price: "50", photoUrl: menuDraft.photoUrl, category: "Snacks", isAvailable: true, stockQuantity: "" });
      setMenuPhotoFile(null);
    } catch (menuError) {
      setError(messageFromError(menuError));
    }
  }

  async function removeItem(item: MenuItem) {
    setError("");
    try {
      await deleteMenuItem(item.id);
      setMenu((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (deleteError) {
      setError(messageFromError(deleteError));
    }
  }

  function editItem(item: MenuItem) {
    setMenuPhotoFile(null);
    setMenuDraft({
      id: item.id,
      name: item.name,
      description: item.description,
      price: String(item.price),
      photoUrl: item.photoUrl,
      category: item.category,
      isAvailable: item.isAvailable,
      stockQuantity: typeof item.stockQuantity === "number" ? String(item.stockQuantity) : ""
    });
  }

  async function sendLoginOtp() {
    setError("");
    setAuthMessage("");
    try {
      const response = loginMethod === "phone"
        ? await requestVendorOtp({ phone: loginDraft.phone, purpose: "login" })
        : await requestVendorEmailOtp(loginDraft.email);
      setLoginOtpSent(true);
      const target = loginMethod === "phone" ? loginDraft.phone : loginDraft.email;
      setAuthMessage(response.devOtp ? `Dev OTP: ${response.devOtp}` : `Code sent to ${target}.`);
    } catch (otpError) {
      setLoginOtpSent(false);
      setError(messageFromError(otpError));
    }
  }

  async function sendRegisterOtp() {
    setError("");
    setAuthMessage("");
    try {
      const response = await requestVendorOtp({ phone: profileDraft.phone, purpose: "register" });
      setRegisterOtpSent(true);
      setAuthMessage(response.devOtp ? `Dev OTP: ${response.devOtp}` : `OTP sent to ${profileDraft.phone}.`);
    } catch (otpError) {
      setRegisterOtpSent(false);
      setError(messageFromError(otpError));
    }
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const response = loginMethod === "phone"
        ? await verifyVendorOtp({ phone: loginDraft.phone, otpCode: loginDraft.otpCode })
        : await verifyVendorEmailOtp({ email: loginDraft.email, otpCode: loginDraft.otpCode });
      setStoredVendorToken(response.token);
      setIssuedToken(response.token);
      setVendor(response.vendor);
      setProfileDraft((draft) => ({
        ...draft,
        name: response.vendor.name,
        phone: response.vendor.phone,
        email: response.vendor.email ?? "",
        locationTag: response.vendor.locationTag,
        upiId: response.vendor.upiId,
        category: response.vendor.category ?? "Food & Snacks",
        isOpen: response.vendor.isOpen ?? true,
        deliveryEnabled: response.vendor.deliveryEnabled ?? false,
        deliveryFeeFlat: String(response.vendor.deliveryFeeFlat ?? 0),
        operatingHours: response.vendor.operatingHours ?? defaultOperatingHours(),
        acceptWindowMinutes: String(response.vendor.acceptWindowMinutes ?? 15)
      }));
      socket.emit("join_vendor", { token: response.token });
      refresh();
    } catch (loginError) {
      setError(messageFromError(loginError));
    }
  }

  async function registerShop(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const response = await registerVendor(profileDraft);
      setStoredVendorToken(response.token);
      setVendor(response.vendor);
      setIssuedToken(response.token);
      socket.emit("join_vendor", { token: response.token });
      refresh();
    } catch (registerError) {
      setError(messageFromError(registerError));
    }
  }

  async function updateProfile(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const response = await updateVendorProfile({
        name: profileDraft.name,
        locationTag: profileDraft.locationTag,
        upiId: profileDraft.upiId,
        email: profileDraft.email,
        category: profileDraft.category,
        isOpen: profileDraft.isOpen,
        deliveryEnabled: profileDraft.deliveryEnabled,
        deliveryFeeFlat: Number(profileDraft.deliveryFeeFlat),
        operatingHours: profileDraft.operatingHours,
        acceptWindowMinutes: Number(profileDraft.acceptWindowMinutes)
      });
      setVendor(response.vendor);
    } catch (profileError) {
      setError(messageFromError(profileError));
    }
  }

  function logout() {
    localStorage.removeItem("localserve_vendor_token");
    setVendor(null);
    setOrders([]);
    setMenu([]);
    setSummary({ totalOrders: 0, revenue: 0, pendingSettlement: 0 });
    setIssuedToken("");
    setLoginOtpSent(false);
    setRegisterOtpSent(false);
    setAuthMessage("");
    setError("");
    setAuthMode("entry");
  }

  return (
    <Shell>
      <section className="hero vendor-hero">
        <div>
          <p className="eyebrow">Vendor console</p>
          <h1>{vendor?.name ?? "QuickOrder Vendor"}</h1>
          <p>Manage orders, menu availability, QR code, and today&apos;s revenue.</p>
        </div>
        <div className="hero-actions">
          {vendor ? <button className="quiet-button" onClick={logout}>Logout</button> : null}
          <Link className="quiet-link" to={vendor ? `/v/${vendor.slug}` : "/"}>Open storefront</Link>
        </div>
      </section>

      {isLoggedIn ? (
        <div className="page-alert">
          <ErrorBanner message={error} onDismiss={() => setError("")} />
        </div>
      ) : null}

      {!isLoggedIn ? (
        <main className="vendor-auth-layout">
          {authMode === "entry" ? (
            <section className="panel vendor-entry-panel">
              <div>
                <p className="eyebrow">Vendor access</p>
                <h2>Run your shop from one place</h2>
                <p className="muted">Login to manage your live queue, menu, QR code, shop details, and daily totals. New vendors can create a shop first.</p>
              </div>
              <div className="entry-actions">
                <button className="entry-button" onClick={() => { setAuthMode("login"); setError(""); setAuthMessage(""); }}>
                  Login to existing shop
                  <span>Use your registered mobile number and OTP.</span>
                </button>
                <button className="entry-button secondary-entry" onClick={() => { setAuthMode("signup"); setError(""); setAuthMessage(""); }}>
                  Create a shop
                  <span>Set up shop details, UPI ID, and your first vendor account.</span>
                </button>
              </div>
            </section>
          ) : null}

          {authMode === "login" ? (
            <section className="panel auth-work-panel">
              <div className="section-head">
                <h2>Vendor login</h2>
                <button className="text-button" onClick={() => setAuthMode("entry")}>Back</button>
              </div>
              <ErrorBanner message={error} onDismiss={() => setError("")} />
              <div className="auth-method-toggle">
                <button
                  type="button"
                  className={loginMethod === "phone" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => { setLoginMethod("phone"); setLoginOtpSent(false); setAuthMessage(""); setError(""); }}
                >
                  Mobile number
                </button>
                <button
                  type="button"
                  className={loginMethod === "email" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => { setLoginMethod("email"); setLoginOtpSent(false); setAuthMessage(""); setError(""); }}
                >
                  Email
                </button>
              </div>
              <form className="onboarding-form" onSubmit={login}>
                {loginMethod === "phone" ? (
                  <label>
                    Mobile number
                    <input required value={loginDraft.phone} onChange={(event) => {
                      setLoginDraft((draft) => ({ ...draft, phone: event.target.value, otpCode: "" }));
                      setLoginOtpSent(false);
                      setAuthMessage("");
                    }} />
                  </label>
                ) : (
                  <label>
                    Email address
                    <input required type="email" value={loginDraft.email} onChange={(event) => {
                      setLoginDraft((draft) => ({ ...draft, email: event.target.value, otpCode: "" }));
                      setLoginOtpSent(false);
                      setAuthMessage("");
                    }} />
                  </label>
                )}
                <button
                  type="button"
                  className="quiet-button"
                  onClick={sendLoginOtp}
                  disabled={loginMethod === "phone" ? !loginDraft.phone : !loginDraft.email}
                >
                  Send code
                </button>
                {loginOtpSent ? (
                  <label>
                    One-time code
                    <input required value={loginDraft.otpCode} onChange={(event) => setLoginDraft((draft) => ({ ...draft, otpCode: event.target.value }))} />
                  </label>
                ) : null}
                {authMessage ? <p className="token-note">{authMessage}</p> : null}
                <button disabled={!loginOtpSent || !loginDraft.otpCode}>Login</button>
              </form>
              {showDemoShortcuts ? (
                <div className="demo-vendors">
                  {demoVendors.map((demo) => (
                    <button
                      key={demo.id}
                      className="small-link demo-button"
                      onClick={() => {
                        setLoginMethod("phone");
                        setLoginDraft({ phone: demo.phone, email: "", otpCode: "" });
                        setLoginOtpSent(false);
                        setAuthMessage("");
                      }}
                    >
                      {demo.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {authMode === "signup" ? (
            <section className="panel auth-work-panel">
              <div className="section-head">
                <h2>Create shop</h2>
                <button className="text-button" onClick={() => setAuthMode("entry")}>Back</button>
              </div>
              <ErrorBanner message={error} onDismiss={() => setError("")} />
              <form className="onboarding-form" onSubmit={registerShop}>
                <label>
                  Shop name
                  <input required value={profileDraft.name} onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))} />
                </label>
                <label>
                  Mobile number
                  <input required value={profileDraft.phone} onChange={(event) => {
                    setProfileDraft((draft) => ({ ...draft, phone: event.target.value, otpCode: "" }));
                    setRegisterOtpSent(false);
                    setAuthMessage("");
                  }} />
                </label>
                <button type="button" className="quiet-button" onClick={sendRegisterOtp} disabled={!profileDraft.phone}>Send OTP</button>
                {registerOtpSent ? (
                  <label>
                    OTP
                    <input value={profileDraft.otpCode} onChange={(event) => setProfileDraft((draft) => ({ ...draft, otpCode: event.target.value }))} />
                  </label>
                ) : null}
                <label>
                  Location / area
                  <input required value={profileDraft.locationTag} onChange={(event) => setProfileDraft((draft) => ({ ...draft, locationTag: event.target.value }))} />
                </label>
                <label>
                  Email (optional — enables email login)
                  <input type="email" value={profileDraft.email} onChange={(event) => setProfileDraft((draft) => ({ ...draft, email: event.target.value }))} />
                </label>
                <label>
                  UPI ID
                  <input required value={profileDraft.upiId} onChange={(event) => setProfileDraft((draft) => ({ ...draft, upiId: event.target.value }))} />
                </label>
                <label>
                  Password
                  <input required minLength={6} type="password" value={profileDraft.password} onChange={(event) => setProfileDraft((draft) => ({ ...draft, password: event.target.value }))} />
                </label>
                {authMessage ? <p className="token-note">{authMessage}</p> : null}
                <button disabled={!registerOtpSent || !profileDraft.otpCode || !profileDraft.name || !profileDraft.locationTag || !profileDraft.upiId || profileDraft.password.length < 6}>Create shop</button>
              </form>
            </section>
          ) : null}
        </main>
      ) : (
        <main className="vendor-grid">
          <section className="panel vendor-action-panel">
            <p className="eyebrow">Quick actions</p>
            <div className="vendor-action-grid">
              <button className="large-action" onClick={() => goToPanel("live-queue")}>Live queue</button>
              <button className="large-action" onClick={() => goToPanel("add-product")}>Add product</button>
              <button className="large-action" onClick={() => goToPanel("shop-summary")}>Total summary</button>
              <button className="large-action" onClick={() => goToPanel("shop-profile")}>Edit shop info</button>
            </div>
          </section>

          <section className="panel queue-panel" id="live-queue">
            <div className="section-head">
              <h2>Live queue</h2>
              <span>{orders.length} orders</span>
            </div>
            {orders.length === 0 ? <p className="muted">New paid orders will appear here instantly.</p> : null}
            {orders.map((order) => (
              <article className="order-card" key={order.id}>
                <div className="order-card-top">
                  <strong>#{order.orderCode}</strong>
                  <div className="order-card-badges">
                    <StatusBadge status={order.status} />
                    {order.orderType === "delivery" ? <span className="delivery-tag">Delivery</span> : null}
                    {order.paymentMethod === "cash" ? <span className="cash-tag">Cash</span> : null}
                  </div>
                </div>
                <p>{order.items.map((item) => `${item.name} x${item.quantity}`).join(", ")}</p>
                {order.deliveryAddress ? (
                  <p className="muted small">{order.deliveryAddress.line1}, {order.deliveryAddress.city}</p>
                ) : null}
                <div className="order-card-bottom">
                  <strong>₹{order.totalAmount}</strong>
                  <div className="button-row">
                    {order.status === "CONFIRMED" && <button onClick={() => setStatus(order, "PREPARING")}>Start</button>}
                    {order.status !== "READY" && order.status !== "COLLECTED" && order.status !== "CANCELLED" && <button onClick={() => setStatus(order, "READY")}>Mark ready</button>}
                    {order.status === "READY" && <button onClick={() => setStatus(order, "COLLECTED")}>Collected</button>}
                    <a
                      className="small-link"
                      href={`${API_URL}/vendor/orders/${order.id}/receipt.pdf?token=${encodeURIComponent(getStoredVendorToken())}`}
                    >
                      Receipt
                    </a>
                  </div>
                </div>
              </article>
            ))}
          </section>

          <section className="panel" id="shop-profile">
            <h2>Shop profile</h2>
            <form className="onboarding-form" onSubmit={updateProfile}>
              <label>
                Shop name
                <input value={profileDraft.name} onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))} />
              </label>
              <label>
                Mobile number
                <input disabled value={profileDraft.phone} />
              </label>
              <label>
                Email (used for email login)
                <input type="email" value={profileDraft.email} onChange={(event) => setProfileDraft((draft) => ({ ...draft, email: event.target.value }))} />
              </label>
              <label>
                Location / area
                <input value={profileDraft.locationTag} onChange={(event) => setProfileDraft((draft) => ({ ...draft, locationTag: event.target.value }))} />
              </label>
              <label>
                UPI ID
                <input value={profileDraft.upiId} onChange={(event) => setProfileDraft((draft) => ({ ...draft, upiId: event.target.value }))} />
              </label>
              <label>
                Shop category
                <select value={profileDraft.category} onChange={(e) => setProfileDraft((d) => ({ ...d, category: e.target.value }))}>
                  {["Food & Snacks", "Tea & Coffee", "Grocery", "General Store", "Bakery", "Pharmacy", "Stationery", "Electronics", "Other"].map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={profileDraft.isOpen} onChange={(e) => setProfileDraft((d) => ({ ...d, isOpen: e.target.checked }))} />
                Shop is open
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={profileDraft.deliveryEnabled} onChange={(e) => setProfileDraft((d) => ({ ...d, deliveryEnabled: e.target.checked }))} />
                Offer delivery
              </label>
              {profileDraft.deliveryEnabled ? (
                <label>
                  Delivery fee (₹)
                  <input type="number" min="0" value={profileDraft.deliveryFeeFlat} onChange={(e) => setProfileDraft((d) => ({ ...d, deliveryFeeFlat: e.target.value }))} />
                </label>
              ) : null}

              <div className="hours-editor">
                <p className="hours-title">Weekly operating hours</p>
                <p className="muted small">Customers can only order while the shop is within these hours. The "Shop is open" toggle above can force-close it anytime.</p>
                {profileDraft.operatingHours.map((day, index) => (
                  <div className="hours-row" key={DAY_NAMES[index]}>
                    <span className="hours-day">{DAY_NAMES[index]}</span>
                    <label className="checkbox-row hours-closed">
                      <input
                        type="checkbox"
                        checked={day.closed}
                        onChange={(e) => setProfileDraft((d) => ({
                          ...d,
                          operatingHours: d.operatingHours.map((h, i) => i === index ? { ...h, closed: e.target.checked } : h)
                        }))}
                      />
                      Closed
                    </label>
                    {!day.closed ? (
                      <div className="hours-times">
                        <input
                          type="time"
                          value={day.open}
                          onChange={(e) => setProfileDraft((d) => ({
                            ...d,
                            operatingHours: d.operatingHours.map((h, i) => i === index ? { ...h, open: e.target.value } : h)
                          }))}
                        />
                        <span>to</span>
                        <input
                          type="time"
                          value={day.close}
                          onChange={(e) => setProfileDraft((d) => ({
                            ...d,
                            operatingHours: d.operatingHours.map((h, i) => i === index ? { ...h, close: e.target.value } : h)
                          }))}
                        />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              <label>
                Order acceptance window (minutes)
                <input
                  type="number"
                  min="1"
                  max="240"
                  value={profileDraft.acceptWindowMinutes}
                  onChange={(e) => setProfileDraft((d) => ({ ...d, acceptWindowMinutes: e.target.value }))}
                />
              </label>
              <p className="muted small">Confirmed orders not started within this window are auto-cancelled (online payments are refunded).</p>

              <button>Update profile</button>
            </form>
          </section>

          {vendor ? <VendorKycPanel vendor={vendor} onUpdated={setVendor} /> : null}

          <section className="panel" id="shop-summary">
            <h2>Today&apos;s summary</h2>
            <div className="summary-grid">
              <div><span>Orders</span><strong>{summary.totalOrders}</strong></div>
              <div><span>Collected revenue</span><strong>₹{summary.revenue}</strong></div>
              <div><span>Pending settlement</span><strong>₹{summary.pendingSettlement}</strong></div>
            </div>
            {vendor ? (
              <div className="qr-panel">
                <img src={vendor.qrUrl} alt={`QR code for ${vendor.name}`} />
                <a href={vendor.storefrontUrl}>{vendor.storefrontUrl}</a>
                <a className="primary-link" href={`${API_URL}/vendor/qr.png?token=${encodeURIComponent(getStoredVendorToken())}`}>
                  Download QR PNG
                </a>
              </div>
            ) : null}
          </section>

          <section className="panel" id="add-product">
            <h2>Menu management</h2>
            <form className="onboarding-form menu-form" onSubmit={saveMenuItem}>
              <label>
                Item name
                <input value={menuDraft.name} onChange={(event) => setMenuDraft((draft) => ({ ...draft, name: event.target.value }))} />
              </label>
              <label>
                Description
                <input value={menuDraft.description} onChange={(event) => setMenuDraft((draft) => ({ ...draft, description: event.target.value }))} />
              </label>
              <label>
                Price
                <input type="number" value={menuDraft.price} onChange={(event) => setMenuDraft((draft) => ({ ...draft, price: event.target.value }))} />
              </label>
              <label>
                Photo URL
                <input value={menuDraft.photoUrl} onChange={(event) => setMenuDraft((draft) => ({ ...draft, photoUrl: event.target.value }))} />
              </label>
              <label>
                Upload photo
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setMenuPhotoFile(event.target.files?.[0] ?? null)} />
              </label>
              <label>
                Category
                <input value={menuDraft.category} onChange={(event) => setMenuDraft((draft) => ({ ...draft, category: event.target.value }))} />
              </label>
              <label>
                Stock quantity
                <input
                  type="number"
                  min="0"
                  placeholder="Leave blank for unlimited"
                  value={menuDraft.stockQuantity}
                  onChange={(event) => setMenuDraft((draft) => ({ ...draft, stockQuantity: event.target.value }))}
                />
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={menuDraft.isAvailable} onChange={(event) => setMenuDraft((draft) => ({ ...draft, isAvailable: event.target.checked }))} />
                Available
              </label>
              <button disabled={!isLoggedIn}>{menuDraft.id ? "Update item" : "Add item"}</button>
            </form>
            {menu.map((item) => {
              const tracked = typeof item.stockQuantity === "number";
              const outOfStock = tracked && item.stockQuantity === 0;
              return (
                <div className="menu-toggle" key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>
                      ₹{item.price}
                      {tracked ? (
                        <span className={outOfStock ? "stock-label out" : "stock-label"}>
                          {" · "}{outOfStock ? "Out of stock" : `${item.stockQuantity} in stock`}
                        </span>
                      ) : (
                        <span className="stock-label">{" · "}Unlimited</span>
                      )}
                    </span>
                  </div>
                  <div className="button-row">
                    <button className={item.isAvailable ? "toggle on" : "toggle"} onClick={() => toggleItem(item)}>
                      {item.isAvailable ? "Available" : "Hidden"}
                    </button>
                    <button className="toggle" onClick={() => editItem(item)}>Edit</button>
                    <button className="danger-button" onClick={() => removeItem(item)}>Delete</button>
                  </div>
                </div>
              );
            })}
          </section>
        </main>
      )}
    </Shell>
  );
}

// ── Shared Components ─────────────────────────────────────────────────────────

// ── Vendor KYC Panel ──────────────────────────────────────────────────────────

function VendorKycPanel({ vendor, onUpdated }: { vendor: Vendor; onUpdated: (v: Vendor) => void }) {
  const kyc = vendor.kyc;
  const status = kyc?.status ?? "UNSUBMITTED";
  const [ownerName, setOwnerName] = React.useState(kyc?.ownerName ?? vendor.name);
  const [gstin, setGstin] = React.useState(kyc?.gstin ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await submitVendorKyc({ ownerName, gstin: gstin.trim() || undefined });
      onUpdated(res.vendor);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = status === "UNSUBMITTED" || status === "REJECTED";

  return (
    <section className="panel" id="shop-kyc">
      <h2>Shop verification</h2>
      <div className={`kyc-status kyc-${status.toLowerCase()}`}>
        {status === "VERIFIED"
          ? "✓ Verified — customers see a verified badge on your shop."
          : status === "PENDING"
          ? "⏳ Pending review — an admin will verify your shop shortly."
          : status === "REJECTED"
          ? `✗ Verification rejected${kyc?.rejectionReason ? `: ${kyc.rejectionReason}` : ""}. Update your details and resubmit.`
          : "Not submitted — add your details to earn a verified badge and build customer trust."}
      </div>
      {canSubmit ? (
        <form className="onboarding-form" onSubmit={submit}>
          <ErrorBanner message={error} onDismiss={() => setError("")} />
          <label>
            Owner / proprietor name
            <input required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label>
            GSTIN / Udyam number (optional)
            <input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="e.g. 22AAAAA0000A1Z5" />
          </label>
          <button disabled={saving || !ownerName}>{saving ? "Submitting..." : "Submit for verification"}</button>
        </form>
      ) : null}
    </section>
  );
}

// ── Admin Console ─────────────────────────────────────────────────────────────

function AdminPage() {
  const [token, setToken] = React.useState(getStoredAdminToken());
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [metrics, setMetrics] = React.useState<AdminMetrics | null>(null);
  const [adminVendors, setAdminVendors] = React.useState<AdminVendor[]>([]);
  const [recentOrders, setRecentOrders] = React.useState<(Order & { vendorName: string })[]>([]);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!getStoredAdminToken()) return;
    try {
      const [m, v, o] = await Promise.all([getAdminMetrics(), getAdminVendors(), getAdminOrders()]);
      setMetrics(m);
      setAdminVendors(v.vendors);
      setRecentOrders(o.orders);
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  React.useEffect(() => {
    if (token) refresh();
  }, [token, refresh]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await adminLogin({ email, password });
      setStoredAdminToken(res.token);
      setToken(res.token);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearStoredAdminToken();
    setToken("");
    setMetrics(null);
    setAdminVendors([]);
    setRecentOrders([]);
  }

  async function review(id: string, status: "VERIFIED" | "REJECTED", rejectionReason?: string) {
    setError("");
    try {
      await verifyVendor(id, { status, rejectionReason });
      await refresh();
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  if (!token) {
    return (
      <Shell hideVendorNav>
        <main className="auth-page">
          <section className="panel auth-panel">
            <h2>Admin login</h2>
            <p className="muted">Platform administration — manage vendor verification and view metrics.</p>
            <ErrorBanner message={error} onDismiss={() => setError("")} />
            <form className="onboarding-form" onSubmit={login}>
              <label>
                Email
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label>
                Password
                <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <button disabled={loading || !email || !password}>{loading ? "Logging in..." : "Login"}</button>
            </form>
          </section>
        </main>
      </Shell>
    );
  }

  return (
    <Shell hideVendorNav>
      <section className="hero vendor-hero">
        <div>
          <p className="eyebrow">Platform admin</p>
          <h1>Admin console</h1>
        </div>
        <div className="hero-actions">
          <button className="quiet-button" onClick={logout}>Logout</button>
        </div>
      </section>
      <main className="orders-page">
        <ErrorBanner message={error} onDismiss={() => setError("")} />

        {metrics ? (
          <div className="admin-metrics">
            <div><span>Vendors</span><strong>{metrics.totalVendors}</strong></div>
            <div><span>Verified</span><strong>{metrics.verifiedVendors}</strong></div>
            <div><span>Pending KYC</span><strong>{metrics.pendingKyc}</strong></div>
            <div><span>Customers</span><strong>{metrics.totalCustomers}</strong></div>
            <div><span>Total orders</span><strong>{metrics.totalOrders}</strong></div>
            <div><span>Active orders</span><strong>{metrics.activeOrders}</strong></div>
            <div><span>Collected revenue</span><strong>₹{metrics.collectedRevenue}</strong></div>
            <div><span>Gross order value</span><strong>₹{metrics.grossOrderValue}</strong></div>
          </div>
        ) : null}

        <section className="panel" style={{ marginTop: 24 }}>
          <div className="section-head">
            <h2>Vendors</h2>
            <span>{adminVendors.length} shops</span>
          </div>
          {adminVendors.length === 0 ? <p className="muted">No vendors yet.</p> : null}
          {adminVendors.map((v) => (
            <div className="admin-vendor-row" key={v.id}>
              <div>
                <div className="admin-vendor-head">
                  <strong>{v.name}</strong>
                  <span className={`kyc-pill kyc-${v.kyc.status.toLowerCase()}`}>{v.kyc.status}</span>
                </div>
                <p className="muted small">{v.category} · {v.locationTag} · {v.orderCount} orders · ₹{v.revenue} revenue</p>
                <p className="muted small">Owner: {v.kyc.ownerName}{v.kyc.gstin ? ` · GSTIN ${v.kyc.gstin}` : ""}</p>
              </div>
              <div className="button-row">
                {v.kyc.status !== "VERIFIED" ? (
                  <button onClick={() => review(v.id, "VERIFIED")}>Verify</button>
                ) : null}
                {v.kyc.status !== "REJECTED" ? (
                  <button
                    className="danger-button"
                    onClick={() => review(v.id, "REJECTED", prompt("Rejection reason (optional):") ?? undefined)}
                  >
                    Reject
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </section>

        <section className="panel" style={{ marginTop: 24 }}>
          <div className="section-head">
            <h2>Recent orders</h2>
            <span>{recentOrders.length}</span>
          </div>
          {recentOrders.length === 0 ? <p className="muted">No orders yet.</p> : null}
          {recentOrders.map((o) => (
            <div className="admin-order-row" key={o.id}>
              <span><strong>#{o.orderCode}</strong> · {o.vendorName}</span>
              <span className="muted">{o.orderType} · ₹{o.totalAmount}</span>
              <StatusBadge status={o.status} />
            </div>
          ))}
        </section>
      </main>
    </Shell>
  );
}

function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`status status-${status.toLowerCase()}`}>{status.replace("_", " ")}</span>;
}

function TimelineRow({ label, time, done }: { active?: boolean; done?: boolean; label: string; time?: string }) {
  return (
    <div className="timeline-row">
      <span className={done ? "dot done" : "dot"} />
      <div>
        <strong>{label}</strong>
        {time ? <span>{time}</span> : null}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
