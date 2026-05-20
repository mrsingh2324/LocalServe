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
  rateOrder,
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
  getVendorAnalytics,
  type VendorAnalytics,
  getVendorMe,
  getVendorMenu,
  getVendorOrders,
  getVendorQr,
  registerVendor,
  registerVendorByEmail,
  requestCustomerEmailOtp,
  requestCustomerOtp,
  requestVendorEmailOtp,
  requestVendorEmailRegisterOtp,
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
  uploadVendorBanner,
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

// ── Trust Signal Helpers ──────────────────────────────────────────────────────

function formatOrderCount(n: number): string {
  if (n <= 0) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(".0", "")}k+`;
  if (n >= 100) return `${Math.floor(n / 100) * 100}+`;
  return String(n);
}

function sinceYear(iso: string): number {
  return new Date(iso).getFullYear();
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

// ── Empty / Loading States ────────────────────────────────────────────────────

function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon-circle">{icon}</div>
      <p className="empty-title">{title}</p>
      {subtitle ? <p className="empty-sub">{subtitle}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

function PageLoader({ label }: { label?: string }) {
  return (
    <div className="page-loader">
      <div className="spinner" aria-hidden="true" />
      <span>{label ?? "Loading…"}</span>
    </div>
  );
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
        <RoutedApp />
      </BrowserRouter>
    </CustomerContext.Provider>
  );
}

function RoutedApp() {
  const location = useLocation();
  return (
    <div className="route-fade" key={location.pathname}>
      <Routes location={location}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<CustomerLoginPage />} />
        <Route path="/my-orders" element={<CustomerOrdersPage />} />
        <Route path="/account" element={<CustomerProfilePage />} />
        <Route path="/v/:slug" element={<CustomerStorefront />} />
        <Route path="/order/:orderId" element={<OrderStatusPage />} />
        <Route path="/vendor" element={<VendorConsole />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({ children, hideVendorNav = false }: { children: React.ReactNode; hideVendorNav?: boolean }) {
  const { customer, logout } = useCustomer();
  const location = useLocation();
  const p = location.pathname;
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function navClass(path: string) {
    return `bottom-nav-item${p === path ? " active" : ""}`;
  }

  return (
    <div>
      <header className={`topbar${scrolled ? " scrolled" : ""}`}>
        <Link to="/" className="brand">QuickOrder</Link>
        <nav>
          {customer ? (
            <>
              <Link to="/my-orders">My Orders</Link>
              <Link to="/account">Account</Link>
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
            <Link to="/account" className={navClass("/account")}>
              <span className="bottom-nav-icon">👤</span>
              <span>Account</span>
            </Link>
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

// ── Shop Card + Grid ──────────────────────────────────────────────────────────

function ShopCard({ shop }: { shop: ShopSummary }) {
  return (
    <Link to={`/v/${shop.slug}`} className="shop-card">
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
        {(shop.orderCount > 0 || shop.createdAt || shop.ratingAvg) ? (
          <div className="shop-trust-row">
            {shop.ratingAvg ? (
              <span className="trust-pill trust-pill-rating">★ {shop.ratingAvg.toFixed(1)}</span>
            ) : null}
            {shop.ratingAvg && (shop.orderCount > 0 || shop.createdAt) ? <span className="trust-dot" /> : null}
            {shop.orderCount > 0 ? (
              <span className="trust-pill trust-pill-orders">
                🛒 {formatOrderCount(shop.orderCount)} orders
              </span>
            ) : null}
            {shop.orderCount > 0 && shop.createdAt ? <span className="trust-dot" /> : null}
            {shop.createdAt ? (
              <span className="trust-pill trust-pill-since">Since {sinceYear(shop.createdAt)}</span>
            ) : null}
          </div>
        ) : null}
        <div className="shop-meta" style={{ marginTop: 8 }}>
          {shop.deliveryEnabled ? (
            <span className="delivery-badge">Delivery ₹{shop.deliveryFeeFlat}</span>
          ) : (
            <span className="pickup-badge">Pickup only</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function ShopGrid({ shops, searchActive, activeCategory }: { shops: ShopSummary[]; searchActive: boolean; activeCategory: string }) {
  const grouped = React.useMemo(() => {
    if (searchActive) return null;
    const map = new Map<string, ShopSummary[]>();
    for (const shop of shops) {
      const key = shop.locationTag || "Other";
      const existing = map.get(key);
      if (existing) existing.push(shop);
      else map.set(key, [shop]);
    }
    return map.size > 1 ? map : null;
  }, [shops, searchActive]);

  if (grouped) {
    return (
      <>
        {[...grouped.entries()].map(([area, areaShops]) => (
          <div key={area} className="locality-section">
            <h2 className="locality-heading">
              <span className="locality-pin">📍</span>
              {area}
            </h2>
            <div className="shops-grid">
              {areaShops.map((shop) => <ShopCard key={shop.id} shop={shop} />)}
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      <p className="shops-section-title">
        {searchActive ? `Results` : (activeCategory === "All" ? "All Shops" : activeCategory)} · {shops.length} near you
      </p>
      <div className="shops-grid">
        {shops.map((shop) => <ShopCard key={shop.id} shop={shop} />)}
      </div>
    </>
  );
}

// ── Home Page ─────────────────────────────────────────────────────────────────

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const [allShops, setAllShops] = React.useState<ShopSummary[]>([]);
  const [shops, setShops] = React.useState<ShopSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState("");
  const [activeCategory, setActiveCategory] = React.useState("All");
  const [deliveryOnly, setDeliveryOnly] = React.useState(false);
  const [error, setError] = React.useState("");
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(-1);
  const searchWrapRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load all shops once for autocomplete
  React.useEffect(() => {
    getShops()
      .then((data) => setAllShops(data.shops))
      .catch(() => {});
  }, []);

  // Initial + category/delivery filter fetch
  React.useEffect(() => {
    runSearch(search, activeCategory, deliveryOnly);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory, deliveryOnly]);

  function runSearch(q: string, category: string, delivery: boolean) {
    setLoading(true);
    const params: { category?: string; q?: string; deliveryOnly?: boolean } = {};
    if (category !== "All") params.category = category;
    if (q.trim()) params.q = q.trim();
    if (delivery) params.deliveryOnly = true;
    getShops(params)
      .then((data) => { setShops(data.shops); setLoading(false); })
      .catch((err) => { setError(messageFromError(err)); setLoading(false); });
  }

  function handleSearchChange(value: string) {
    setSearch(value);
    setActiveIdx(-1);
    setShowSuggestions(value.trim().length > 0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch(value, activeCategory, deliveryOnly);
    }, 280);
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setShowSuggestions(false);
    runSearch(search, activeCategory, deliveryOnly);
    inputRef.current?.blur();
  }

  // Click-outside closes dropdown
  React.useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Build suggestions — filter allShops client-side
  const suggestions = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{ type: "shop"; shop: ShopSummary } | { type: "area"; area: string; count: number }> = [];

    // Matching shops (max 4)
    for (const s of allShops) {
      if (s.name.toLowerCase().includes(q) || (s.category ?? "").toLowerCase().includes(q)) {
        results.push({ type: "shop", shop: s });
        if (results.filter((r) => r.type === "shop").length >= 4) break;
      }
    }

    // Matching areas (deduplicated, max 2)
    const seenAreas = new Set<string>();
    for (const s of allShops) {
      if (s.locationTag.toLowerCase().includes(q) && !seenAreas.has(s.locationTag)) {
        seenAreas.add(s.locationTag);
        const count = allShops.filter((x) => x.locationTag === s.locationTag).length;
        results.push({ type: "area", area: s.locationTag, count });
        if ([...results].filter((r) => r.type === "area").length >= 2) break;
      }
    }

    return results.slice(0, 6);
  }, [search, allShops]);

  function handleSuggestionClick(item: typeof suggestions[number]) {
    setShowSuggestions(false);
    if (item.type === "shop") {
      navigate(`/v/${item.shop.slug}`);
    } else {
      setSearch(item.area);
      runSearch(item.area, activeCategory, deliveryOnly);
      inputRef.current?.blur();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      handleSuggestionClick(suggestions[activeIdx]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  return (
    <Shell hideVendorNav={false}>
      <section className="home-hero">
        <div className="home-hero-content">
          <p className="eyebrow">Your neighbourhood, online</p>
          <h1>Pick up from local shops near you</h1>
          <p>Browse, order & skip the queue. No middlemen, just your local shop.</p>
          <form className="search-bar" onSubmit={handleSearchSubmit}>
            <div className="search-wrap" ref={searchWrapRef}>
              <input
                ref={inputRef}
                type="search"
                placeholder="Search shops by name or area..."
                value={search}
                autoComplete="off"
                onChange={(e) => handleSearchChange(e.target.value)}
                onFocus={() => { if (search.trim()) setShowSuggestions(true); }}
                onKeyDown={handleKeyDown}
                aria-autocomplete="list"
                aria-expanded={showSuggestions && suggestions.length > 0}
              />
              {showSuggestions && suggestions.length > 0 ? (
                <div className="search-suggestions" role="listbox">
                  {suggestions.map((item, idx) => (
                    <button
                      key={item.type === "shop" ? item.shop.id : item.area}
                      className="suggestion-item"
                      role="option"
                      aria-selected={idx === activeIdx}
                      onPointerDown={(e) => { e.preventDefault(); handleSuggestionClick(item); }}
                    >
                      <span className="suggestion-icon">
                        {item.type === "shop"
                          ? (CATEGORY_EMOJIS[item.shop.category ?? "Other"] ?? "🏪")
                          : "📍"}
                      </span>
                      <span className="suggestion-info">
                        <span className="suggestion-name">
                          {item.type === "shop"
                            ? highlight(item.shop.name, search.trim())
                            : highlight(item.area, search.trim())}
                        </span>
                        <span className="suggestion-sub">
                          {item.type === "shop"
                            ? item.shop.locationTag
                            : `${item.count} shop${item.count !== 1 ? "s" : ""} in this area`}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
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
                onClick={() => { setActiveCategory(cat); setShowSuggestions(false); }}
              >
                <span className="chip-emoji">{CATEGORY_EMOJIS[cat]}</span>
                <span>{cat}</span>
              </button>
            ))}
            <button
              type="button"
              className={`chip${deliveryOnly ? " chip-active" : ""}`}
              onClick={() => { setDeliveryOnly((v) => !v); setShowSuggestions(false); }}
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
          <EmptyState
            icon="🔍"
            title="No shops found"
            subtitle="Try a different search term or category to discover shops near you."
          />
        ) : (
          <ShopGrid shops={shops} searchActive={search.trim().length > 0} activeCategory={activeCategory} />
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

function StarRating({ orderId, onRated }: { orderId: string; onRated: (stars: number) => void }) {
  const [hovered, setHovered] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(stars: number) {
    setSubmitting(true);
    try {
      await rateOrder(orderId, stars);
      onRated(stars);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="star-rating" aria-label="Rate this order">
      <span className="star-rating-label">Rate</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={`star-btn${n <= hovered ? " lit" : ""}`}
          onMouseEnter={() => setHovered(n)}
          onMouseLeave={() => setHovered(0)}
          onClick={() => !submitting && submit(n)}
          aria-label={`${n} star${n !== 1 ? "s" : ""}`}
          disabled={submitting}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function CustomerOrdersPage() {
  const { customer } = useCustomer();
  const navigate = useNavigate();
  const { setQuantity, clear } = useCartStore();
  const [orders, setOrders] = React.useState<(Order & { vendorName: string; vendorSlug: string })[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [reorderToast, setReorderToast] = React.useState("");

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

  function handleReorder(order: Order & { vendorSlug: string; vendorName: string }) {
    clear();
    for (const item of order.items) {
      setQuantity(item.menuItemId, item.quantity);
    }
    setReorderToast(`${order.items.length} item${order.items.length !== 1 ? "s" : ""} added — check availability`);
    setTimeout(() => setReorderToast(""), 3500);
    navigate(`/v/${order.vendorSlug}`);
  }

  return (
    <Shell>
      <section className="hero vendor-hero">
        <div>
          <p className="eyebrow">Your account</p>
          <h1>My Orders</h1>
        </div>
      </section>
      {reorderToast ? (
        <div className="reorder-toast">
          🛒 {reorderToast}
        </div>
      ) : null}
      <main className="orders-page">
        <ErrorBanner message={error} onDismiss={() => setError("")} />
        {loading ? (
          <PageLoader label="Loading your orders…" />
        ) : orders.length === 0 ? (
          <EmptyState
            icon="🧾"
            title="No orders yet"
            subtitle="When you place an order it'll show up here so you can track and reorder it."
            action={<Link to="/">Browse shops</Link>}
          />
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
                <p className="order-items-list">{order.items.map((i) => `${i.name} ×${i.quantity}`).join(", ")}</p>
                {order.status === "COLLECTED" && !order.rating ? (
                  <StarRating
                    orderId={order.id}
                    onRated={(stars) =>
                      setOrders((prev) => prev.map((o) => o.id === order.id ? { ...o, rating: stars } : o))
                    }
                  />
                ) : order.rating ? (
                  <p className="rated-line">{"★".repeat(order.rating)}{"☆".repeat(5 - order.rating)} <span className="muted">Your rating</span></p>
                ) : null}
                <div className="order-history-bottom">
                  <div>
                    <span className="muted">{new Date(order.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
                    <span className="muted"> · {order.orderType === "delivery" ? "Delivery" : "Pickup"} · {order.paymentMethod === "cash" ? "Cash" : "Online"}</span>
                  </div>
                  <div className="button-row">
                    <strong>₹{order.totalAmount}</strong>
                    {order.status === "COLLECTED" && order.vendorSlug ? (
                      <button className="reorder-btn" onClick={() => handleReorder(order)}>
                        🔁 Reorder
                      </button>
                    ) : null}
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

      </main>
    </Shell>
  );
}

// ── Customer Profile Page ─────────────────────────────────────────────────────

function CustomerProfilePage() {
  const { customer, setCustomer, logout } = useCustomer();
  const navigate = useNavigate();
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(customer?.name ?? "");
  const [email, setEmail] = React.useState(customer?.email ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [successMsg, setSuccessMsg] = React.useState("");

  React.useEffect(() => {
    if (!customer) navigate("/login");
  }, [customer, navigate]);

  React.useEffect(() => {
    setName(customer?.name ?? "");
    setEmail(customer?.email ?? "");
  }, [customer]);

  if (!customer) return null;

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await updateCustomerProfile({ name: name.trim(), email: email.trim() || undefined });
      setCustomer(res.customer);
      setEditing(false);
      setSuccessMsg("Profile updated");
      setTimeout(() => setSuccessMsg(""), 3000);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  function handleLogout() {
    logout();
    navigate("/");
  }

  return (
    <Shell>
      <section className="hero vendor-hero">
        <div>
          <p className="eyebrow">Your account</p>
          <h1>Profile</h1>
        </div>
      </section>
      <main className="orders-page">
        <ErrorBanner message={error} onDismiss={() => setError("")} />
        {successMsg ? <div className="success-banner">{successMsg}</div> : null}

        <section className="panel">
          <div className="panel-header">
            <h2>Personal info</h2>
            {!editing && (
              <button className="quiet-button" onClick={() => setEditing(true)}>Edit</button>
            )}
          </div>

          {editing ? (
            <form className="onboarding-form" onSubmit={saveProfile}>
              <label>
                Name
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <div className="button-row">
                <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                <button type="button" className="quiet-button" onClick={() => { setEditing(false); setName(customer.name); setEmail(customer.email ?? ""); }}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="profile-info-rows">
              <div className="profile-info-row">
                <span className="profile-info-label">Name</span>
                <span>{customer.name}</span>
              </div>
              {customer.phone && (
                <div className="profile-info-row">
                  <span className="profile-info-label">Phone</span>
                  <span>{customer.phone}</span>
                </div>
              )}
              {customer.email && (
                <div className="profile-info-row">
                  <span className="profile-info-label">Email</span>
                  <span>{customer.email}</span>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="panel" style={{ marginTop: 24 }}>
          <div className="panel-header">
            <h2>Saved addresses</h2>
          </div>
          <AddressBook />
        </section>

        <section className="panel" style={{ marginTop: 24 }}>
          <button className="danger-button" style={{ width: "100%" }} onClick={handleLogout}>
            Log out
          </button>
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

// ── Menu Section with category tabs ──────────────────────────────────────────

function MenuSection({
  menuItems,
  quantities,
  setQuantity,
}: {
  menuItems: MenuItem[];
  quantities: Record<string, number>;
  setQuantity: (id: string, qty: number) => void;
}) {
  const categories = React.useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const item of menuItems) {
      if (!seen.has(item.category)) { seen.add(item.category); order.push(item.category); }
    }
    return order;
  }, [menuItems]);

  const [activeTab, setActiveTab] = React.useState<string>("");

  React.useEffect(() => {
    if (categories.length > 0 && !activeTab) setActiveTab(categories[0]);
  }, [categories, activeTab]);

  const tabsRef = React.useRef<HTMLDivElement>(null);

  function scrollTo(cat: string) {
    setActiveTab(cat);
    const el = document.getElementById(`menu-cat-${CSS.escape(cat)}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    // keep active tab visible in the strip
    const btn = tabsRef.current?.querySelector<HTMLButtonElement>(`[data-cat="${CSS.escape(cat)}"]`);
    btn?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }

  // Update active tab on scroll (intersection observer)
  React.useEffect(() => {
    if (categories.length <= 1) return;
    const observers: IntersectionObserver[] = [];
    for (const cat of categories) {
      const el = document.getElementById(`menu-cat-${CSS.escape(cat)}`);
      if (!el) continue;
      const obs = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) setActiveTab(cat); },
        { rootMargin: "-40% 0px -55% 0px", threshold: 0 }
      );
      obs.observe(el);
      observers.push(obs);
    }
    return () => observers.forEach((o) => o.disconnect());
  }, [categories]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, MenuItem[]>();
    for (const cat of categories) map.set(cat, []);
    for (const item of menuItems) map.get(item.category)?.push(item);
    return map;
  }, [menuItems, categories]);

  return (
    <section>
      <div className="section-head">
        <h2>Menu</h2>
        <span>{menuItems.length} available</span>
      </div>

      {categories.length > 1 && (
        <div className="menu-cat-tabs" ref={tabsRef}>
          {categories.map((cat) => (
            <button
              key={cat}
              data-cat={cat}
              className={`menu-cat-tab${activeTab === cat ? " active" : ""}`}
              onClick={() => scrollTo(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {[...grouped.entries()].map(([cat, items]) => (
        <div key={cat} className="menu-cat-section">
          <h3 id={`menu-cat-${CSS.escape(cat)}`} className="menu-cat-heading">{cat}</h3>
          <div className="menu-grid">
            {items.map((item) => {
              const lowStock = typeof item.stockQuantity === "number" && item.stockQuantity <= 5;
              const stockCap = typeof item.stockQuantity === "number" ? item.stockQuantity : Infinity;
              return (
                <article className={`menu-card${(quantities[item.id] ?? 0) > 0 ? " in-cart" : ""}`} key={item.id}>
                  <img src={item.photoUrl} alt="" />
                  <div className="menu-card-body">
                    <div>
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
        </div>
      ))}
    </section>
  );
}

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
  const [cartSheetOpen, setCartSheetOpen] = React.useState(false);
  const { quantities, setQuantity, clear } = useCartStore();

  React.useEffect(() => {
    if (!cartSheetOpen) return;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [cartSheetOpen]);

  React.useEffect(() => {
    if (!slug) return;
    setError("");
    setStorefrontLoading(true);
    getStorefront(slug)
      .then((data) => {
        setVendor(data.vendor as unknown as typeof vendor);
        setMenuItems(data.menuItems);
        if (!(data.vendor.cashEnabled ?? true)) setPaymentMethod("online");
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
  const cashEnabled = (vendor as { cashEnabled?: boolean })?.cashEnabled ?? true;

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

  if (!vendor) return (
    <Shell hideVendorNav>
      <EmptyState
        icon="🏪"
        title={error || "Shop not found"}
        subtitle="This shop may have moved or the link is incorrect."
        action={<Link to="/">Go home</Link>}
      />
    </Shell>
  );

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
          {(vendor as { ratingAvg?: number | null }).ratingAvg ? (
            <p className="hero-rating">
              ★ {((vendor as { ratingAvg: number }).ratingAvg).toFixed(1)}
              <span className="hero-rating-count"> ({(vendor as { ratingCount?: number }).ratingCount} review{(vendor as { ratingCount?: number }).ratingCount !== 1 ? "s" : ""})</span>
            </p>
          ) : null}
        </div>
      </section>

      {placedOrder ? (
        <OrderConfirmation order={placedOrder} vendorName={(vendor as { name?: string }).name ?? "Shop"} />
      ) : (
        <main className="customer-grid">
          <MenuSection menuItems={menuItems} quantities={quantities} setQuantity={setQuantity} />

          <aside className={`cart-panel${cartSheetOpen ? " open" : ""}`}>
            <div className="cart-sheet-header">
              <span className="cart-sheet-grip" aria-hidden="true" />
              <button
                type="button"
                className="cart-sheet-close"
                aria-label="Close order summary"
                onClick={() => setCartSheetOpen(false)}
              >
                ✕
              </button>
            </div>
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

            {cashEnabled ? (
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
                  Cash {orderType === "delivery" ? "on delivery" : "at counter"}
                </button>
              </div>
            ) : null}
            {paymentMethod === "cash" ? (
              <p className="cash-hint">💵 You'll pay <strong>₹{total}</strong> {orderType === "delivery" ? "on delivery" : "at the counter"} when collecting your order.</p>
            ) : null}

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
      {!placedOrder && cartSheetOpen ? (
        <div className="cart-sheet-backdrop" onClick={() => setCartSheetOpen(false)} />
      ) : null}
      {!placedOrder && cartLines.length > 0 && !cartSheetOpen ? (
        <div className="cart-bar">
          <div className="cart-bar-info">
            <span className="cart-bar-count">{cartLines.reduce((s, l) => s + l.quantity, 0)} item{cartLines.reduce((s, l) => s + l.quantity, 0) !== 1 ? "s" : ""}</span>
            <span className="cart-bar-total">₹{itemsTotal + (orderType === "delivery" ? ((vendor as { deliveryFeeFlat?: number }).deliveryFeeFlat ?? 0) : 0)}</span>
          </div>
          <button
            className="cart-bar-btn"
            onClick={() => setCartSheetOpen(true)}
          >
            View order →
          </button>
        </div>
      ) : null}
    </Shell>
  );
}

function QuantityControl({ value, onChange }: { value: number; onChange: (quantity: number) => void }) {
  const [popping, setPopping] = React.useState(false);
  const prevRef = React.useRef(value);

  React.useEffect(() => {
    if (prevRef.current === 0 && value === 1) {
      setPopping(true);
      const t = setTimeout(() => setPopping(false), 300);
      return () => clearTimeout(t);
    }
    prevRef.current = value;
  }, [value]);

  if (value === 0) {
    return (
      <button
        className="qty-add-btn"
        aria-label="Add to cart"
        onClick={() => onChange(1)}
      >
        + Add
      </button>
    );
  }

  return (
    <div className={`qty${popping ? " popping" : ""}`}>
      <button onClick={() => onChange(value - 1)} aria-label="Decrease quantity">−</button>
      <span>{value}</span>
      <button onClick={() => onChange(value + 1)} aria-label="Increase quantity">+</button>
    </div>
  );
}

function OrderConfirmation({ order, vendorName }: { order: Order; vendorName: string }) {
  const isCash = order.paymentMethod === "cash";
  return (
    <section className="confirmation">
      <div className="success-mark">✓</div>
      <p className="eyebrow">{isCash ? "Order placed" : "Payment confirmed"}</p>
      <h2>Order confirmed</h2>
      <div className="order-code">{order.orderCode}</div>
      {isCash ? (
        <p>
          Show this code at <strong>{vendorName}</strong> and pay{" "}
          <strong>₹{order.totalAmount}</strong>{" "}
          {order.orderType === "delivery" ? "on delivery" : "at the counter"}.
        </p>
      ) : (
        <p>
          {order.orderType === "delivery"
            ? "Your order is on its way. Track live status below."
            : "Your order is confirmed. Keep this code ready for pickup."}
        </p>
      )}
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

  if (!order || !vendor) return <Shell><PageLoader label="Loading order…" /></Shell>;

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

// ── Banner Upload ─────────────────────────────────────────────────────────────

function BannerUpload({ currentUrl, onUploaded }: { currentUrl?: string; onUploaded: (vendor: import("@localserve/shared-types").Vendor) => void }) {
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) { setError("Please choose an image file."); return; }
    if (file.size > 4 * 1024 * 1024) { setError("Image must be under 4 MB."); return; }
    setError("");
    setUploading(true);
    try {
      const { vendor } = await uploadVendorBanner(file);
      onUploaded(vendor);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="banner-upload-wrap">
      <div
        className={`banner-upload-target${uploading ? " uploading" : ""}`}
        style={currentUrl ? { backgroundImage: `url(${currentUrl})` } : undefined}
        onClick={() => !uploading && inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        aria-label="Upload shop banner"
      >
        {uploading ? (
          <span className="banner-upload-label">Uploading…</span>
        ) : currentUrl ? (
          <span className="banner-upload-label banner-change-label">📷 Change photo</span>
        ) : (
          <div className="banner-upload-empty">
            <span className="banner-upload-icon">🖼️</span>
            <span className="banner-upload-label">Add shop banner</span>
            <span className="banner-upload-hint">Click or drag & drop · JPG/PNG under 4 MB</span>
          </div>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

// ── Order Accept Countdown ────────────────────────────────────────────────────

function OrderCountdown({
  createdAt,
  windowMinutes,
  onExpired,
}: {
  createdAt: string;
  windowMinutes: number;
  onExpired: () => void;
}) {
  const deadlineMs = new Date(createdAt).getTime() + windowMinutes * 60 * 1000;
  const [remaining, setRemaining] = React.useState(() => Math.max(0, deadlineMs - Date.now()));
  const firedRef = React.useRef(false);

  React.useEffect(() => {
    if (remaining === 0) return;
    const interval = setInterval(() => {
      const left = Math.max(0, deadlineMs - Date.now());
      setRemaining(left);
      if (left === 0 && !firedRef.current) {
        firedRef.current = true;
        onExpired();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [deadlineMs, onExpired, remaining]);

  const totalMs = windowMinutes * 60 * 1000;
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const urgent = remaining < 2 * 60 * 1000;
  const warning = remaining < 5 * 60 * 1000;
  const pct = remaining / totalMs;

  if (remaining === 0) return <span className="countdown expired">Expired</span>;

  return (
    <span className={`countdown${urgent ? " urgent" : warning ? " warning" : ""}`}>
      <svg className="countdown-ring" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8" />
        <circle
          cx="10" cy="10" r="8"
          className="countdown-ring-fill"
          strokeDasharray={`${2 * Math.PI * 8}`}
          strokeDashoffset={`${2 * Math.PI * 8 * (1 - pct)}`}
        />
      </svg>
      {minutes}:{String(seconds).padStart(2, "0")}
    </span>
  );
}

// ── Vendor Analytics Panel ────────────────────────────────────────────────────

function VendorAnalyticsPanel({ analytics }: { analytics: VendorAnalytics | null }) {
  if (!analytics) return null;
  const { summary, topItems, dailyRevenue, hourlyOrders } = analytics;

  if (summary.totalOrders === 0) {
    return (
      <section className="panel analytics-panel" id="analytics">
        <div className="section-head">
          <h2>Analytics</h2>
        </div>
        <p className="muted small">Insights will appear here once you have collected orders.</p>
      </section>
    );
  }

  const maxDailyRevenue = Math.max(1, ...dailyRevenue.map((d) => d.revenue));
  const maxHourly = Math.max(1, ...hourlyOrders);
  const maxItemQty = Math.max(1, ...topItems.map((i) => i.quantitySold));

  return (
    <section className="panel analytics-panel" id="analytics">
      <div className="section-head">
        <h2>Analytics</h2>
        <span>Lifetime · IST</span>
      </div>

      <div className="analytics-stats">
        <div><span>Revenue</span><strong>₹{summary.totalRevenue}</strong></div>
        <div><span>Orders</span><strong>{summary.totalOrders}</strong></div>
        <div><span>Avg order</span><strong>₹{summary.avgOrderValue}</strong></div>
        <div><span>Customers</span><strong>{summary.uniqueCustomers}</strong></div>
      </div>

      {topItems.length > 0 ? (
        <div className="analytics-block">
          <h3 className="analytics-h">Top sellers</h3>
          <div className="top-items">
            {topItems.map((item, i) => (
              <div className="top-item" key={item.menuItemId}>
                <span className="top-item-rank">#{i + 1}</span>
                <div className="top-item-info">
                  <strong>{item.name}</strong>
                  <span className="muted small">{item.quantitySold} sold · ₹{item.revenue}</span>
                </div>
                <div className="top-item-bar-wrap">
                  <div className="top-item-bar" style={{ width: `${(item.quantitySold / maxItemQty) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="analytics-block">
        <h3 className="analytics-h">Revenue · last 14 days</h3>
        <div className="bar-chart">
          {dailyRevenue.map((d) => {
            const heightPct = (d.revenue / maxDailyRevenue) * 100;
            const dt = new Date(`${d.date}T00:00:00+05:30`);
            return (
              <div className="bar-col" key={d.date} title={`${dt.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} — ₹${d.revenue} · ${d.orders} orders`}>
                <div className="bar-wrap">
                  <div className="bar bar-revenue" style={{ height: `${heightPct}%` }} />
                </div>
                <span className="bar-label">{dt.getDate()}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="analytics-block">
        <h3 className="analytics-h">Peak hours</h3>
        <div className="bar-chart">
          {hourlyOrders.map((count, h) => {
            const heightPct = (count / maxHourly) * 100;
            return (
              <div className="bar-col" key={h} title={`${h}:00 — ${count} order${count !== 1 ? "s" : ""}`}>
                <div className="bar-wrap">
                  <div className="bar bar-hour" style={{ height: `${heightPct}%` }} />
                </div>
                <span className="bar-label">{h % 6 === 0 ? `${h}h` : ""}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── Low Stock Widget ──────────────────────────────────────────────────────────

const LOW_STOCK_THRESHOLD = 5;

function LowStockWidget({
  menu,
  setMenu,
  onError,
}: {
  menu: MenuItem[];
  setMenu: React.Dispatch<React.SetStateAction<MenuItem[]>>;
  onError: (msg: string) => void;
}) {
  const trackedItems = menu.filter((item) => typeof item.stockQuantity === "number");
  if (trackedItems.length === 0) return null;

  const lowItems = trackedItems
    .filter((item) => (item.stockQuantity ?? 0) <= LOW_STOCK_THRESHOLD)
    .sort((a, b) => (a.stockQuantity ?? 0) - (b.stockQuantity ?? 0));

  const [pendingId, setPendingId] = React.useState<string>("");

  async function bump(item: MenuItem, by: number) {
    if (pendingId) return;
    const current = item.stockQuantity ?? 0;
    const next = current + by;
    setPendingId(item.id);
    setMenu((prev) => prev.map((m) => m.id === item.id ? { ...m, stockQuantity: next } : m));
    try {
      const res = await updateMenuItem(item.id, { stockQuantity: next });
      setMenu((prev) => prev.map((m) => m.id === item.id ? res.menuItem : m));
    } catch (err) {
      setMenu((prev) => prev.map((m) => m.id === item.id ? { ...m, stockQuantity: current } : m));
      onError(messageFromError(err));
    } finally {
      setPendingId("");
    }
  }

  return (
    <section className="panel low-stock-widget">
      <div className="section-head">
        <h2>Low stock</h2>
        <span>{lowItems.length} item{lowItems.length !== 1 ? "s" : ""}</span>
      </div>
      {lowItems.length === 0 ? (
        <p className="muted small low-stock-clear">✓ All tracked items are well-stocked.</p>
      ) : (
        <div className="low-stock-list">
          {lowItems.map((item) => {
            const qty = item.stockQuantity ?? 0;
            const out = qty === 0;
            return (
              <div className="low-stock-row" key={item.id}>
                <img className="low-stock-thumb" src={item.photoUrl} alt="" />
                <div className="low-stock-info">
                  <strong>{item.name}</strong>
                  <span className={`stock-pill${out ? " out" : ""}`}>
                    {out ? "Out of stock" : `${qty} left`}
                  </span>
                </div>
                <div className="low-stock-actions">
                  {[5, 10, 25].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className="restock-chip"
                      disabled={pendingId === item.id}
                      onClick={() => bump(item, n)}
                    >
                      +{n}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Vendor Console ────────────────────────────────────────────────────────────

function VendorConsole() {
  const [orders, setOrders] = React.useState<Order[]>([]);
  const [menu, setMenu] = React.useState<MenuItem[]>([]);
  const [vendor, setVendor] = React.useState<Vendor | null>(null);
  const [demoVendors, setDemoVendors] = React.useState<Vendor[]>([]);
  const [summary, setSummary] = React.useState({ totalOrders: 0, revenue: 0, pendingSettlement: 0 });
  const [analytics, setAnalytics] = React.useState<VendorAnalytics | null>(null);
  const [authMode, setAuthMode] = React.useState<"entry" | "login" | "signup">("entry");
  const [loginDraft, setLoginDraft] = React.useState({ phone: "", email: "", otpCode: "" });
  const [loginMethod, setLoginMethod] = React.useState<"phone" | "email">("phone");
  const [signupMethod, setSignupMethod] = React.useState<"phone" | "email">("email");
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
    cashEnabled: true,
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
    const [orderData, menuData, qrData, dashboard, analyticsData] = await Promise.all([
      getVendorOrders(),
      getVendorMenu(),
      getVendorQr(),
      getDashboard(),
      getVendorAnalytics()
    ]);
    setOrders(orderData.orders);
    setMenu(menuData.menuItems);
    setVendor(qrData.vendor);
    setSummary({ totalOrders: dashboard.totalOrders, revenue: dashboard.revenue, pendingSettlement: dashboard.pendingSettlement });
    setAnalytics(analyticsData);
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
            cashEnabled: data.vendor.cashEnabled ?? true,
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
      const response = signupMethod === "email"
        ? await requestVendorEmailRegisterOtp(profileDraft.email)
        : await requestVendorOtp({ phone: profileDraft.phone, purpose: "register" });
      setRegisterOtpSent(true);
      const target = signupMethod === "email" ? profileDraft.email : profileDraft.phone;
      setAuthMessage(response.devOtp ? `Dev OTP: ${response.devOtp}` : `Code sent to ${target}.`);
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
      const response = signupMethod === "email"
        ? await registerVendorByEmail({
            name: profileDraft.name,
            email: profileDraft.email,
            otpCode: profileDraft.otpCode,
            locationTag: profileDraft.locationTag,
            upiId: profileDraft.upiId,
            phone: profileDraft.phone || undefined
          })
        : await registerVendor(profileDraft);
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
        cashEnabled: profileDraft.cashEnabled,
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
    setAnalytics(null);
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
              <div className="auth-method-toggle">
                <button
                  type="button"
                  className={signupMethod === "email" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => { setSignupMethod("email"); setRegisterOtpSent(false); setAuthMessage(""); setError(""); }}
                >
                  Email
                </button>
                <button
                  type="button"
                  className={signupMethod === "phone" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => { setSignupMethod("phone"); setRegisterOtpSent(false); setAuthMessage(""); setError(""); }}
                >
                  Mobile number
                </button>
              </div>
              <form className="onboarding-form" onSubmit={registerShop}>
                <label>
                  Shop name
                  <input required value={profileDraft.name} onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))} />
                </label>

                {signupMethod === "email" ? (
                  <>
                    <label>
                      Email address
                      <input required type="email" value={profileDraft.email} onChange={(event) => {
                        setProfileDraft((draft) => ({ ...draft, email: event.target.value, otpCode: "" }));
                        setRegisterOtpSent(false);
                        setAuthMessage("");
                      }} />
                    </label>
                    <button type="button" className="quiet-button" onClick={sendRegisterOtp} disabled={!profileDraft.email}>
                      Send verification code
                    </button>
                    {registerOtpSent ? (
                      <label>
                        Verification code
                        <input value={profileDraft.otpCode} onChange={(event) => setProfileDraft((draft) => ({ ...draft, otpCode: event.target.value }))} placeholder="Check your inbox" />
                      </label>
                    ) : null}
                  </>
                ) : (
                  <>
                    <label>
                      Mobile number
                      <input required value={profileDraft.phone} onChange={(event) => {
                        setProfileDraft((draft) => ({ ...draft, phone: event.target.value, otpCode: "" }));
                        setRegisterOtpSent(false);
                        setAuthMessage("");
                      }} />
                    </label>
                    <button type="button" className="quiet-button" onClick={sendRegisterOtp} disabled={!profileDraft.phone}>
                      Send OTP
                    </button>
                    {registerOtpSent ? (
                      <label>
                        OTP
                        <input value={profileDraft.otpCode} onChange={(event) => setProfileDraft((draft) => ({ ...draft, otpCode: event.target.value }))} />
                      </label>
                    ) : null}
                  </>
                )}

                <label>
                  Location / area
                  <input required value={profileDraft.locationTag} onChange={(event) => setProfileDraft((draft) => ({ ...draft, locationTag: event.target.value }))} />
                </label>

                {signupMethod === "email" ? (
                  <label>
                    Mobile number <span className="form-hint">(optional — for SMS order alerts)</span>
                    <input value={profileDraft.phone} onChange={(event) => setProfileDraft((draft) => ({ ...draft, phone: event.target.value }))} />
                  </label>
                ) : (
                  <label>
                    Email <span className="form-hint">(optional — enables email login)</span>
                    <input type="email" value={profileDraft.email} onChange={(event) => setProfileDraft((draft) => ({ ...draft, email: event.target.value }))} />
                  </label>
                )}

                <label>
                  UPI ID
                  <input required value={profileDraft.upiId} onChange={(event) => setProfileDraft((draft) => ({ ...draft, upiId: event.target.value }))} />
                </label>
                {signupMethod === "phone" ? (
                  <label>
                    Password
                    <input required minLength={6} type="password" value={profileDraft.password} onChange={(event) => setProfileDraft((draft) => ({ ...draft, password: event.target.value }))} />
                  </label>
                ) : null}
                {authMessage ? <p className="token-note">{authMessage}</p> : null}
                <button disabled={
                  !registerOtpSent || !profileDraft.otpCode || !profileDraft.name || !profileDraft.locationTag || !profileDraft.upiId ||
                  (signupMethod === "phone" && profileDraft.password.length < 6)
                }>
                  Create shop
                </button>
              </form>
            </section>
          ) : null}
        </main>
      ) : (
        <main className="vendor-grid">
          {!(vendor as { bannerUrl?: string }).bannerUrl ? (
            <div className="setup-nudge">
              <div className="setup-nudge-icon">🖼️</div>
              <div>
                <strong>Add a shop banner</strong>
                <p>A banner makes your shop stand out on the home page. Takes 10 seconds.</p>
              </div>
              <button className="nudge-cta" onClick={() => goToPanel("shop-profile")}>Add photo →</button>
            </div>
          ) : null}
          <section className="panel vendor-action-panel">
            <p className="eyebrow">Quick actions</p>
            <div className="vendor-action-grid">
              <button className="large-action" onClick={() => goToPanel("live-queue")}>Live queue</button>
              <button className="large-action" onClick={() => goToPanel("add-product")}>Add product</button>
              <button className="large-action" onClick={() => goToPanel("shop-summary")}>Total summary</button>
              <button className="large-action" onClick={() => goToPanel("shop-profile")}>Edit shop info</button>
            </div>
          </section>

          <LowStockWidget menu={menu} setMenu={setMenu} onError={setError} />

          <section className="panel queue-panel" id="live-queue">
            <div className="section-head">
              <h2>Live queue</h2>
              <span>{orders.length} orders</span>
            </div>
            {orders.length === 0 ? (
              <EmptyState
                icon="📭"
                title="No orders yet"
                subtitle="New paid orders land here instantly — keep this page open during business hours."
              />
            ) : null}
            {orders.map((order) => {
              const windowMinutes = vendor?.acceptWindowMinutes ?? 15;
              const showCountdown = order.status === "CONFIRMED";
              return (
              <article className="order-card" key={order.id}>
                <div className="order-card-top">
                  <strong>#{order.orderCode}</strong>
                  <div className="order-card-badges">
                    <StatusBadge status={order.status} />
                    {showCountdown && (
                      <OrderCountdown
                        createdAt={order.createdAt}
                        windowMinutes={windowMinutes}
                        onExpired={() =>
                          setOrders((prev) =>
                            prev.map((o) => o.id === order.id ? { ...o, status: "CANCELLED" } : o)
                          )
                        }
                      />
                    )}
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
              );
            })}
          </section>

          <section className="panel" id="shop-profile">
            <h2>Shop profile</h2>
            <p className="muted small" style={{ marginBottom: 16 }}>Your banner appears on the home page and your storefront. Recommended: 1200×400 px.</p>
            <BannerUpload
              currentUrl={(vendor as { bannerUrl?: string }).bannerUrl}
              onUploaded={(updated) => { setVendor(updated); }}
            />
            <form className="onboarding-form" style={{ marginTop: 20 }} onSubmit={updateProfile}>
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
              <label className="checkbox-row">
                <input type="checkbox" checked={profileDraft.cashEnabled ?? true} onChange={(e) => setProfileDraft((d) => ({ ...d, cashEnabled: e.target.checked }))} />
                Accept cash at counter
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

          <VendorAnalyticsPanel analytics={analytics} />

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
  const isLive = status === "CONFIRMED" || status === "PREPARING" || status === "READY";
  return (
    <span className={`status status-${status.toLowerCase()}`}>
      {isLive ? <span className="status-live-dot" /> : null}
      {status.replace("_", " ")}
    </span>
  );
}

function TimelineRow({ label, time, done, active }: { active?: boolean; done?: boolean; label: string; time?: string }) {
  return (
    <div className="timeline-row">
      <span className={done ? (active && !time ? "dot live" : "dot done") : "dot"} />
      <div>
        <strong>{label}</strong>
        {time ? <span>{time}</span> : null}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
