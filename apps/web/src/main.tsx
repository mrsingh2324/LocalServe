import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { io } from "socket.io-client";
import type { MenuItem, Order, OrderStatus, Vendor } from "@localserve/shared-types";
import {
  API_URL,
  createMenuItem,
  createOrder,
  deleteMenuItem,
  getDemoVendors,
  getDashboard,
  getOrder,
  getStoredVendorToken,
  getStorefront,
  getVendorMe,
  getVendorMenu,
  getVendorOrders,
  getVendorQr,
  loginVendor,
  registerVendor,
  setStoredVendorToken,
  updateMenuItem,
  updateVendorProfile,
  updateOrderStatus
} from "./api";
import { buildCartLines, useCartStore } from "./cartStore";
import "./styles.css";

const socket = io(API_URL, { autoConnect: true });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/v/ravi-canteen" replace />} />
        <Route path="/v/:slug" element={<CustomerStorefront />} />
        <Route path="/order/:orderId" element={<OrderStatusPage />} />
        <Route path="/vendor" element={<VendorConsole />} />
      </Routes>
    </BrowserRouter>
  );
}

function CustomerStorefront() {
  const slug = location.pathname.split("/").pop() ?? "ravi-canteen";
  const [vendor, setVendor] = React.useState<Vendor | null>(null);
  const [menuItems, setMenuItems] = React.useState<MenuItem[]>([]);
  const [email, setEmail] = React.useState("priya@company.in");
  const [phone, setPhone] = React.useState("");
  const [isPaying, setIsPaying] = React.useState(false);
  const [placedOrder, setPlacedOrder] = React.useState<Order | null>(null);
  const { quantities, setQuantity, clear } = useCartStore();

  React.useEffect(() => {
    getStorefront(slug).then((data) => {
      setVendor(data.vendor);
      setMenuItems(data.menuItems);
    });
  }, [slug]);

  const cartLines = buildCartLines(menuItems, quantities);
  const total = cartLines.reduce((sum, line) => sum + line.lineTotal, 0);

  async function pay() {
    setIsPaying(true);
    const response = await createOrder({
      vendorSlug: slug,
      customerEmail: email,
      customerPhone: phone || undefined,
      items: cartLines.map((line) => ({ menuItemId: line.item.id, quantity: line.quantity }))
    });
    setPlacedOrder(response.order);
    clear();
    setIsPaying(false);
  }

  if (!vendor) return <Shell><div className="empty">Loading storefront...</div></Shell>;

  return (
    <Shell>
      <section className="hero store-hero">
        <div>
          <p className="eyebrow">Scan, order, pick up</p>
          <h1>{vendor.name}</h1>
          <p>{vendor.locationTag}</p>
        </div>
        <Link className="quiet-link" to="/vendor">Vendor console</Link>
      </section>

      {placedOrder ? (
        <OrderConfirmation order={placedOrder} vendor={vendor} />
      ) : (
        <main className="customer-grid">
          <section>
            <div className="section-head">
              <h2>Menu</h2>
              <span>{menuItems.length} available</span>
            </div>
            <div className="menu-grid">
              {menuItems.map((item) => (
                <article className="menu-card" key={item.id}>
                  <img src={item.photoUrl} alt="" />
                  <div className="menu-card-body">
                    <div>
                      <p className="category">{item.category}</p>
                      <h3>{item.name}</h3>
                      <p>{item.description}</p>
                    </div>
                    <div className="menu-action">
                      <strong>₹{item.price}</strong>
                      <QuantityControl
                        value={quantities[item.id] ?? 0}
                        onChange={(quantity) => setQuantity(item.id, quantity)}
                      />
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <aside className="cart-panel">
            <h2>Your order</h2>
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
            <label>
              Email for notification
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
            </label>
            <label>
              Phone optional
              <input value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" />
            </label>
            <div className="total-row">
              <span>Total</span>
              <strong>₹{total}</strong>
            </div>
            <button disabled={!cartLines.length || isPaying} onClick={pay}>
              {isPaying ? "Confirming payment..." : "Pay with UPI"}
            </button>
            <p className="fine-print">Test checkout captures payment instantly for MVP verification.</p>
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

function OrderConfirmation({ order, vendor }: { order: Order; vendor: Vendor }) {
  return (
    <section className="confirmation">
      <div className="success-mark">✓</div>
      <p className="eyebrow">Payment confirmed</p>
      <h2>Order placed</h2>
      <div className="order-code">{order.orderCode}</div>
      <p>
        Confirmation sent to {order.customerEmail}. Show this code at {vendor.name} when your food is ready.
      </p>
      <Link className="primary-link" to={`/order/${order.id}`}>Track live status</Link>
    </section>
  );
}

function OrderStatusPage() {
  const orderId = location.pathname.split("/").pop() ?? "";
  const [order, setOrder] = React.useState<Order | null>(null);
  const [vendor, setVendor] = React.useState<{ name: string; locationTag: string } | null>(null);

  React.useEffect(() => {
    getOrder(orderId).then((data) => {
      setOrder(data.order);
      setVendor(data.vendor);
    });
    socket.emit("join_order", { orderId });
    socket.on("order_updated", setOrder);
    socket.on("order_ready", setOrder);
    return () => {
      socket.off("order_updated", setOrder);
      socket.off("order_ready", setOrder);
    };
  }, [orderId]);

  if (!order || !vendor) return <Shell><div className="empty">Loading order...</div></Shell>;

  return (
    <Shell>
      <section className="status-page">
        <p className="eyebrow">{vendor.name}</p>
        <h1>Order #{order.orderCode}</h1>
        <StatusBadge status={order.status} />
        <div className="timeline">
          <TimelineRow active done label="Order received" time={new Date(order.createdAt).toLocaleTimeString()} />
          <TimelineRow active={["PREPARING", "READY", "COLLECTED"].includes(order.status)} done={["PREPARING", "READY", "COLLECTED"].includes(order.status)} label="Preparing" />
          <TimelineRow active={order.status === "READY" || order.status === "COLLECTED"} done={order.status === "READY" || order.status === "COLLECTED"} label="Ready for pickup" time={order.readyAt ? new Date(order.readyAt).toLocaleTimeString() : undefined} />
        </div>
        {order.status === "READY" ? (
          <div className="ready-box">Your order is ready. Show code {order.orderCode} at pickup.</div>
        ) : (
          <div className="ready-box muted-box">Keep this page open. It updates automatically.</div>
        )}
      </section>
    </Shell>
  );
}

function VendorConsole() {
  const [orders, setOrders] = React.useState<Order[]>([]);
  const [menu, setMenu] = React.useState<MenuItem[]>([]);
  const [vendor, setVendor] = React.useState<Vendor | null>(null);
  const [demoVendors, setDemoVendors] = React.useState<Vendor[]>([]);
  const [summary, setSummary] = React.useState({ totalOrders: 0, revenue: 0 });
  const [authMode, setAuthMode] = React.useState<"entry" | "login" | "signup">("entry");
  const [loginDraft, setLoginDraft] = React.useState({ phone: "+919876543210", password: "demo123" });
  const [profileDraft, setProfileDraft] = React.useState({
    name: "Ravi's Canteen",
    phone: "+919876543210",
    locationTag: "Office Block B, Ground Floor",
    upiId: "ravi@upi",
    password: "demo123"
  });
  const [menuDraft, setMenuDraft] = React.useState({
    id: "",
    name: "",
    description: "",
    price: "50",
    photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80",
    category: "Snacks",
    isAvailable: true
  });
  const [issuedToken, setIssuedToken] = React.useState("");
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
    setSummary({ totalOrders: dashboard.totalOrders, revenue: dashboard.revenue });
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
            locationTag: data.vendor.locationTag,
            upiId: data.vendor.upiId
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
    const response = await updateOrderStatus(order.id, status);
    setOrders((current) => current.map((candidate) => (candidate.id === order.id ? response.order : candidate)));
    refresh();
  }

  async function toggleItem(item: MenuItem) {
    const response = await updateMenuItem(item.id, { isAvailable: !item.isAvailable });
    setMenu((current) => current.map((candidate) => (candidate.id === item.id ? response.menuItem : candidate)));
  }

  async function saveMenuItem(event: React.FormEvent) {
    event.preventDefault();
    const payload = {
      name: menuDraft.name,
      description: menuDraft.description,
      price: Number(menuDraft.price),
      photoUrl: menuDraft.photoUrl,
      category: menuDraft.category,
      isAvailable: menuDraft.isAvailable
    };
    if (menuDraft.id) {
      const response = await updateMenuItem(menuDraft.id, payload);
      setMenu((current) => current.map((candidate) => (candidate.id === response.menuItem.id ? response.menuItem : candidate)));
    } else {
      const response = await createMenuItem(payload);
      setMenu((current) => [response.menuItem, ...current]);
    }
    setMenuDraft({ id: "", name: "", description: "", price: "50", photoUrl: menuDraft.photoUrl, category: "Snacks", isAvailable: true });
  }

  async function removeItem(item: MenuItem) {
    await deleteMenuItem(item.id);
    setMenu((current) => current.filter((candidate) => candidate.id !== item.id));
  }

  function editItem(item: MenuItem) {
    setMenuDraft({
      id: item.id,
      name: item.name,
      description: item.description,
      price: String(item.price),
      photoUrl: item.photoUrl,
      category: item.category,
      isAvailable: item.isAvailable
    });
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    const response = await loginVendor(loginDraft);
    setStoredVendorToken(response.token);
    setIssuedToken(response.token);
    setVendor(response.vendor);
    setProfileDraft((draft) => ({
      ...draft,
      name: response.vendor.name,
      phone: response.vendor.phone,
      locationTag: response.vendor.locationTag,
      upiId: response.vendor.upiId
    }));
    socket.emit("join_vendor", { token: response.token });
    refresh();
  }

  async function registerShop(event: React.FormEvent) {
    event.preventDefault();
    const response = await registerVendor(profileDraft);
    setStoredVendorToken(response.token);
    setVendor(response.vendor);
    setIssuedToken(response.token);
    socket.emit("join_vendor", { token: response.token });
    refresh();
  }

  async function updateProfile(event: React.FormEvent) {
    event.preventDefault();
    const response = await updateVendorProfile({
      name: profileDraft.name,
      locationTag: profileDraft.locationTag,
      upiId: profileDraft.upiId
    });
    setVendor(response.vendor);
  }

  function logout() {
    localStorage.removeItem("localserve_vendor_token");
    setVendor(null);
    setOrders([]);
    setMenu([]);
    setSummary({ totalOrders: 0, revenue: 0 });
    setIssuedToken("");
    setAuthMode("entry");
  }

  return (
    <Shell>
      <section className="hero vendor-hero">
        <div>
          <p className="eyebrow">Vendor console</p>
          <h1>{vendor?.name ?? "LocalServe Vendor"}</h1>
          <p>Manage orders, menu availability, QR code, and today&apos;s revenue.</p>
        </div>
        <div className="hero-actions">
          {vendor ? <button className="quiet-button" onClick={logout}>Logout</button> : null}
          <Link className="quiet-link" to={vendor ? `/v/${vendor.slug}` : "/v/ravi-canteen"}>Open storefront</Link>
        </div>
      </section>

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
                <button className="entry-button" onClick={() => setAuthMode("login")}>
                  Login to existing shop
                  <span>Use your registered mobile number and password.</span>
                </button>
                <button className="entry-button secondary-entry" onClick={() => setAuthMode("signup")}>
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
              <form className="onboarding-form" onSubmit={login}>
                <label>
                  Mobile number
                  <input value={loginDraft.phone} onChange={(event) => setLoginDraft((draft) => ({ ...draft, phone: event.target.value }))} />
                </label>
                <label>
                  Password
                  <input type="password" value={loginDraft.password} onChange={(event) => setLoginDraft((draft) => ({ ...draft, password: event.target.value }))} />
                </label>
                <button>Login</button>
              </form>
              <div className="demo-vendors">
                {demoVendors.map((demo) => (
                  <button
                    key={demo.id}
                    className="small-link demo-button"
                    onClick={() => setLoginDraft({ phone: demo.phone, password: "demo123" })}
                  >
                    {demo.name}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {authMode === "signup" ? (
            <section className="panel auth-work-panel">
              <div className="section-head">
                <h2>Create shop</h2>
                <button className="text-button" onClick={() => setAuthMode("entry")}>Back</button>
              </div>
              <form className="onboarding-form" onSubmit={registerShop}>
                <label>
                  Shop name
                  <input
                    value={profileDraft.name}
                    onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))}
                  />
                </label>
                <label>
                  Mobile number
                  <input
                    value={profileDraft.phone}
                    onChange={(event) => setProfileDraft((draft) => ({ ...draft, phone: event.target.value }))}
                  />
                </label>
                <label>
                  Location tag
                  <input
                    value={profileDraft.locationTag}
                    onChange={(event) => setProfileDraft((draft) => ({ ...draft, locationTag: event.target.value }))}
                  />
                </label>
                <label>
                  UPI ID
                  <input
                    value={profileDraft.upiId}
                    onChange={(event) => setProfileDraft((draft) => ({ ...draft, upiId: event.target.value }))}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={profileDraft.password}
                    onChange={(event) => setProfileDraft((draft) => ({ ...draft, password: event.target.value }))}
                  />
                </label>
                <button>Create shop</button>
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
                <StatusBadge status={order.status} />
              </div>
              <p>{order.items.map((item) => `${item.name} x${item.quantity}`).join(", ")}</p>
              <div className="order-card-bottom">
                <strong>₹{order.totalAmount}</strong>
                <div className="button-row">
                  {order.status === "CONFIRMED" && <button onClick={() => setStatus(order, "PREPARING")}>Start</button>}
                  {order.status !== "READY" && order.status !== "COLLECTED" && <button onClick={() => setStatus(order, "READY")}>Mark ready</button>}
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
              <input
                value={profileDraft.name}
                onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))}
              />
            </label>
            <label>
              Mobile number
              <input
                disabled
                value={profileDraft.phone}
                onChange={(event) => setProfileDraft((draft) => ({ ...draft, phone: event.target.value }))}
              />
            </label>
            <label>
              Location tag
              <input
                value={profileDraft.locationTag}
                onChange={(event) => setProfileDraft((draft) => ({ ...draft, locationTag: event.target.value }))}
              />
            </label>
            <label>
              UPI ID
              <input
                value={profileDraft.upiId}
                onChange={(event) => setProfileDraft((draft) => ({ ...draft, upiId: event.target.value }))}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                disabled
                value={profileDraft.password}
                onChange={(event) => setProfileDraft((draft) => ({ ...draft, password: event.target.value }))}
              />
            </label>
            <button>Update profile</button>
          </form>
          {issuedToken || isLoggedIn ? <p className="token-note">Logged-in vendor data is loaded from MongoDB and updates are saved to the same account.</p> : null}
        </section>

        <section className="panel" id="shop-summary">
          <h2>Today&apos;s summary</h2>
          <div className="summary-grid">
            <div><span>Orders</span><strong>{summary.totalOrders}</strong></div>
            <div><span>Revenue</span><strong>₹{summary.revenue}</strong></div>
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
              Category
              <input value={menuDraft.category} onChange={(event) => setMenuDraft((draft) => ({ ...draft, category: event.target.value }))} />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={menuDraft.isAvailable} onChange={(event) => setMenuDraft((draft) => ({ ...draft, isAvailable: event.target.checked }))} />
              Available
            </label>
            <button disabled={!isLoggedIn}>{menuDraft.id ? "Update item" : "Add item"}</button>
          </form>
          {menu.map((item) => (
            <div className="menu-toggle" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <span>₹{item.price}</span>
              </div>
              <div className="button-row">
                <button className={item.isAvailable ? "toggle on" : "toggle"} onClick={() => toggleItem(item)}>
                  {item.isAvailable ? "Available" : "Hidden"}
                </button>
                <button className="toggle" onClick={() => editItem(item)}>Edit</button>
                <button className="danger-button" onClick={() => removeItem(item)}>Delete</button>
              </div>
            </div>
          ))}
        </section>
      </main>
      )}
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header className="topbar">
        <Link to="/" className="brand">LocalServe</Link>
        <nav>
          <Link to="/v/ravi-canteen">Customer</Link>
          <Link to="/vendor">Vendor</Link>
        </nav>
      </header>
      {children}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
