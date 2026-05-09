import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, resetLocalState } from "./server.js";

async function login(phone = "+919876543210") {
  const response = await request(app)
    .post("/auth/vendor/login")
    .send({ phone, password: "demo123" })
    .expect(200);
  return response.body.token as string;
}

test("demo vendors are exposed with independent storefronts", async () => {
  resetLocalState();
  const response = await request(app).get("/demo-vendors").expect(200);
  assert.equal(response.body.vendors.length, 2);
  assert.deepEqual(
    response.body.vendors.map((vendor: { slug: string }) => vendor.slug).sort(),
    ["meera-tea-point", "ravi-canteen"]
  );
});

test("vendor login returns a JWT and scoped vendor menu", async () => {
  resetLocalState();
  const token = await login();
  const response = await request(app)
    .get("/vendor/menu")
    .set("authorization", `Bearer ${token}`)
    .expect(200);

  assert.equal(response.body.menuItems.length, 2);
  assert.ok(response.body.menuItems.every((item: { vendorId: string }) => item.vendorId === "vendor_ravi"));
});

test("signup creates a vendor and duplicate signup is rejected", async () => {
  resetLocalState();
  const signup = await request(app)
    .post("/vendor/register")
    .send({
      name: "Nisha Juice Bar",
      phone: "+919900001111",
      locationTag: "Tower C Atrium",
      upiId: "nisha@upi",
      password: "secret123"
    })
    .expect(201);

  assert.equal(signup.body.vendor.slug, "nisha-juice-bar");
  assert.ok(signup.body.token);

  await request(app)
    .post("/vendor/register")
    .send({
      name: "Nisha Juice Bar",
      phone: "+919900001111",
      locationTag: "Tower C Atrium",
      upiId: "nisha@upi",
      password: "secret123"
    })
    .expect(409);
});

test("logged-in vendor can update profile", async () => {
  resetLocalState();
  const token = await login();
  const response = await request(app)
    .patch("/vendor/profile")
    .set("authorization", `Bearer ${token}`)
    .send({
      name: "Ravi Express Canteen",
      locationTag: "Office Block B",
      upiId: "raviexpress@upi"
    })
    .expect(200);

  assert.equal(response.body.vendor.slug, "ravi-express-canteen");
  assert.equal(response.body.vendor.upiId, "raviexpress@upi");
});

test("customer order can only be marked ready by the owning vendor", async () => {
  resetLocalState();
  const orderResponse = await request(app)
    .post("/orders")
    .send({
      vendorSlug: "meera-tea-point",
      customerEmail: "priya@company.in",
      items: [{ menuItemId: "mi_chai", quantity: 2 }]
    })
    .expect(201);

  const raviToken = await login("+919876543210");
  await request(app)
    .patch(`/orders/${orderResponse.body.order.id}/status`)
    .set("authorization", `Bearer ${raviToken}`)
    .send({ status: "READY" })
    .expect(404);

  const meeraToken = await login("+919812345670");
  const readyResponse = await request(app)
    .patch(`/orders/${orderResponse.body.order.id}/status`)
    .set("authorization", `Bearer ${meeraToken}`)
    .send({ status: "READY" })
    .expect(200);

  assert.equal(readyResponse.body.order.status, "READY");
  assert.equal(readyResponse.body.notification.to, "priya@company.in");
});

test("vendor menu supports create, update, and delete", async () => {
  resetLocalState();
  const token = await login();
  const createResponse = await request(app)
    .post("/vendor/menu")
    .set("authorization", `Bearer ${token}`)
    .send({
      name: "Poha",
      description: "Light flattened-rice breakfast bowl.",
      price: 40,
      photoUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80",
      category: "Breakfast",
      isAvailable: true
    })
    .expect(201);

  const id = createResponse.body.menuItem.id;
  const updateResponse = await request(app)
    .patch(`/vendor/menu/${id}`)
    .set("authorization", `Bearer ${token}`)
    .send({ price: 45, isAvailable: false })
    .expect(200);
  assert.equal(updateResponse.body.menuItem.price, 45);
  assert.equal(updateResponse.body.menuItem.isAvailable, false);

  await request(app).delete(`/vendor/menu/${id}`).set("authorization", `Bearer ${token}`).expect(204);
  const menuResponse = await request(app).get("/vendor/menu").set("authorization", `Bearer ${token}`).expect(200);
  assert.equal(menuResponse.body.menuItems.some((item: { id: string }) => item.id === id), false);
});

test("validation errors are returned as 400 responses", async () => {
  resetLocalState();
  const response = await request(app)
    .post("/orders")
    .send({ vendorSlug: "ravi-canteen", customerEmail: "not-an-email", items: [] })
    .expect(400);
  assert.equal(response.body.error, "Validation failed");
});
