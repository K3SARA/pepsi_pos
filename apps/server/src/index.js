import "dotenv/config";
import express from "express";
import http from "node:http";
import cors from "cors";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import { SOCKET_EVENTS } from "@pepsi/shared";
import { enrichSale } from "./seed.js";
import { getState, getStoreMeta, updateState } from "./store.js";
import {
  extractSocketToken,
  getAuthStoreMeta,
  listUsers,
  loginUser,
  requireAuth,
  requireRole,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyAccessToken
} from "./auth.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN?.split(",") || "*"
  }
});

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || "*" }));
app.use(express.json());

const sendFullSync = () => {
  io.emit(SOCKET_EVENTS.STATE_SYNC, getState());
};

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get("/db/readonly", (req, res) => {
  const token = String(req.query.token || req.headers["x-readonly-token"] || "").trim();
  const expected = String(process.env.READONLY_DASHBOARD_TOKEN || "").trim();
  if (!expected) {
    res.status(503).json({ message: "READONLY_DASHBOARD_TOKEN is not configured" });
    return;
  }
  if (!token || token !== expected) {
    res.status(401).json({ message: "Invalid readonly token" });
    return;
  }

  const state = getState();
  const today = new Date().toISOString().slice(0, 10);
  const todaySales = (state.sales || []).filter((sale) => String(sale.createdAt || "").slice(0, 10) === today);
  const todayRevenue = todaySales.reduce((acc, sale) => acc + Number(sale.total || 0), 0);

  res.json({
    now: new Date().toISOString(),
    storage: {
      state: getStoreMeta(),
      auth: getAuthStoreMeta()
    },
    counts: {
      products: (state.products || []).length,
      customers: (state.customers || []).length,
      staff: (state.staff || []).length,
      sales: (state.sales || []).length,
      returns: (state.returns || []).length,
      todaySales: todaySales.length,
      todayRevenue: Number(todayRevenue.toFixed(2))
    },
    latestSales: (state.sales || []).slice(0, 20).map((sale) => ({
      id: sale.id,
      createdAt: sale.createdAt,
      rep: sale.cashier || "-",
      customer: sale.customerName || "-",
      lorry: sale.lorry || "-",
      total: Number(sale.total || 0)
    }))
  });
});

app.post("/auth/login", (req, res) => {
  const { role, username, password } = req.body || {};
  loginUser({ role, username, password })
    .then((session) => {
      if (!session) {
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }
      res.json(session);
    })
    .catch(() => {
      res.status(500).json({ message: "Unable to login" });
    });
});

app.post("/auth/refresh", (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    res.status(400).json({ message: "refreshToken is required" });
    return;
  }

  const nextSession = rotateRefreshToken(refreshToken);
  if (!nextSession) {
    res.status(401).json({ message: "Invalid or expired refresh token" });
    return;
  }

  res.json(nextSession);
});

app.post("/auth/logout", (req, res) => {
  const { refreshToken } = req.body || {};
  revokeRefreshToken(refreshToken);
  res.json({ ok: true });
});

app.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/auth/users", requireAuth, requireRole("admin"), (_req, res) => {
  res.json(listUsers());
});

app.get("/state", requireAuth, (_req, res) => {
  res.json(getState());
});

app.get("/products", requireAuth, (_req, res) => {
  res.json(getState().products);
});

app.post("/products", requireAuth, requireRole("admin"), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const size = String(body.size || "").trim();
  const sku = String(body.sku || "").trim();
  const category = String(body.category || "General").trim();
  const billingPrice = Number(body.billingPrice);
  const mrp = Number(body.mrp);
  const stock = Number(body.stock);

  if (!name || !sku || Number.isNaN(billingPrice) || Number.isNaN(mrp) || Number.isNaN(stock)) {
    res.status(400).json({ message: "name, sku, billingPrice, mrp, stock are required" });
    return;
  }

  const state = getState();
  const exists = state.products.find((item) => item.sku.toLowerCase() === sku.toLowerCase());
  if (exists) {
    res.status(409).json({ message: `Product SKU already exists: ${sku}` });
    return;
  }

  const created = {
    id: `p-${nanoid(8)}`,
    name,
    size,
    sku,
    category: category || "General",
    price: mrp,
    billingPrice,
    mrp,
    stock
  };

  updateState((draft) => {
    draft.products.unshift(created);
    return draft;
  });

  io.emit(SOCKET_EVENTS.PRODUCT_UPDATED, created);
  sendFullSync();
  res.status(201).json(created);
});

app.patch("/products/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { id } = req.params;
  const patch = req.body || {};
  const incomingSku = patch.sku ? String(patch.sku).trim() : null;

  if (incomingSku) {
    const state = getState();
    const conflict = state.products.find((item) => item.id !== id && item.sku.toLowerCase() === incomingSku.toLowerCase());
    if (conflict) {
      res.status(409).json({ message: `SKU already exists: ${incomingSku}` });
      return;
    }
  }

  const next = updateState((state) => {
    const index = state.products.findIndex((item) => item.id === id);
    if (index === -1) {
      return state;
    }

    state.products[index] = {
      ...state.products[index],
      ...patch,
      size: patch.size !== undefined ? String(patch.size || "").trim() : state.products[index].size,
      sku: incomingSku ?? state.products[index].sku,
      billingPrice: patch.billingPrice !== undefined ? Number(patch.billingPrice) : state.products[index].billingPrice,
      mrp: patch.mrp !== undefined ? Number(patch.mrp) : state.products[index].mrp,
      price: patch.price !== undefined ? Number(patch.price) : state.products[index].price,
      stock: patch.stock !== undefined ? Number(patch.stock) : state.products[index].stock
    };

    return state;
  });

  const updated = next.products.find((item) => item.id === id);
  if (!updated) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  io.emit(SOCKET_EVENTS.PRODUCT_UPDATED, updated);
  sendFullSync();
  res.json(updated);
});

app.delete("/products/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { id } = req.params;
  let removed = null;

  const next = updateState((state) => {
    const index = state.products.findIndex((item) => item.id === id);
    if (index === -1) return state;
    removed = state.products[index];
    state.products.splice(index, 1);
    return state;
  });

  if (!removed) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  io.emit(SOCKET_EVENTS.PRODUCT_UPDATED, { id, deleted: true });
  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.json({ ok: true, deleted: removed });
});

app.get("/sales", requireAuth, (_req, res) => {
  res.json(getState().sales);
});

app.get("/customers", requireAuth, requireRole("admin"), (_req, res) => {
  res.json(getState().customers || []);
});

app.post("/customers", requireAuth, requireRole("admin", "cashier"), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const address = String(body.address || "").trim();
  if (!name) {
    res.status(400).json({ message: "Customer name is required" });
    return;
  }
  if (req.user?.role === "cashier" && (!phone || !address)) {
    res.status(400).json({ message: "Customer mobile and address are required for rep login" });
    return;
  }

  const record = {
    id: nanoid(12),
    name,
    phone,
    address,
    createdAt: new Date().toISOString()
  };

  updateState((state) => {
    state.customers = state.customers || [];
    state.customers.push(record);
    return state;
  });

  sendFullSync();
  res.status(201).json(record);
});

app.patch("/customers/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const next = updateState((state) => {
    state.customers = state.customers || [];
    const idx = state.customers.findIndex((item) => item.id === id);
    if (idx === -1) return state;
    state.customers[idx] = { ...state.customers[idx], ...body };
    return state;
  });

  const updated = (next.customers || []).find((item) => item.id === id);
  if (!updated) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }

  sendFullSync();
  res.json(updated);
});

app.get("/staff", requireAuth, requireRole("admin"), (_req, res) => {
  res.json(getState().staff || []);
});

app.post("/staff", requireAuth, requireRole("admin"), (req, res) => {
  const body = req.body || {};
  if (!body.name?.trim()) {
    res.status(400).json({ message: "Staff name is required" });
    return;
  }

  const record = {
    id: nanoid(12),
    name: body.name.trim(),
    role: body.role || "",
    phone: body.phone || "",
    createdAt: new Date().toISOString()
  };

  updateState((state) => {
    state.staff = state.staff || [];
    state.staff.push(record);
    return state;
  });

  sendFullSync();
  res.status(201).json(record);
});

app.patch("/staff/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const next = updateState((state) => {
    state.staff = state.staff || [];
    const idx = state.staff.findIndex((item) => item.id === id);
    if (idx === -1) return state;
    state.staff[idx] = { ...state.staff[idx], ...body };
    return state;
  });

  const updated = (next.staff || []).find((item) => item.id === id);
  if (!updated) {
    res.status(404).json({ message: "Staff not found" });
    return;
  }

  sendFullSync();
  res.json(updated);
});

app.post("/sales", requireAuth, requireRole("cashier", "admin"), (req, res) => {
  const body = req.body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const lorry = String(body.lorry || "").trim();
  const paymentType = String(body.paymentType || "cash");
  const cashReceived = Number(body.cashReceived || 0);
  const creditDueDate = String(body.creditDueDate || "").trim();

  if (!lines.length) {
    res.status(400).json({ message: "Cart is empty" });
    return;
  }
  if (!["Lorry A", "Lorry B"].includes(lorry)) {
    res.status(400).json({ message: "Lorry selection is required" });
    return;
  }

  const state = getState();
  const productMap = new Map(state.products.map((p) => [p.id, p]));
  const maxSaleNo = (state.sales || []).reduce((max, sale) => {
    const raw = String(sale.id || "").trim();
    const asNumber = /^\d+$/.test(raw) ? Number(raw) : 0;
    return Math.max(max, asNumber);
  }, 0);
  const nextSaleId = String(maxSaleNo + 1).padStart(5, "0");
  const preparedLines = [];

  for (const line of lines) {
    const product = productMap.get(line.productId);
    if (!product) {
      res.status(404).json({ message: `Unknown product ${line.productId}` });
      return;
    }
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ message: `Invalid quantity for ${product.name}` });
      return;
    }
    if (product.stock < quantity) {
      res.status(409).json({ message: `Insufficient stock for ${product.name}` });
      return;
    }
    preparedLines.push({
      productId: product.id,
      name: line.name || `${product.name}${product.size ? ` ${product.size}` : ""}`,
      quantity,
      price: Number(product.billingPrice ?? product.price ?? product.mrp ?? 0)
    });
  }

  const prepared = enrichSale({
    id: nextSaleId,
    createdAt: new Date().toISOString(),
    cashier: body.cashier || req.user.username,
    customerName: body.customerName || "Walk-in",
    lorry,
    paymentType,
    notes: body.notes || "",
    discount: Number(body.discount || 0),
    taxRate: 0,
    lines: preparedLines
  });

  if (paymentType === "cash") {
    if (!Number.isFinite(cashReceived) || cashReceived < 0) {
      res.status(400).json({ message: "Cash received must be 0 or more" });
      return;
    }
    const paid = Math.min(Number(prepared.total || 0), Number(cashReceived || 0));
    prepared.cashReceived = Number(cashReceived.toFixed(2));
    prepared.creditDueDate = "";
    prepared.paidAmount = Number(paid.toFixed(2));
    prepared.outstandingAmount = Number((Number(prepared.total || 0) - paid).toFixed(2));
  } else if (paymentType === "credit") {
    if (!creditDueDate) {
      res.status(400).json({ message: "Credit due date is required" });
      return;
    }
    prepared.cashReceived = null;
    prepared.creditDueDate = creditDueDate;
    prepared.paidAmount = 0;
    prepared.outstandingAmount = Number(prepared.total || 0);
  } else {
    prepared.cashReceived = null;
    prepared.creditDueDate = "";
    prepared.paidAmount = Number(prepared.total || 0);
    prepared.outstandingAmount = 0;
  }
  prepared.dueAmount = Number(Math.max(0, Number(prepared.total || 0) - Number(prepared.paidAmount || 0)).toFixed(2));

  const next = updateState((draft) => {
    draft.sales.unshift(prepared);
    draft.customers = draft.customers || [];
    draft.staff = draft.staff || [];

    for (const line of prepared.lines) {
      const product = draft.products.find((item) => item.id === line.productId);
      if (product) {
        product.stock = Number((product.stock - line.quantity).toFixed(2));
      }
    }

    const existingCustomer = draft.customers.find((item) => item.name.toLowerCase() === prepared.customerName.toLowerCase());
    if (!existingCustomer && prepared.customerName && prepared.customerName !== "Walk-in") {
      draft.customers.push({
        id: nanoid(12),
        name: prepared.customerName,
        phone: "",
        address: "",
        createdAt: new Date().toISOString()
      });
    }

    const existingStaff = draft.staff.find((item) => item.name.toLowerCase() === prepared.cashier.toLowerCase());
    if (!existingStaff && prepared.cashier) {
      draft.staff.push({
        id: nanoid(12),
        name: prepared.cashier,
        role: "Cashier",
        phone: "",
        createdAt: new Date().toISOString()
      });
    }

    return draft;
  });

  io.emit(SOCKET_EVENTS.SALE_CREATED, prepared);
  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.status(201).json(prepared);
});

app.patch("/sales/:id", requireAuth, requireRole("cashier", "admin"), (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) {
    res.status(400).json({ message: "At least one line is required" });
    return;
  }

  const state = getState();
  const sale = (state.sales || []).find((item) => String(item.id) === String(id));
  if (!sale) {
    res.status(404).json({ message: "Sale not found" });
    return;
  }

  const saleCashier = String(sale.cashier || "").trim().toLowerCase();
  const actingUser = String(req.user?.username || "").trim().toLowerCase();
  const isAdmin = String(req.user?.role || "").toLowerCase() === "admin";
  if (!isAdmin && (!saleCashier || saleCashier !== actingUser)) {
    res.status(403).json({ message: "Only the rep who created this sale can edit it" });
    return;
  }

  const hasReturns = (state.returns || []).some((ret) => String(ret.saleId) === String(sale.id));
  if (hasReturns) {
    res.status(409).json({ message: "Cannot edit sale after returns have been submitted" });
    return;
  }

  const productMap = new Map((state.products || []).map((p) => [p.id, p]));
  const oldQtyByProduct = new Map();
  for (const line of (sale.lines || [])) {
    oldQtyByProduct.set(line.productId, (oldQtyByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
  }

  const preparedLines = [];
  const newQtyByProduct = new Map();
  for (const line of lines) {
    const productId = String(line.productId || "").trim();
    const quantity = Number(line.quantity || 0);
    const product = productMap.get(productId);
    if (!product || !Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ message: "Invalid sale edit line" });
      return;
    }
    newQtyByProduct.set(productId, (newQtyByProduct.get(productId) || 0) + quantity);
    preparedLines.push({
      productId,
      name: line.name || `${product.name}${product.size ? ` ${product.size}` : ""}`,
      quantity,
      price: Number(product.billingPrice ?? product.price ?? product.mrp ?? 0)
    });
  }

  const allProductIds = new Set([...oldQtyByProduct.keys(), ...newQtyByProduct.keys()]);
  for (const productId of allProductIds) {
    const product = productMap.get(productId);
    if (!product) continue;
    const oldQty = Number(oldQtyByProduct.get(productId) || 0);
    const nextQty = Number(newQtyByProduct.get(productId) || 0);
    const projectedStock = Number(product.stock || 0) + oldQty - nextQty;
    if (projectedStock < 0) {
      res.status(409).json({ message: `Insufficient stock for ${product.name}` });
      return;
    }
  }

  let paidAmount = Number(sale.paidAmount || sale.total || 0);
  if (sale.paymentType === "credit") paidAmount = 0;
  if (sale.paymentType === "cash") {
    paidAmount = Number(sale.cashReceived || paidAmount || 0);
  }

  const recalculated = enrichSale({
    ...sale,
    lines: preparedLines,
    taxRate: 0,
    paidAmount
  });
  if (sale.paymentType === "credit") {
    recalculated.outstandingAmount = Number(recalculated.total || 0);
    recalculated.paidAmount = 0;
  } else if (sale.paymentType === "cash") {
    const paid = Math.min(Number(recalculated.total || 0), Number(sale.cashReceived || 0));
    recalculated.paidAmount = Number(paid.toFixed(2));
    recalculated.outstandingAmount = Number((Number(recalculated.total || 0) - paid).toFixed(2));
    recalculated.cashReceived = Number(sale.cashReceived || 0);
  } else {
    recalculated.paidAmount = Number(recalculated.total || 0);
    recalculated.outstandingAmount = 0;
  }
  recalculated.dueAmount = Number(Math.max(0, Number(recalculated.total || 0) - Number(recalculated.paidAmount || 0)).toFixed(2));

  const next = updateState((draft) => {
    const idx = draft.sales.findIndex((item) => String(item.id) === String(id));
    if (idx === -1) return draft;

    for (const productId of allProductIds) {
      const product = draft.products.find((p) => p.id === productId);
      if (!product) continue;
      const oldQty = Number(oldQtyByProduct.get(productId) || 0);
      const nextQty = Number(newQtyByProduct.get(productId) || 0);
      product.stock = Number((Number(product.stock || 0) + oldQty - nextQty).toFixed(2));
    }

    draft.sales[idx] = recalculated;
    return draft;
  });

  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.json(recalculated);
});

app.delete("/sales/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { id } = req.params;
  const state = getState();
  const sale = (state.sales || []).find((item) => String(item.id) === String(id));
  if (!sale) {
    res.status(404).json({ message: "Sale not found" });
    return;
  }

  const returnedByProduct = new Map();
  for (const ret of (state.returns || [])) {
    if (String(ret.saleId) !== String(id)) continue;
    for (const line of (ret.lines || [])) {
      returnedByProduct.set(line.productId, (returnedByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
    }
  }

  const next = updateState((draft) => {
    // Restore only net sold qty not already returned.
    for (const line of (sale.lines || [])) {
      const product = draft.products.find((item) => item.id === line.productId);
      if (!product) continue;
      const sold = Number(line.quantity || 0);
      const alreadyReturned = Number(returnedByProduct.get(line.productId) || 0);
      const netSold = Math.max(0, sold - alreadyReturned);
      product.stock = Number((Number(product.stock || 0) + netSold).toFixed(2));
    }
    draft.sales = (draft.sales || []).filter((item) => String(item.id) !== String(id));
    draft.returns = (draft.returns || []).filter((ret) => String(ret.saleId) !== String(id));
    return draft;
  });

  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.json({ ok: true, id: String(id) });
});

app.post("/returns", requireAuth, requireRole("cashier", "admin"), (req, res) => {
  const body = req.body || {};
  const saleId = String(body.saleId || "").trim();
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!saleId) {
    res.status(400).json({ message: "saleId is required" });
    return;
  }
  if (!lines.length) {
    res.status(400).json({ message: "Select at least one return item" });
    return;
  }

  const state = getState();
  const sale = (state.sales || []).find((item) => String(item.id) === saleId);
  if (!sale) {
    res.status(404).json({ message: "Sale not found" });
    return;
  }
  const saleCashier = String(sale.cashier || "").trim().toLowerCase();
  const actingUser = String(req.user?.username || "").trim().toLowerCase();
  if (!saleCashier || saleCashier !== actingUser) {
    res.status(403).json({ message: "Only the rep who created this sale can return its items" });
    return;
  }

  const previousReturns = (state.returns || []).filter((item) => item.saleId === saleId);
  const returnedByProduct = new Map();
  for (const ret of previousReturns) {
    for (const line of (ret.lines || [])) {
      const key = line.productId;
      returnedByProduct.set(key, (returnedByProduct.get(key) || 0) + Number(line.quantity || 0));
    }
  }

  const saleLineByProduct = new Map((sale.lines || []).map((line) => [line.productId, line]));
  const preparedLines = [];
  for (const incoming of lines) {
    const productId = String(incoming.productId || "").trim();
    const quantity = Number(incoming.quantity || 0);
    const condition = String(incoming.condition || "").trim().toLowerCase();
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ message: "Invalid return line" });
      return;
    }
    if (!["good", "damaged"].includes(condition)) {
      res.status(400).json({ message: "Return condition must be good or damaged" });
      return;
    }
    const soldLine = saleLineByProduct.get(productId);
    if (!soldLine) {
      res.status(400).json({ message: "Return item not found in selected sale" });
      return;
    }
    const soldQty = Number(soldLine.quantity || 0);
    const alreadyReturned = Number(returnedByProduct.get(productId) || 0);
    const remaining = soldQty - alreadyReturned;
    if (quantity > remaining) {
      res.status(409).json({ message: `Return exceeds remaining qty for ${soldLine.name}` });
      return;
    }
    preparedLines.push({
      productId,
      name: soldLine.name,
      quantity,
      condition
    });
  }

  const record = {
    id: nanoid(12),
    saleId,
    rep: req.user.username,
    createdAt: new Date().toISOString(),
    lines: preparedLines
  };

  const next = updateState((draft) => {
    draft.returns = draft.returns || [];
    draft.returns.unshift(record);
    for (const line of preparedLines) {
      if (line.condition !== "good") continue;
      const product = draft.products.find((item) => item.id === line.productId);
      if (product) {
        product.stock = Number((Number(product.stock || 0) + Number(line.quantity || 0)).toFixed(2));
      }
    }
    return draft;
  });

  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.status(201).json(record);
});

app.post("/sales/:id/delivery-adjust", requireAuth, requireRole("admin"), (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const incomingLines = Array.isArray(body.lines) ? body.lines : [];
  const markConfirmed = body.markConfirmed !== false;

  const state = getState();
  const sale = (state.sales || []).find((item) => String(item.id) === String(id));
  if (!sale) {
    res.status(404).json({ message: "Sale not found" });
    return;
  }

  const saleLines = Array.isArray(sale.lines) ? sale.lines : [];
  const soldByProduct = new Map();
  for (const line of saleLines) {
    soldByProduct.set(line.productId, (soldByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
  }

  const alreadyUndelivered = new Map();
  for (const adj of (sale.deliveryAdjustments || [])) {
    for (const line of (adj.lines || [])) {
      alreadyUndelivered.set(line.productId, (alreadyUndelivered.get(line.productId) || 0) + Number(line.quantity || 0));
    }
  }

  const alreadyReturnedGood = new Map();
  for (const ret of (state.returns || [])) {
    if (String(ret.saleId) !== String(sale.id)) continue;
    for (const line of (ret.lines || [])) {
      if (String(line.condition || "").toLowerCase() !== "good") continue;
      alreadyReturnedGood.set(line.productId, (alreadyReturnedGood.get(line.productId) || 0) + Number(line.quantity || 0));
    }
  }

  const preparedLines = [];
  for (const line of incomingLines) {
    const productId = String(line.productId || "").trim();
    const quantity = Number(line.quantity || 0);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) continue;
    const sold = Number(soldByProduct.get(productId) || 0);
    if (sold <= 0) {
      res.status(400).json({ message: "Invalid delivery line product" });
      return;
    }
    const prevUndelivered = Number(alreadyUndelivered.get(productId) || 0);
    const prevReturnedGood = Number(alreadyReturnedGood.get(productId) || 0);
    const maxAllowed = Math.max(0, sold - prevUndelivered - prevReturnedGood);
    if (quantity > maxAllowed) {
      const saleLine = saleLines.find((item) => item.productId === productId);
      res.status(409).json({ message: `Undelivered qty exceeds remaining for ${saleLine?.name || productId}` });
      return;
    }
    const saleLine = saleLines.find((item) => item.productId === productId);
    preparedLines.push({
      productId,
      name: saleLine?.name || productId,
      quantity
    });
  }

  const adjustmentRecord = preparedLines.length ? {
    id: nanoid(12),
    createdAt: new Date().toISOString(),
    by: req.user?.username || "admin",
    lines: preparedLines
  } : null;

  const next = updateState((draft) => {
    const idx = (draft.sales || []).findIndex((item) => String(item.id) === String(id));
    if (idx === -1) return draft;
    const target = draft.sales[idx];
    target.deliveryAdjustments = target.deliveryAdjustments || [];
    if (adjustmentRecord) {
      target.deliveryAdjustments.push(adjustmentRecord);
      for (const line of adjustmentRecord.lines) {
        const product = (draft.products || []).find((item) => item.id === line.productId);
        if (!product) continue;
        product.stock = Number((Number(product.stock || 0) + Number(line.quantity || 0)).toFixed(2));
      }
    }
    if (markConfirmed) {
      target.deliveryConfirmedAt = new Date().toISOString();
      target.deliveryConfirmedBy = req.user?.username || "admin";
    }
    return draft;
  });

  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  const updatedSale = (next.sales || []).find((item) => String(item.id) === String(id));
  res.status(201).json(updatedSale);
});

app.get("/dashboard", requireAuth, (_req, res) => {
  const state = getState();
  const sales = state.sales;

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();

  const todaySales = sales.filter((sale) => sale.createdAt >= todayStart);
  const todayRevenue = todaySales.reduce((acc, sale) => acc + Number(sale.total || 0), 0);

  const lowStockItems = state.products.filter((item) => item.stock <= 25);

  res.json({
    salesCount: sales.length,
    todaySalesCount: todaySales.length,
    todayRevenue: Number(todayRevenue.toFixed(2)),
    lowStockItems
  });
});

io.use((socket, next) => {
  const token = extractSocketToken(socket);
  if (!token) {
    next(new Error("Missing token"));
    return;
  }

  try {
    socket.data.user = verifyAccessToken(token);
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  socket.emit(SOCKET_EVENTS.STATE_SYNC, getState());
});

const port = Number(process.env.PORT || 4010);
server.listen(port, () => {
  console.log(`POS API listening on http://localhost:${port}`);
});
