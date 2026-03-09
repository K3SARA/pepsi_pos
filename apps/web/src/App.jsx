import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { calculateTotals, PAYMENT_TYPES, SOCKET_EVENTS } from "@pepsi/shared";
import {
  clearAuthSession,
  createCustomer,
  createProduct,
  createStaff,
  deleteSale,
  deleteProduct,
  fetchDashboard,
  fetchMe,
  fetchState,
  getAccessToken,
  getApiBase,
  loginApi,
  logoutApi,
  patchSale,
  patchProduct,
  setAuthCallbacks,
  setAuthSession,
  submitDeliveryAdjustment,
  submitReturn,
  submitSale,
  updateCustomer,
  updateStaff
} from "./api.js";

const currency = (value) => `LKR ${Number(value || 0).toFixed(2)}`;
const SESSION_KEY = "pepsi_pos_session";
const escapeHtml = (value = "") => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

const BUNDLE_BY_SIZE_ML = {
  200: 24,
  250: 30,
  300: 24,
  400: 24,
  1000: 12,
  1500: 12,
  2000: 9
};

const extractSizeMl = (value = "") => {
  const raw = String(value || "").toLowerCase().replace(/\s+/g, "");
  const match = raw.match(/(\d{3,4})ml/);
  return match ? Number(match[1]) : 0;
};

const getBundleSize = (item) => {
  const name = String(item?.name || item || "").toLowerCase();
  const category = String(item?.category || "").toLowerCase();
  const sizeMl = extractSizeMl(item?.size || name);
  const isWater = name.includes("water") || category.includes("water") || name.includes("aquafina");

  if (!sizeMl) return 0;
  if (isWater && sizeMl === 1000) return 15;
  if (isWater && sizeMl === 1500) return 12;
  if (isWater && sizeMl === 500) return 24;
  return BUNDLE_BY_SIZE_ML[sizeMl] || 0;
};

const productDisplayName = (product) => {
  const name = String(product?.name || "").trim();
  const size = String(product?.size || "").trim();
  return size ? `${name} ${size}` : name;
};
const getBundleBreakdown = (row) => {
  const bundleSize = getBundleSize(row);
  const qty = Number(row?.qty || 0);
  if (!bundleSize) return { bundles: 0, singles: qty };
  return { bundles: Math.floor(qty / bundleSize), singles: qty % bundleSize };
};
const productSalePrice = (product) => Number(product?.billingPrice ?? product?.price ?? product?.mrp ?? 0);
const lineBasePrice = (line) => Number(line?.basePrice ?? line?.price ?? 0);
const lineItemDiscount = (line) => {
  const raw = Number(line?.itemDiscount || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const base = lineBasePrice(line);
  if (String(line?.itemDiscountMode || "amount") === "percent") {
    const percent = Math.min(raw, 100);
    return Number(((base * percent) / 100).toFixed(2));
  }
  return Math.min(raw, base);
};
const lineFinalPrice = (line) => Math.max(0, lineBasePrice(line) - Math.max(0, lineItemDiscount(line)));

const openSaleReceiptPrint = ({ sale, customers = [], products = [], fallbackCustomerName = "", onPopupBlocked = () => {} }) => {
  if (typeof window === "undefined" || !sale) return;
  const toMoney = (value) => Number(value || 0).toFixed(2);
  const saleDate = new Date(sale?.createdAt || Date.now());
  const dateLabel = Number.isNaN(saleDate.getTime())
    ? ""
    : `${String(saleDate.getDate()).padStart(2, "0")}/${String(saleDate.getMonth() + 1).padStart(2, "0")}/${saleDate.getFullYear()}`;

  const pickedCustomer = String(sale?.customerName || fallbackCustomerName || "Walk-in").trim() || "Walk-in";
  const customer = (customers || []).find(
    (row) => String(row?.name || "").trim().toLowerCase() === pickedCustomer.toLowerCase()
  );

  const baseLines = Array.isArray(sale?.lines) ? sale.lines : [];
  const lines = baseLines.slice(0, 12).map((line) => {
    const qty = Math.max(0, Number(line?.quantity || 0));
    const product = (products || []).find((p) => p.id === line?.productId);
    const billingPrice = Number(line?.basePrice ?? line?.price ?? product?.billingPrice ?? product?.price ?? 0);
    const itemDiscount = Math.max(0, Number(line?.itemDiscount || 0));
    const netUnit = Math.max(0, Number(line?.price ?? (billingPrice - itemDiscount)));
    const sku = line?.sku || product?.sku || "";
    return { sku, qty, billingPrice, itemDiscount, total: netUnit * qty };
  });

  const minRows = 8;
  const rowsHtml = [...lines, ...Array.from({ length: Math.max(0, minRows - lines.length) }).map(() => null)]
    .map((line) => {
      if (!line) return "<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>";
      return `<tr><td>${escapeHtml(line.sku)}</td><td>${line.qty}</td><td>${toMoney(line.billingPrice)}</td><td>${toMoney(line.itemDiscount)}</td><td>${toMoney(line.total)}</td></tr>`;
    })
    .join("");

  const printWindow = window.open("", "_blank", "width=1000,height=1300");
  if (!printWindow) {
    onPopupBlocked();
    return;
  }

  const receiptHtml = `<!doctype html><html><head><meta charset="utf-8" /><title>Receipt #${escapeHtml(sale.id)}</title><style>
@page { size: A4 portrait; margin: 10mm; } body { margin: 0; background: #fff; font-family: "Segoe UI", Arial, sans-serif; color: #111; }
.sheet { width: 100%; max-width: 190mm; margin: 0 auto; padding: 4mm; } .header { background: #dfe1e4; border: 1px solid #ced2d8; padding: 10px 12px; display: grid; grid-template-columns: 130px 1fr; gap: 14px; align-items: center; }
.logo-wrap { display: grid; justify-items: center; gap: 4px; } .logo-wrap img { width: 100px; height: 100px; object-fit: contain; }
.brand-title { text-align: center; font-weight: 900; font-size: 26px; line-height: 1.05; letter-spacing: 0.4px; text-transform: uppercase; }
.brand-sub { margin: 10px auto 0; width: fit-content; background: #fff; border-radius: 14px; padding: 8px 20px; font-size: 22px; font-weight: 700; }
.meta { margin-top: 12px; border: 1px solid #1f2937; border-radius: 16px; padding: 8px 10px; display: grid; grid-template-columns: 64px 1fr; gap: 10px; align-items: center; }
.meta-box { border: 1px solid #1f2937; height: 90px; } .meta-grid { display: grid; grid-template-columns: 1fr auto; gap: 8px 24px; font-size: 18px; }
.dots { border-bottom: 1px dotted #222; min-width: 230px; display: inline-block; margin-left: 5px; } table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 16px; }
th, td { border: 1px solid #111; padding: 4px 6px; text-align: left; height: 26px; } th { background: #d9e0ea; font-size: 16px; font-weight: 800; text-transform: uppercase; }
th:nth-child(2), td:nth-child(2), th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4), th:nth-child(5), td:nth-child(5) { text-align: center; }
.totals-grid { margin-top: 14px; display: grid; grid-template-columns: 1fr 1.1fr; gap: 14px; } .totals-box, .summary-box { border: 1px solid #5b8de0; min-height: 92px; padding: 10px 12px; font-size: 18px; }
.summary-box { background: #d9e0ea; border-color: #c8d0dc; } .summary-box strong { font-size: 24px; } .notes { margin-top: 16px; font-size: 18px; font-weight: 600; line-height: 1.45; }
.notes li { margin-bottom: 3px; } .signatures { margin-top: 70px; display: grid; grid-template-columns: 1fr 1fr; gap: 30px; text-align: center; font-size: 18px; }
.sign-line { margin-bottom: 8px; letter-spacing: 2px; } .powered { text-align: center; margin-top: 80px; font-size: 20px; }
  </style></head><body><div class="sheet">
<div class="header"><div class="logo-wrap"><img src="/pepsi-logo.png" alt="Pepsi logo" /></div><div><div class="brand-title">M.W.M.B CHANDRASEKARA<br/>MATALE DISTRIBUTOR</div><div class="brand-sub">Tenna - Matale. Tel : 076-0470123</div></div></div>
<div class="meta"><div class="meta-box"></div><div class="meta-grid"><div>Name : <span class="dots">${escapeHtml(pickedCustomer)}</span></div><div>Date : <span class="dots">${escapeHtml(dateLabel)}</span></div><div>Address : <span class="dots">${escapeHtml(customer?.address || "-")}</span></div><div>Tel : <span class="dots">${escapeHtml(customer?.phone || "-")}</span></div></div></div>
<table><thead><tr><th>Item Code</th><th>Qty</th><th>Billing Price</th><th>Item Discount</th><th>Total</th></tr></thead><tbody>${rowsHtml}</tbody></table>
<div class="totals-grid"><div class="totals-box"><div>EMPTY ISSUE :</div><div>EMPTY RECEIVED :</div></div><div class="summary-box"><div><strong>TOTAL VALUE :</strong> LKR ${toMoney(sale?.total)}</div><div>DISCOUNT : LKR ${toMoney(sale?.discount)}</div><div>${escapeHtml(String(sale?.paymentType || "").toUpperCase())} ${sale?.paymentType === "credit" && sale?.creditDueDate ? `(DUE ${escapeHtml(sale.creditDueDate)})` : ""}</div></div></div>
<ul class="notes"><li>Return or exchange only with this receipt</li><li>Credit Payment for all goods shall be made No later than 14 days</li></ul>
<div class="signatures"><div><div class="sign-line">.......................................</div><div>Customer Signature</div><div>Rubber Stamp</div></div><div><div class="sign-line">.......................................</div><div>P.S.R Signature</div></div></div>
<div class="powered">Powered By J&amp;Co.</div></div></body></html>`;

  printWindow.document.open();
  printWindow.document.write(receiptHtml);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 250);
};

const LoginScreen = ({ onLogin, error }) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-login-title">
            
            </div>
        <div className="auth-brand">
          <img src="/pepsi-logo.svg" alt="Pepsi logo" />
          
        </div>
        
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        {error ? <p className="auth-error">{error}</p> : null}
        <button className="auth-submit" type="button" onClick={() => onLogin({ username, password })}>Sign in</button>
        <div className="auth-bottom-logo">
          <a href="https://www.jnco.tech" target="_blank" rel="noreferrer">
            <img src="/powered.png" alt="Powered by" />
          </a>
        </div>
      </div>
    </div>
  );
};

const Header = ({ dashboard, user, onLogout }) => {
  const headerUser = user.role === "admin" ? "M.W.M.B CHANDRASEKARA" : (user.name || user.username || "").toUpperCase();

  return (
    <header className="topbar">
      <div className="header-card">
        <div className="brand">
          <img className="brand-logo" src="/pepsi-logo.png" alt="Pepsi logo" />
          <div className="brand-copy">
            <h1>Pepsi Distributer</h1>
            <p className="brand-user">{headerUser}</p>
            <p className="brand-role">{user.role === "cashier" ? "Cashier Dashboard" : "Admin Dashboard"}</p>
          </div>
        </div>
        <button className="logout-btn" type="button" onClick={onLogout}>LOG OUT</button>
      </div>
      
    </header>
  );
};

const CashierView = ({
  state,
  dashboard,
  search,
  setSearch,
  cashier,
  customerName,
  setCustomerName,
  lorry,
  setLorry,
  paymentType,
  setPaymentType,
  cashReceived,
  setCashReceived,
  creditDueDate,
  setCreditDueDate,
  discountMode,
  setDiscountMode,
  discountValue,
  setDiscountValue,
  cart,
  setCart,
  totals,
  message,
  checkout
}) => {
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return state.products;
    return state.products.filter((item) =>
      item.name.toLowerCase().includes(term)
      || item.sku.toLowerCase().includes(term)
      || item.category.toLowerCase().includes(term)
      || String(item.size || "").toLowerCase().includes(term)
      || productDisplayName(item).toLowerCase().includes(term)
    );
  }, [search, state.products]);
  const cartQtyByProduct = useMemo(() => {
    const map = new Map();
    for (const line of (cart || [])) {
      map.set(line.productId, (map.get(line.productId) || 0) + Number(line.quantity || 0));
    }
    return map;
  }, [cart]);

  const getCatalogStock = (product) => {
    const currentStock = Number(product?.stock || 0);
    const reserved = Number(cartQtyByProduct.get(product?.id) || 0);
    return Math.max(0, currentStock - reserved);
  };
  const lowStockThreshold = Number(state?.settings?.lowStockThreshold ?? 20);

  const savedCustomers = useMemo(() => {
    return [...(state.customers || [])].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }, [state.customers]);
  const customerOutstandingMap = useMemo(() => {
    const map = new Map();
    for (const sale of (state.sales || [])) {
      const key = String(sale.customerName || "").trim();
      if (!key || key.toLowerCase() === "walk-in") continue;
      const outstanding = Number(
        sale.outstandingAmount !== undefined
          ? sale.outstandingAmount
          : (sale.paymentType === "credit" ? sale.total : 0)
      ) || 0;
      if (outstanding > 0) {
        map.set(key, (map.get(key) || 0) + outstanding);
      }
    }
    return map;
  }, [state.sales]);
  const selectedCustomerOutstanding = useMemo(() => {
    const key = String(customerName || "").trim();
    if (!key) return 0;
    return Number(customerOutstandingMap.get(key) || 0);
  }, [customerName, customerOutstandingMap]);
  const repSessionStats = useMemo(() => {
    const rep = String(cashier || "").trim().toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    let orders = 0;
    let revenue = 0;
    for (const sale of (state.sales || [])) {
      const saleRep = String(sale.cashier || "").trim().toLowerCase();
      if (!rep || saleRep !== rep) continue;
      if (String(sale.createdAt || "").slice(0, 10) !== today) continue;
      orders += 1;
      revenue += Number(sale.total || 0);
    }
    return { orders, revenue: Number(revenue.toFixed(2)) };
  }, [cashier, state.sales]);

  const damagedQtyByProduct = useMemo(() => {
    const map = new Map();
    for (const ret of (state.returns || [])) {
      for (const line of (ret.lines || [])) {
        if (String(line.condition || "").toLowerCase() !== "damaged") continue;
        map.set(line.productId, (map.get(line.productId) || 0) + Number(line.quantity || 0));
      }
    }
    return map;
  }, [state.returns]);

  const repStockRows = useMemo(() => {
    return (state.products || [])
      .map((product) => {
        const remaining = Number(product.stock || 0);
        const damaged = Number(damagedQtyByProduct.get(product.id) || 0);
        return {
          id: product.id,
          name: productDisplayName(product),
          billingPrice: Number(product?.billingPrice ?? product?.price ?? 0),
          mrp: Number(product?.mrp ?? product?.price ?? 0),
          remaining,
          damaged
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [state.products, damagedQtyByProduct]);

  const repStockSummary = useMemo(() => {
    let remainingTotal = 0;
    let damagedTotal = 0;
    for (const row of repStockRows) {
      remainingTotal += Number(row.remaining || 0);
      damagedTotal += Number(row.damaged || 0);
    }
    return {
      remainingItems: remainingTotal,
      damagedItems: damagedTotal,
      damagedSkus: repStockRows.filter((row) => row.damaged > 0).length
    };
  }, [repStockRows]);

  const customerNameOptions = useMemo(() => {
    const names = new Set((state.customers || []).map((item) => String(item.name || "").trim()).filter(Boolean));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [state.customers]);

  const filteredCustomerOptions = useMemo(() => {
    const term = customerName.trim().toLowerCase();
    if (!term) return [];
    return customerNameOptions.filter((name) => name.toLowerCase().includes(term)).slice(0, 8);
  }, [customerName, customerNameOptions]);

  const triggerAddHaptic = () => {
    const now = Date.now();
    if (now - lastHapticAtRef.current < 120) return;
    lastHapticAtRef.current = now;
    try {
      if (typeof window === "undefined") return;
      const vibrate = window.navigator?.vibrate;
      if (typeof vibrate !== "function") return;
      const ok = vibrate.call(window.navigator, [18, 12, 22]);
      if (!ok) vibrate.call(window.navigator, 28);
    } catch {}
  };

  const addToCart = (product) => {
    if (getCatalogStock(product) <= 0) return;
    triggerAddHaptic();
    const requested = Math.floor(Number(catalogQtyDrafts[product.id] || 1));
    const requestQty = Number.isFinite(requested) && requested > 0 ? requested : 1;
    setCart((current) => {
      const idx = current.findIndex((line) => line.productId === product.id);
      const alreadyInCart = idx === -1 ? 0 : Number(current[idx].quantity || 0);
      const available = Math.max(0, Number(product.stock || 0) - alreadyInCart);
      if (available <= 0) return current;
      const addQty = Math.min(available, requestQty);
      if (idx === -1) return [...current, {
        productId: product.id,
        name: productDisplayName(product),
        basePrice: productSalePrice(product),
        itemDiscount: 0,
        itemDiscountMode: "amount",
        price: productSalePrice(product),
        quantity: addQty
      }];
      const clone = [...current];
      clone[idx] = { ...clone[idx], quantity: clone[idx].quantity + addQty };
      return clone;
    });
    setCatalogQtyDrafts((current) => ({ ...current, [product.id]: "" }));
  };

  const updateQty = (productId, quantity) => {
    if (quantity === "") return;
    const parsed = Number(quantity);
    if (!Number.isFinite(parsed)) return;
    const nextQty = Math.floor(parsed);
    if (nextQty <= 0) {
      setCart((current) => current.filter((line) => line.productId !== productId));
      return;
    }
    setCart((current) => current.map((line) => (line.productId === productId ? { ...line, quantity: nextQty } : line)));
  };
  const updateItemDiscount = (productId, value) => {
    const parsed = Number(value || 0);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setCart((current) => current.map((line) => {
      if (line.productId !== productId) return line;
      const base = lineBasePrice(line);
      const mode = String(line.itemDiscountMode || "amount");
      if (mode === "percent") return { ...line, itemDiscount: Math.min(parsed, 100) };
      return { ...line, itemDiscount: Math.min(parsed, base) };
    }));
  };
  const updateItemDiscountMode = (productId, mode) => {
    setCart((current) => current.map((line) => {
      if (line.productId !== productId) return line;
      const nextMode = mode === "percent" ? "percent" : "amount";
      const currentValue = Number(line.itemDiscount || 0);
      const clamped = nextMode === "percent"
        ? Math.min(Math.max(0, currentValue), 100)
        : Math.min(Math.max(0, currentValue), lineBasePrice(line));
      return { ...line, itemDiscountMode: nextMode, itemDiscount: clamped };
    }));
  };
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [customerDraft, setCustomerDraft] = useState({ name: "", phone: "", address: "" });
  const [customerDraftError, setCustomerDraftError] = useState("");
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [showCustomerSuggestions, setShowCustomerSuggestions] = useState(false);
  const [catalogQtyDrafts, setCatalogQtyDrafts] = useState({});
  const [cashierPage, setCashierPage] = useState("billing");
  const [returnSaleId, setReturnSaleId] = useState("");
  const [returnCustomerName, setReturnCustomerName] = useState("");
  const [showReturnCustomerSuggestions, setShowReturnCustomerSuggestions] = useState(false);
  const [returnLinesDraft, setReturnLinesDraft] = useState({});
  const [returnError, setReturnError] = useState("");
  const [savingReturn, setSavingReturn] = useState(false);
  const lastHapticAtRef = useRef(0);
  const [mobileCashierNavOpen, setMobileCashierNavOpen] = useState(false);

  useEffect(() => {
    setMobileCashierNavOpen(false);
  }, [cashierPage]);

  const returnSale = useMemo(
    () => state.sales.find((sale) => String(sale.id) === String(returnSaleId).trim()) || null,
    [state.sales, returnSaleId]
  );

  const returnCustomerOptions = useMemo(() => {
    const rep = String(cashier || "").trim().toLowerCase();
    const names = new Set(
      (state.sales || [])
        .filter((sale) => String(sale.cashier || "").trim().toLowerCase() === rep)
        .map((sale) => String(sale.customerName || "").trim())
        .filter(Boolean)
    );
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [state.sales, cashier]);

  const filteredReturnCustomerOptions = useMemo(() => {
    const term = String(returnCustomerName || "").trim().toLowerCase();
    if (!term) return [];
    return returnCustomerOptions.filter((name) => name.toLowerCase().includes(term)).slice(0, 8);
  }, [returnCustomerName, returnCustomerOptions]);

  const returnSalesForCustomer = useMemo(() => {
    const rep = String(cashier || "").trim().toLowerCase();
    const selected = String(returnCustomerName || "").trim().toLowerCase();
    if (!selected) return [];
    return (state.sales || [])
      .filter((sale) =>
        String(sale.cashier || "").trim().toLowerCase() === rep
        && String(sale.customerName || "").trim().toLowerCase() === selected
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [state.sales, cashier, returnCustomerName]);

  const returnedQtyByProduct = useMemo(() => {
    const map = new Map();
    const saleId = String(returnSaleId).trim();
    if (!saleId) return map;
    for (const ret of (state.returns || [])) {
      if (String(ret.saleId) !== saleId) continue;
      for (const line of (ret.lines || [])) {
        map.set(line.productId, (map.get(line.productId) || 0) + Number(line.quantity || 0));
      }
    }
    return map;
  }, [state.returns, returnSaleId]);

  const quickAddCustomer = () => {
    setCustomerDraft({ name: "", phone: "", address: "" });
    setCustomerDraftError("");
    setShowAddCustomer(true);
  };

  const saveQuickCustomer = async () => {
    const name = customerDraft.name.trim();
    const phone = customerDraft.phone.trim();
    const address = customerDraft.address.trim();
    if (!name || !phone || !address) {
      setCustomerDraftError("Customer name, mobile, and address are required.");
      return;
    }
    try {
      setSavingCustomer(true);
      await createCustomer({ name, phone, address });
      setCustomerName(name);
      setShowAddCustomer(false);
    } catch (error) {
      setCustomerDraftError(error.message);
    } finally {
      setSavingCustomer(false);
    }
  };

  const onReturnDraftChange = (productId, patch) => {
    setReturnLinesDraft((current) => ({
      ...current,
      [productId]: { quantity: current[productId]?.quantity || "", condition: current[productId]?.condition || "good", ...patch }
    }));
  };

  const submitReturnFromSale = async () => {
    try {
      const saleId = String(returnSaleId || "").trim();
      if (!saleId) {
        setReturnError("Enter Sale ID.");
        return;
      }
      if (!returnSale) {
        setReturnError("Sale not found.");
        return;
      }
      if (String(returnSale.cashier || "").trim().toLowerCase() !== String(cashier || "").trim().toLowerCase()) {
        setReturnError(`Sale belongs to ${returnSale.cashier || "another rep"}. You can return only your own sales.`);
        return;
      }
      const lines = (returnSale.lines || [])
        .map((line) => {
          const draft = returnLinesDraft[line.productId] || {};
          const qty = Number(draft.quantity || 0);
          return {
            productId: line.productId,
            quantity: qty,
            condition: draft.condition || "good"
          };
        })
        .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
      if (!lines.length) {
        setReturnError("Enter at least one return quantity.");
        return;
      }
      setSavingReturn(true);
      setReturnError("");
      await submitReturn({ saleId, lines });
      setReturnLinesDraft({});
      setReturnSaleId("");
    } catch (error) {
      setReturnError(error.message);
    } finally {
      setSavingReturn(false);
    }
  };

  const repSales = useMemo(() => {
    const rep = String(cashier || "").trim().toLowerCase();
    return (state.sales || [])
      .filter((sale) => String(sale.cashier || "").trim().toLowerCase() === rep)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [cashier, state.sales]);
  const repCompareRows = useMemo(() => {
    const map = new Map();
    for (const sale of (state.sales || [])) {
      const rep = String(sale.cashier || "Unknown").trim() || "Unknown";
      const row = map.get(rep) || { rep, bills: 0, revenue: 0 };
      row.bills += 1;
      row.revenue += Number(sale.total || 0);
      map.set(rep, row);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [state.sales]);
  const [editingSaleId, setEditingSaleId] = useState("");
  const [saleEditLines, setSaleEditLines] = useState([]);
  const [saleEditError, setSaleEditError] = useState("");
  const [savingSaleEdit, setSavingSaleEdit] = useState(false);

  const openSaleEdit = (sale) => {
    setEditingSaleId(sale.id);
    setSaleEditLines((sale.lines || []).map((line) => ({
      productId: line.productId,
      name: line.name,
      quantity: Number(line.quantity || 0)
    })));
    setSaleEditError("");
  };

  const saveSaleEdit = async () => {
    try {
      const lines = saleEditLines
        .map((line) => ({ ...line, quantity: Number(line.quantity || 0) }))
        .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
      if (!editingSaleId || !lines.length) {
        setSaleEditError("Keep at least one item in bill.");
        return;
      }
      setSavingSaleEdit(true);
      setSaleEditError("");
      await patchSale(editingSaleId, { lines });
      setEditingSaleId("");
      setSaleEditLines([]);
    } catch (error) {
      setSaleEditError(error.message);
    } finally {
      setSavingSaleEdit(false);
    }
  };

  return (
    <>
      {message && !/(error|invalid|required|cannot|unable|failed|not found|select|enter|type|exceeds)/i.test(String(message)) ? <p className="notice">{message}</p> : null}
      <button
        type="button"
        className={`cashier-mobile-nav-toggle menu-toggle-btn ${mobileCashierNavOpen ? "open" : ""}`}
        onClick={() => setMobileCashierNavOpen((current) => !current)}
        aria-expanded={mobileCashierNavOpen}
        aria-controls="cashier-sidebar-nav"
        aria-label={mobileCashierNavOpen ? "Close menu" : "Open menu"}
      >
        <span className="menu-toggle-icon" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="menu-toggle-label">{mobileCashierNavOpen ? "Close" : "Menu"}</span>
      </button>
      {mobileCashierNavOpen ? (
        <button
          type="button"
          className="cashier-mobile-nav-backdrop"
          onClick={() => setMobileCashierNavOpen(false)}
          aria-label="Close menu"
        />
      ) : null}
      <aside id="cashier-sidebar-nav" className={`cashier-mobile-sidebar ${mobileCashierNavOpen ? "open" : ""}`}>
        <button type="button" className={cashierPage === "billing" ? "active" : ""} onClick={() => setCashierPage("billing")}>Billing</button>
        <button type="button" className={cashierPage === "returns" ? "active" : ""} onClick={() => setCashierPage("returns")}>Returns</button>
        <button type="button" className={cashierPage === "sales" ? "active" : ""} onClick={() => setCashierPage("sales")}>Sales</button>
        <button type="button" className={cashierPage === "stock" ? "active" : ""} onClick={() => setCashierPage("stock")}>Stock</button>
        <button type="button" className={cashierPage === "customers" ? "active" : ""} onClick={() => setCashierPage("customers")}>Customers</button>
        <div className="side-menu-footer">
          <a href="https://www.jnco.tech" target="_blank" rel="noreferrer">
            <img src="/powered.png" alt="Powered by" />
          </a>
        </div>
      </aside>
      <div className="cashier-tabs">
        <button type="button" className={cashierPage === "billing" ? "active" : ""} onClick={() => setCashierPage("billing")}>Billing</button>
        <button type="button" className={cashierPage === "returns" ? "active" : ""} onClick={() => setCashierPage("returns")}>Returns</button>
        <button type="button" className={cashierPage === "sales" ? "active" : ""} onClick={() => setCashierPage("sales")}>Sales</button>
        <button type="button" className={cashierPage === "stock" ? "active" : ""} onClick={() => setCashierPage("stock")}>Stock</button>
        <button type="button" className={cashierPage === "customers" ? "active" : ""} onClick={() => setCashierPage("customers")}>Customers</button>
      </div>

      {cashierPage === "billing" ? (
        <main className="grid billing-grid">
          <section className="panel">
            <h2 className="panel-title"><span className="panel-icon" aria-hidden="true">📦</span>Catalog</h2>
            <input className="search-icon-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product / sku / category" />
            <div className="list">
              {filteredProducts.map((product) => (
                <article key={product.id} className="list-row">
                  <div>
                    <strong>{productDisplayName(product)}</strong>
                    <p>{product.sku} • {product.category}</p>
                    <p>
                      {currency(productSalePrice(product))}
                      {" • "}
                      <span className={getCatalogStock(product) <= lowStockThreshold ? "stock-low-text" : ""}>
                        Stock {getCatalogStock(product)}
                      </span>
                    </p>
                  </div>
                  <div className="catalog-add-wrap">
                    <input
                      type="number"
                      min="1"
                      value={catalogQtyDrafts[product.id] ?? ""}
                      onChange={(e) => setCatalogQtyDrafts((current) => ({ ...current, [product.id]: e.target.value }))}
                      placeholder="Qty"
                      className="catalog-qty-input"
                    />
                    <button className="add-feedback-btn" type="button" onTouchStart={triggerAddHaptic} onPointerDown={triggerAddHaptic} onClick={() => addToCart(product)} disabled={getCatalogStock(product) <= 0}>Add</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2 className="panel-title"><span className="panel-icon" aria-hidden="true">🛒</span>Cart</h2>
           
            <div className="list cart-list">
               <section className="panel">
              {cart.length ? cart.map((line) => (
                <article className="list-row" key={line.productId}>
                  <div className="cart-line-head">
                    <strong>{line.name}</strong>
                    <p>{currency(lineBasePrice(line))} each • Item Disc {currency(lineItemDiscount(line))} • Net {currency(lineFinalPrice(line))}</p>
                  </div>
                  <div className="cart-line-controls">
                    <div className="qty-box">
                      <button type="button" onClick={() => updateQty(line.productId, line.quantity - 1)}>-</button>
                      <span>{line.quantity}</span>
                      <button type="button" onClick={() => updateQty(line.productId, line.quantity + 1)}>+</button>
                    </div>
                    <div className="item-discount-wrap">
                      <div className="item-discount-inline">
                        <select value={line.itemDiscountMode || "amount"} onChange={(e) => updateItemDiscountMode(line.productId, e.target.value)}>
                          <option value="amount">Rs.</option>
                          <option value="percent">%</option>
                        </select>
                        <input type="number" min="0" step="0.01" value={line.itemDiscount ?? 0} onChange={(e) => updateItemDiscount(line.productId, e.target.value)} placeholder="Item Disc" />
                      </div>
                      <p className="form-hint">Item Discount ({line.itemDiscountMode === "percent" ? "%" : "Rs."})</p>
                    </div>
                  </div>
              </article>
            )) : <p className="form-hint">Empty</p>}
            
            </section>
            </div>
             <div className="totals">
              <p>Subtotal: {currency(totals.subTotal)}</p>
              <p>Discount: {currency(totals.discountAmount)}</p>
              <h3>Total: {currency(totals.total)}</h3>
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title"><span className="panel-icon" aria-hidden="true">💳</span>Checkout</h2>
            <div className="form-grid">
              <p className="form-hint">Cashier: {cashier || "-"}</p>
              <input
                value={customerName}
                onChange={(e) => {
                  setCustomerName(e.target.value);
                  setShowCustomerSuggestions(true);
                }}
                onFocus={() => setShowCustomerSuggestions(true)}
                onBlur={() => setTimeout(() => setShowCustomerSuggestions(false), 120)}
                placeholder="Customer"
              />
              {showCustomerSuggestions && filteredCustomerOptions.length ? (
                <div className="customer-suggestions">
                  {filteredCustomerOptions.map((name) => (
                    <button key={name} type="button" onClick={() => { setCustomerName(name); setShowCustomerSuggestions(false); }}>
                      {name}
                      {customerOutstandingMap.get(name) ? <span className="outstanding-text"> • OS {currency(customerOutstandingMap.get(name))}</span> : ""}
                    </button>
                  ))}
                </div>
              ) : null}
              {customerName.trim() ? <p className="form-hint outstanding-text">Outstanding: {currency(selectedCustomerOutstanding)}</p> : null}
              <label className="form-hint">Total Bill Discount</label>
              <div className="bill-discount-inline">
                <select value={discountMode} onChange={(e) => setDiscountMode(e.target.value)}>
                  <option value="amount">Rs.</option>
                  <option value="percent">%</option>
                </select>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountMode === "percent" ? "Discount %" : "Discount Rs."}
                />
              </div>
              
              <select value={lorry} onChange={(e) => setLorry(e.target.value)}>
                <option value="">Select delivery lorry</option>
                <option value="Lorry A">Lorry A</option>
                <option value="Lorry B">Lorry B</option>
              </select>
              <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
                {PAYMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              {paymentType === "cash" ? (
                <input type="number" step="0.01" min="0" value={cashReceived} onChange={(e) => setCashReceived(e.target.value)} placeholder="Cash received" />
              ) : null}
              {paymentType === "credit" ? (
                <>
                  <label className="form-hint">Credit due date</label>
                  <input type="date" value={creditDueDate} onChange={(e) => setCreditDueDate(e.target.value)} placeholder="Credit due date" />
                </>
              ) : null}
              
            </div>
           
            
            
            
           
            <button className="checkout" type="button" onClick={checkout} disabled={!cart.length}>Complete Sale</button>
            
          </section>

        </main>
      ) : null}

      {cashierPage === "returns" ? (
        <main className="grid">
          <section className="panel">
            <h2>Returns</h2>
            <div className="form-grid">
              <p className="form-hint">Rep: {cashier || "-"}</p>
              <input
                value={returnCustomerName}
                onChange={(e) => {
                  setReturnCustomerName(e.target.value);
                  setShowReturnCustomerSuggestions(true);
                  setReturnSaleId("");
                  setReturnLinesDraft({});
                  setReturnError("");
                }}
                onFocus={() => setShowReturnCustomerSuggestions(true)}
                onBlur={() => setTimeout(() => setShowReturnCustomerSuggestions(false), 120)}
                placeholder="Type customer name"
              />
              {showReturnCustomerSuggestions && filteredReturnCustomerOptions.length ? (
                <div className="customer-suggestions">
                  {filteredReturnCustomerOptions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        setReturnCustomerName(name);
                        setShowReturnCustomerSuggestions(false);
                        setReturnSaleId("");
                        setReturnLinesDraft({});
                        setReturnError("");
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              ) : null}
              <select
                value={returnSaleId}
                onChange={(e) => { setReturnSaleId(e.target.value); setReturnLinesDraft({}); setReturnError(""); }}
                disabled={!returnCustomerName.trim()}
              >
                <option value="">{returnCustomerName.trim() ? "Select bill (Sale ID)" : "Select customer first"}</option>
                {returnSalesForCustomer.map((sale) => (
                  <option key={sale.id} value={sale.id}>
                    #{sale.id} • {new Date(sale.createdAt).toLocaleDateString()} • {currency(sale.total)}
                  </option>
                ))}
              </select>
              <input value={returnSaleId} onChange={(e) => { setReturnSaleId(e.target.value); setReturnLinesDraft({}); setReturnError(""); }} placeholder="Enter Sale ID (e.g. 00001)" />
            </div>
            {!returnSaleId ? <p className="form-hint">Select customer then bill, or type Sale ID manually to load bill items.</p> : null}
            {returnSaleId && !returnSale ? <p className="form-hint">Sale not found.</p> : null}
            {returnSale ? (
              <>
                <article className="list-row">
                  <div>
                    <strong>Sale #{returnSale.id}</strong>
                    <p>{new Date(returnSale.createdAt).toLocaleString()}</p>
                    <p>{returnSale.customerName} • {returnSale.lorry || "-"}</p>
                  </div>
                  <strong>{currency(returnSale.total)}</strong>
                </article>
                <div className="list">
                  {(returnSale.lines || []).map((line) => {
                    const sold = Number(line.quantity || 0);
                    const returned = Number(returnedQtyByProduct.get(line.productId) || 0);
                    const draft = returnLinesDraft[line.productId] || { quantity: "", condition: "good" };
                    const draftQty = Number(draft.quantity || 0);
                    const remainingBeforeDraft = Math.max(0, sold - returned);
                    const remainingLive = Math.max(0, sold - returned - (Number.isFinite(draftQty) ? draftQty : 0));
                    return (
                      <article key={line.productId} className="list-row">
                        <div>
                          <strong>{line.name}</strong>
                          <p>Sold {sold} • Returned {returned} • Remaining {remainingLive}</p>
                        </div>
                        <div className="return-line-controls">
                          <input type="number" min="0" max={remainingBeforeDraft} value={draft.quantity} onChange={(e) => onReturnDraftChange(line.productId, { quantity: e.target.value })} placeholder="Qty" />
                          <select value={draft.condition} onChange={(e) => onReturnDraftChange(line.productId, { condition: e.target.value })}>
                            <option value="good">Good</option>
                            <option value="damaged">Expired / Damaged</option>
                          </select>
                        </div>
                      </article>
                    );
                  })}
                </div>
                {returnError ? <p className="form-hint">{returnError}</p> : null}
                <button type="button" onClick={submitReturnFromSale} disabled={savingReturn}>{savingReturn ? "Saving Return..." : "Submit Return"}</button>
              </>
            ) : null}
          </section>
        </main>
      ) : null}

      {cashierPage === "sales" ? (
        <main className="grid">
          <section className="panel">
            <h2>My Sales</h2>
            <div className="list">
              {repSales.map((sale) => (
                <article key={sale.id} className="list-row">
                  <div>
                    <strong>#{sale.id}</strong>
                    <p>{new Date(sale.createdAt).toLocaleString()}</p>
                    <p>{sale.customerName} • {sale.paymentType} • {sale.lorry || "-"}</p>
                  </div>
                  <div>
                    <strong>{currency(sale.total)}</strong>
                    <button type="button" onClick={() => openSaleEdit(sale)}>Edit</button>
                  </div>
                </article>
              ))}
            </div>
            {editingSaleId ? (
              <div className="admin-inline-form">
                <p className="form-hint">Editing sale #{editingSaleId}</p>
                {saleEditLines.map((line) => (
                  <div key={line.productId} className="stock-row">
                    <span>{line.name}</span>
                    <input type="number" min="1" value={line.quantity} onChange={(e) => setSaleEditLines((current) => current.map((l) => (l.productId === line.productId ? { ...l, quantity: e.target.value } : l)))} />
                    <button type="button" className="row-danger" onClick={() => setSaleEditLines((current) => current.filter((l) => l.productId !== line.productId))}>Remove</button>
                  </div>
                ))}
                {saleEditError ? <p className="form-hint">{saleEditError}</p> : null}
                <div>
                  <button type="button" onClick={saveSaleEdit} disabled={savingSaleEdit}>{savingSaleEdit ? "Saving..." : "Save Edit"}</button>
                  <button type="button" className="ghost" onClick={() => { setEditingSaleId(""); setSaleEditLines([]); setSaleEditError(""); }}>Cancel</button>
                </div>
              </div>
            ) : null}
          </section>
          <section className="panel">
            <h2>Recent Sales</h2>
            <div className="list">
              {state.sales.slice(0, 20).map((sale) => (
                <article key={sale.id} className="list-row">
                  <div>
                    <strong>#{sale.id} ({sale.cashier || "-"})</strong>
                    <p>{new Date(sale.createdAt).toLocaleString()}</p>
                    <p>{sale.customerName} • {sale.paymentType} • {sale.lorry || "-"}</p>
                  </div>
                  <strong>{currency(sale.total)}</strong>
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2>Rep Comparison</h2>
            <div className="list">
              {repCompareRows.map((row) => (
                <article key={row.rep} className="list-row">
                  <div>
                    <strong>{row.rep}</strong>
                    <p>{row.bills} bill(s)</p>
                  </div>
                  <strong>{currency(row.revenue)}</strong>
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2>Session</h2>
            <p>Cashier: {cashier}</p>
            <p>Today orders: {repSessionStats.orders}</p>
            <p>Today revenue: {currency(repSessionStats.revenue)}</p>
          </section>
        </main>
      ) : null}

      {cashierPage === "customers" ? (
        <main className="grid">
          <section className="panel">
            <h2>Saved Customers</h2>
            <div className="list">
              {savedCustomers.length ? savedCustomers.map((customer) => (
                <article key={customer.id} className="list-row">
                  <div>
                    <strong>{customer.name}</strong>
                    <p>{customer.phone || "-"}</p>
                    <p>{customer.address || "-"}</p>
                    <p className="outstanding-text">Outstanding: {currency(customerOutstandingMap.get(customer.name) || 0)}</p>
                  </div>
                </article>
              )) : <p>No saved customers yet.</p>}
            </div>
          </section>
        </main>
      ) : null}

      {cashierPage === "stock" ? (
        <main className="grid">
          <section className="panel rep-stock-panel">
            <h2>Stock Overview</h2>
            <div className="rep-stock-metrics">
              <article>
                <p>Remaining Items</p>
                <strong>{repStockSummary.remainingItems}</strong>
              </article>
              <article className="danger">
                <p>Damaged / Expired</p>
                <strong>{repStockSummary.damagedItems}</strong>
              </article>
              <article>
                <p>Affected SKUs</p>
                <strong>{repStockSummary.damagedSkus}</strong>
              </article>
            </div>
          </section>

          <section className="panel rep-stock-panel">
            <h2>Remaining Stock</h2>
            <div className="rep-stock-table">
              <header>
                <span>Item</span>
                <span>B.Price (LKR)</span>
                <span>MRP</span>
                <span>Remaining</span>
              </header>
              {repStockRows.map((row) => (
                <article key={`remain-${row.id}`}>
                  <span>{row.name}</span>
                  <span>{Number(row.billingPrice || 0).toFixed(2)}</span>
                  <span>{Number(row.mrp || 0).toFixed(2)}</span>
                  <span>{row.remaining}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="panel rep-stock-panel">
            <h2>Damaged / Expired Stock</h2>
            <div className="rep-stock-table rep-stock-table-danger">
              <header>
                <span>Item</span>
                <span>B.Price (LKR)</span>
                <span>MRP</span>
                <span>Damaged Qty</span>
              </header>
              {repStockRows.filter((row) => row.damaged > 0).length ? repStockRows
                .filter((row) => row.damaged > 0)
                .map((row) => (
                  <article key={`damaged-${row.id}`}>
                    <span>{row.name}</span>
                    <span>{Number(row.billingPrice || 0).toFixed(2)}</span>
                    <span>{Number(row.mrp || 0).toFixed(2)}</span>
                    <span>{row.damaged}</span>
                  </article>
                )) : <p className="form-hint">No damaged/expired items recorded yet.</p>}
            </div>
          </section>
        </main>
      ) : null}

      {cashierPage === "billing" ? (
        <div className="mobile-quickbar">
          <div>
            <p>{cart.length} item(s)</p>
            <strong>{currency(totals.total)}</strong>
          </div>
          <button type="button" onClick={checkout} disabled={!cart.length}>Complete Sale</button>
        </div>
      ) : null}
      {showAddCustomer ? (
        <div className="low-stock-modal" onClick={() => setShowAddCustomer(false)}>
          <div className="low-stock-modal-card customer-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Add Customer</h3>
              <button type="button" onClick={() => setShowAddCustomer(false)}>Close</button>
            </div>
            <div className="admin-inline-form">
              <input
                value={customerDraft.name}
                onChange={(e) => setCustomerDraft((current) => ({ ...current, name: e.target.value }))}
                placeholder="Customer name"
              />
              <input
                value={customerDraft.phone}
                onChange={(e) => setCustomerDraft((current) => ({ ...current, phone: e.target.value }))}
                placeholder="Mobile"
              />
              <textarea
                value={customerDraft.address}
                onChange={(e) => setCustomerDraft((current) => ({ ...current, address: e.target.value }))}
                placeholder="Address"
              />
              {customerDraftError ? <p className="form-hint">{customerDraftError}</p> : null}
              <div>
                <button type="button" onClick={saveQuickCustomer} disabled={savingCustomer}>
                  {savingCustomer ? "Saving..." : "Save Customer"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {cashierPage === "billing" ? (
        <button type="button" className="add-customer-fab" onClick={quickAddCustomer} title="Add customer">
          <span className="fab-plus">+</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4.5 3.6-8 8-8s8 3.5 8 8" />
          </svg>
        </button>
      ) : null}
    </>
  );
};

const AdminView = ({ state, dashboard, message, onError }) => {
  const [showLowStock, setShowLowStock] = useState(false);
  const [selectedRep, setSelectedRep] = useState("");
  const [chartDateFrom, setChartDateFrom] = useState("");
  const [chartDateTo, setChartDateTo] = useState("");
  const [repDateFrom, setRepDateFrom] = useState("");
  const [repDateTo, setRepDateTo] = useState("");
  const [itemReportLorry, setItemReportLorry] = useState("all");
  const [itemDateFrom, setItemDateFrom] = useState("");
  const [itemDateTo, setItemDateTo] = useState("");
  const [salesDateFrom, setSalesDateFrom] = useState("");
  const [salesDateTo, setSalesDateTo] = useState("");
  const [loadingDateFrom, setLoadingDateFrom] = useState("");
  const [loadingDateTo, setLoadingDateTo] = useState("");
  const [customerReportSearch, setCustomerReportSearch] = useState("");
  const [customerPanelSearch, setCustomerPanelSearch] = useState("");
  const [stockPanelSearch, setStockPanelSearch] = useState("");
  const [deliveryLorry, setDeliveryLorry] = useState("all");
  const [deliveryDateFrom, setDeliveryDateFrom] = useState("");
  const [deliveryDateTo, setDeliveryDateTo] = useState("");
  const [deliveryReportDateFrom, setDeliveryReportDateFrom] = useState("");
  const [deliveryReportDateTo, setDeliveryReportDateTo] = useState("");
  const [reportDeliveryLorry, setReportDeliveryLorry] = useState("all");
  const [reportDeliveryDateFrom, setReportDeliveryDateFrom] = useState("");
  const [reportDeliveryDateTo, setReportDeliveryDateTo] = useState("");
  const [activePage, setActivePage] = useState("dashboard");
  const [notice, setNotice] = useState("");

  const [customerForm, setCustomerForm] = useState({ id: "", name: "", phone: "", address: "" });
  const [staffForm, setStaffForm] = useState({ id: "", name: "", role: "", phone: "" });
  const [stockMode, setStockMode] = useState("add");
  const [stockForm, setStockForm] = useState({ productId: "", quantity: "", stock: "", sku: "" });
  const [stockSearch, setStockSearch] = useState("");
  const [showStockSuggestions, setShowStockSuggestions] = useState(false);
  const [newStockItemForm, setNewStockItemForm] = useState({ sku: "", category: "General", billingPrice: "", mrp: "" });
  const stockFileRef = useRef(null);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [showStaffForm, setShowStaffForm] = useState(false);
  const [showStockForm, setShowStockForm] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState(false);
  const [deletingSaleId, setDeletingSaleId] = useState("");
  const [editingAdminSaleId, setEditingAdminSaleId] = useState("");
  const [adminSaleEditLines, setAdminSaleEditLines] = useState([]);
  const [adminSaleEditError, setAdminSaleEditError] = useState("");
  const [savingAdminSaleEdit, setSavingAdminSaleEdit] = useState(false);
  const [viewSaleId, setViewSaleId] = useState("");
  const [customerDetailName, setCustomerDetailName] = useState("");
  const [deliverySaleId, setDeliverySaleId] = useState("");
  const [deliveryDraft, setDeliveryDraft] = useState({});
  const [deliveryError, setDeliveryError] = useState("");
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [tableSort, setTableSort] = useState({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const isErrorNotice = /(error|invalid|required|cannot|unable|failed|not found|select|enter|type|exceeds|no\s.+to\sedit)/i.test(String(notice));
    if (!isErrorNotice) return;
    onError?.(notice);
    setNotice("");
  }, [notice, onError]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [activePage]);

  const inDateRange = (iso, from, to) => {
    const day = String(iso || "").slice(0, 10);
    if (!day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  };

  const toggleSort = (table, key) => {
    setTableSort((current) => {
      const prev = current[table];
      if (prev?.key === key) {
        return { ...current, [table]: { key, dir: prev.dir === "asc" ? "desc" : "asc" } };
      }
      return { ...current, [table]: { key, dir: "asc" } };
    });
  };

  const sortMark = (table, key) => {
    const sort = tableSort[table];
    if (!sort || sort.key !== key) return "";
    return sort.dir === "asc" ? " ▲" : " ▼";
  };

  const sortRows = (rows, table, defaultKey, getters) => {
    const sort = tableSort[table] || { key: defaultKey, dir: "asc" };
    const getValue = getters[sort.key] || (() => "");
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      const aNum = typeof av === "number" ? av : Number.NaN;
      const bNum = typeof bv === "number" ? bv : Number.NaN;
      if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return (aNum - bNum) * factor;
      return String(av || "").localeCompare(String(bv || ""), undefined, { numeric: true, sensitivity: "base" }) * factor;
    });
  };

  const chartData = useMemo(() => {
    const base = [];
    const today = new Date();
    const endDate = chartDateTo ? new Date(`${chartDateTo}T00:00:00`) : today;
    const startDate = chartDateFrom
      ? new Date(`${chartDateFrom}T00:00:00`)
      : (() => {
          const d = new Date(endDate);
          d.setDate(endDate.getDate() - 7);
          return d;
        })();
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) return [];
    const cursor = new Date(startDate);
    let guard = 0;
    while (cursor <= endDate && guard < 62) {
      const key = cursor.toISOString().slice(0, 10);
      const short = cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const daySales = state.sales.filter((sale) => String(sale.createdAt || "").slice(0, 10) === key);
      const count = daySales.length;
      const revenue = daySales.reduce((acc, sale) => acc + Number(sale.total || 0), 0);
      base.push({ key, short, count, revenue: Number(revenue.toFixed(2)) });
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
    return base;
  }, [state.sales, chartDateFrom, chartDateTo]);

  const maxCount = Math.max(1, ...chartData.map((item) => item.count));
  const repChartData = useMemo(() => {
    const map = new Map();
    for (const member of (state.staff || [])) {
      const repName = String(member.name || "").trim();
      if (!repName) continue;
      map.set(repName, 0);
    }
    for (const sale of state.sales) {
      const saleDay = String(sale.createdAt || "").slice(0, 10);
      if (repDateFrom && saleDay && saleDay < repDateFrom) continue;
      if (repDateTo && saleDay && saleDay > repDateTo) continue;
      const rep = sale.cashier || "Unknown";
      map.set(rep, (map.get(rep) || 0) + 1);
    }
    return [...map.entries()]
      .map(([rep, count]) => ({ rep, count }))
      .sort((a, b) => b.count - a.count);
  }, [state.sales, state.staff, repDateFrom, repDateTo]);

  const filteredRepChartData = useMemo(() => {
    if (!selectedRep) return repChartData;
    return repChartData.filter((row) => row.rep === selectedRep);
  }, [selectedRep, repChartData]);
  const repMaxCount = Math.max(1, ...filteredRepChartData.map((item) => item.count), 0);

  const productInfoById = useMemo(() => {
    return new Map(state.products.map((item) => [
      item.id,
      { name: item.name, sku: item.sku, size: item.size, category: item.category }
    ]));
  }, [state.products]);

  const reportSales = useMemo(
    () => (state.sales || []).filter((sale) => inDateRange(sale.createdAt, salesDateFrom, salesDateTo)),
    [state.sales, salesDateFrom, salesDateTo]
  );

  const itemReportSales = useMemo(
    () => (state.sales || []).filter((sale) => inDateRange(sale.createdAt, itemDateFrom, itemDateTo)),
    [state.sales, itemDateFrom, itemDateTo]
  );

  const itemWiseRows = useMemo(() => {
    const salesSource = itemReportLorry === "all"
      ? itemReportSales
      : itemReportSales.filter((sale) => sale.lorry === itemReportLorry);
    const map = new Map();
    for (const sale of salesSource) {
      for (const line of (sale.lines || [])) {
        const key = line.productId || line.name;
        const info = productInfoById.get(line.productId) || { name: line.name || "Unknown Item", sku: "-", size: "", category: "" };
        const row = map.get(key) || { key, name: info.name, sku: info.sku, size: info.size || "", category: info.category || "", qty: 0, bills: 0, revenue: 0 };
        row.qty += Number(line.quantity || 0);
        row.revenue += Number(line.quantity || 0) * Number(line.price || 0);
        row.bills += 1;
        map.set(key, row);
      }
    }
    return [...map.values()].sort((a, b) => b.qty - a.qty);
  }, [itemReportLorry, itemReportSales, productInfoById]);

  const loadingRowsByLorry = useMemo(() => {
    const buildRows = (lorryName) => {
      const map = new Map();
      for (const sale of state.sales) {
        if (!inDateRange(sale.createdAt, loadingDateFrom, loadingDateTo)) continue;
        if (sale.lorry !== lorryName) continue;
        for (const line of (sale.lines || [])) {
          const key = line.productId || line.name;
          const info = productInfoById.get(line.productId) || { name: line.name || "Unknown Item", sku: "-", size: "", category: "" };
          const row = map.get(key) || { key, name: info.name, sku: info.sku, size: info.size || "", category: info.category || "", qty: 0, value: 0 };
          const qty = Number(line.quantity || 0);
          const unit = Number(line.price || 0);
          row.qty += qty;
          row.value += qty * unit;
          map.set(key, row);
        }
      }
      const returnedByProduct = new Map();
      for (const ret of (state.returns || [])) {
        const retSale = (state.sales || []).find((s) => String(s.id) === String(ret.saleId));
        if (!retSale || retSale.lorry !== lorryName) continue;
        if (!inDateRange(ret.createdAt, loadingDateFrom, loadingDateTo)) continue;
        for (const line of (ret.lines || [])) {
          returnedByProduct.set(line.productId, (returnedByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
        }
      }
      const deliveredByProduct = new Map();
      for (const sale of state.sales) {
        if (!inDateRange(sale.createdAt, loadingDateFrom, loadingDateTo)) continue;
        if (sale.lorry !== lorryName) continue;
        if (!sale.deliveryConfirmedAt) continue;
        for (const line of (sale.lines || [])) {
          const lineKey = line.productId || line.name;
          deliveredByProduct.set(lineKey, (deliveredByProduct.get(lineKey) || 0) + Number(line.quantity || 0));
        }
      }
      return [...map.values()]
        .map((row) => {
          const bundleSize = getBundleSize(row);
          const bundles = bundleSize ? Math.floor(row.qty / bundleSize) : 0;
          const balance = bundleSize ? row.qty % bundleSize : row.qty;
          const deliveredRaw = Number(deliveredByProduct.get(row.key) || 0);
          const returned = Number(returnedByProduct.get(row.key) || 0);
          const deliveredQty = Math.max(0, deliveredRaw - returned);
          const deliveredValue = row.qty > 0 ? (row.value * (Math.min(deliveredQty, row.qty) / row.qty)) : 0;
          return { ...row, bundleSize, bundles, balance, orderedQty: row.qty, orderedValue: row.value, deliveredQty, deliveredValue };
        })
        .sort((a, b) => b.orderedQty - a.orderedQty);
    };

    return {
      "Lorry A": buildRows("Lorry A"),
      "Lorry B": buildRows("Lorry B")
    };
  }, [state.sales, state.returns, loadingDateFrom, loadingDateTo, productInfoById]);

  const salesWiseRows = useMemo(() => {
    return reportSales.map((sale) => ({
      id: sale.id,
      when: new Date(sale.createdAt).toLocaleDateString(),
      whenTs: new Date(sale.createdAt).getTime(),
      rep: sale.cashier || "-",
      lorry: sale.lorry || "-",
      total: Number(sale.total || 0),
      raw: sale
    }));
  }, [reportSales]);

  const customerWiseRows = useMemo(() => {
    const map = new Map();
    for (const sale of reportSales) {
      const key = sale.customerName || "Walk-in";
      const current = map.get(key) || { name: key, orders: 0, spent: 0, lastAt: "" };
      current.orders += 1;
      current.spent += Number(sale.total || 0);
      if (!current.lastAt || new Date(sale.createdAt).getTime() > new Date(current.lastAt).getTime()) {
        current.lastAt = sale.createdAt;
      }
      map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.spent - a.spent);
  }, [reportSales]);

  const customerRows = useMemo(() => {
    const map = new Map();
    for (const sale of state.sales) {
      const key = sale.customerName || "Walk-in";
      const existing = map.get(key) || { name: key, orders: 0, spent: 0, outstanding: 0, phone: "", address: "" };
      existing.orders += 1;
      existing.spent += Number(sale.total || 0);
      existing.outstanding += Number(
        sale.outstandingAmount !== undefined
          ? sale.outstandingAmount
          : (sale.paymentType === "credit" ? sale.total : 0)
      ) || 0;
      map.set(key, existing);
    }
    for (const customer of (state.customers || [])) {
      const existing = map.get(customer.name) || { name: customer.name, orders: 0, spent: 0, outstanding: 0 };
      map.set(customer.name, { ...existing, ...customer });
    }
    return [...map.values()].sort((a, b) => b.spent - a.spent);
  }, [state.sales, state.customers]);
  const filteredCustomerRows = useMemo(() => {
    const term = customerPanelSearch.trim().toLowerCase();
    if (!term) return customerRows;
    return customerRows.filter((row) =>
      String(row.name || "").toLowerCase().includes(term)
      || String(row.phone || "").toLowerCase().includes(term)
      || String(row.address || "").toLowerCase().includes(term)
    );
  }, [customerRows, customerPanelSearch]);
  const sortedCustomerRows = useMemo(
    () => sortRows(filteredCustomerRows, "customers", "name", {
      name: (row) => row.name,
      phone: (row) => row.phone || "",
      orders: (row) => Number(row.orders || 0),
      spent: (row) => Number(row.spent || 0),
      outstanding: (row) => Number(row.outstanding || 0)
    }),
    [filteredCustomerRows, tableSort]
  );
  const customerPageSummary = useMemo(() => {
    const rows = sortedCustomerRows || [];
    const totalCustomers = rows.length;
    let totalOrders = 0;
    let totalSpent = 0;
    let totalOutstanding = 0;
    let activeCustomers = 0;
    let customersWithOutstanding = 0;
    let topCustomer = null;
    for (const row of rows) {
      const orders = Number(row.orders || 0);
      const spent = Number(row.spent || 0);
      const outstanding = Number(row.outstanding || 0);
      totalOrders += orders;
      totalSpent += spent;
      totalOutstanding += outstanding;
      if (orders > 0) activeCustomers += 1;
      if (outstanding > 0) customersWithOutstanding += 1;
      if (!topCustomer || spent > Number(topCustomer.spent || 0)) topCustomer = row;
    }
    return {
      totalCustomers,
      activeCustomers,
      customersWithOutstanding,
      totalOrders,
      totalSpent: Number(totalSpent.toFixed(2)),
      totalOutstanding: Number(totalOutstanding.toFixed(2)),
      averageOrderValue: totalOrders > 0 ? Number((totalSpent / totalOrders).toFixed(2)) : 0,
      topCustomerName: topCustomer?.name || "-",
      topCustomerSpent: Number(topCustomer?.spent || 0)
    };
  }, [sortedCustomerRows]);
  const customerDetailData = useMemo(() => {
    const key = String(customerDetailName || "").trim().toLowerCase();
    if (!key) return null;
    const row = customerRows.find((item) => String(item.name || "").trim().toLowerCase() === key);
    if (!row) return null;
    const sales = (state.sales || [])
      .filter((sale) => String(sale.customerName || "").trim().toLowerCase() === key)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const totalBills = sales.length;
    const totalQty = sales.reduce((acc, sale) => acc + (sale.lines || []).reduce((lineAcc, line) => lineAcc + Number(line.quantity || 0), 0), 0);
    const averageBillValue = totalBills ? Number((Number(row.spent || 0) / totalBills).toFixed(2)) : 0;
    return {
      row,
      totalBills,
      totalQty,
      averageBillValue,
      lastSaleAt: sales[0]?.createdAt || "",
      recentSales: sales.slice(0, 4)
    };
  }, [customerDetailName, customerRows, state.sales]);

  const stockRows = useMemo(() => {
    return [...state.products].sort((a, b) => a.stock - b.stock);
  }, [state.products]);
  const filteredStockRows = useMemo(() => {
    const term = stockPanelSearch.trim().toLowerCase();
    if (!term) return stockRows;
    return stockRows.filter((row) =>
      String(row.name || "").toLowerCase().includes(term)
      || String(row.sku || "").toLowerCase().includes(term)
      || String(row.size || "").toLowerCase().includes(term)
    );
  }, [stockRows, stockPanelSearch]);
  const sortedStockRows = useMemo(
    () => sortRows(filteredStockRows, "stock", "name", {
      name: (row) => row.name,
      size: (row) => row.size || "",
      sku: (row) => row.sku,
      billingPrice: (row) => Number(row.billingPrice ?? row.price ?? 0),
      mrp: (row) => Number(row.mrp ?? row.price ?? 0),
      stock: (row) => Number(row.stock || 0)
    }),
    [filteredStockRows, tableSort]
  );

  const adminReturnRows = useMemo(() => {
    const rows = [];
    for (const ret of (state.returns || [])) {
      for (const line of (ret.lines || [])) {
        rows.push({
          id: `${ret.id}-${line.productId}-${line.condition}`,
          saleId: ret.saleId,
          item: line.name || line.productId,
          qty: Number(line.quantity || 0),
          rep: ret.rep || "-",
          reason: line.condition === "good" ? "Good" : "Expired / Damaged",
          at: ret.createdAt
        });
      }
    }
    return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [state.returns]);

  const stockSearchMatches = useMemo(() => {
    const term = stockSearch.trim().toLowerCase();
    if (!term) return state.products.slice(0, 8);
    return state.products
      .filter((item) => item.name.toLowerCase().includes(term) || item.sku.toLowerCase().includes(term))
      .slice(0, 8);
  }, [stockSearch, state.products]);

  const staffRows = useMemo(() => {
    const map = new Map();
    for (const sale of state.sales) {
      const key = sale.cashier || "Unknown";
      const existing = map.get(key) || { name: key, orders: 0, revenue: 0, role: "", phone: "" };
      existing.orders += 1;
      existing.revenue += Number(sale.total || 0);
      map.set(key, existing);
    }
    for (const member of (state.staff || [])) {
      const existing = map.get(member.name) || { name: member.name, orders: 0, revenue: 0 };
      map.set(member.name, { ...existing, ...member });
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [state.sales, state.staff]);
  const sortedStaffRows = useMemo(
    () => sortRows(staffRows, "staff", "name", {
      name: (row) => row.name,
      role: (row) => row.role || "",
      orders: (row) => Number(row.orders || 0),
      revenue: (row) => Number(row.revenue || 0)
    }),
    [staffRows, tableSort]
  );
  const staffPageSummary = useMemo(() => {
    const rows = sortedStaffRows || [];
    const totalStaff = rows.length;
    const activeStaff = rows.filter((row) => Number(row.orders || 0) > 0).length;
    const totalOrders = rows.reduce((acc, row) => acc + Number(row.orders || 0), 0);
    const totalRevenue = Number(rows.reduce((acc, row) => acc + Number(row.revenue || 0), 0).toFixed(2));
    const avgRevenuePerStaff = totalStaff ? Number((totalRevenue / totalStaff).toFixed(2)) : 0;
    const topPerformer = rows.reduce(
      (best, row) => (Number(row.revenue || 0) > Number(best?.revenue || -1) ? row : best),
      null
    );
    return {
      totalStaff,
      activeStaff,
      totalOrders,
      totalRevenue,
      avgRevenuePerStaff,
      topPerformerName: topPerformer?.name || "-",
      topPerformerOrders: Number(topPerformer?.orders || 0),
      topPerformerRevenue: Number(topPerformer?.revenue || 0)
    };
  }, [sortedStaffRows]);

  const sortedItemWiseRows = useMemo(
    () => sortRows(itemWiseRows, "itemWise", "name", {
      name: (row) => row.name,
      sku: (row) => row.sku,
      qty: (row) => Number(row.qty || 0),
      bundles: (row) => {
        const { bundles } = getBundleBreakdown(row);
        return bundles;
      },
      singles: (row) => {
        const { singles } = getBundleBreakdown(row);
        return singles;
      }
    }),
    [itemWiseRows, tableSort]
  );

  const sortedSalesWiseRows = useMemo(
    () => sortRows(salesWiseRows, "salesWise", "when", {
      id: (row) => Number(row.id || 0),
      when: (row) => Number(row.whenTs || 0),
      lorry: (row) => String(row.lorry || ""),
      total: (row) => Number(row.total || 0)
    }),
    [salesWiseRows, tableSort]
  );

  const filteredCustomerWiseRows = useMemo(() => {
    const term = customerReportSearch.trim().toLowerCase();
    if (!term) return customerWiseRows;
    return customerWiseRows.filter((row) => String(row.name || "").toLowerCase().includes(term));
  }, [customerWiseRows, customerReportSearch]);
  const sortedCustomerWiseRows = useMemo(
    () => sortRows(filteredCustomerWiseRows, "customerWise", "spent", {
      name: (row) => row.name,
      orders: (row) => Number(row.orders || 0),
      spent: (row) => Number(row.spent || 0),
      lastAt: (row) => (row.lastAt ? new Date(row.lastAt).getTime() : 0)
    }),
    [filteredCustomerWiseRows, tableSort]
  );

  const sortedLoadingA = useMemo(
    () => sortRows(loadingRowsByLorry["Lorry A"], "loadingA", "orderedQty", {
      name: (row) => row.name,
      orderedQty: (row) => Number(row.orderedQty || 0),
      orderedValue: (row) => Number(row.orderedValue || 0),
      deliveredQty: (row) => Number(row.deliveredQty || 0),
      deliveredValue: (row) => Number(row.deliveredValue || 0),
      bundles: (row) => Number(row.bundles || 0),
      singles: (row) => Number(row.balance || 0)
    }),
    [loadingRowsByLorry, tableSort]
  );

  const sortedLoadingB = useMemo(
    () => sortRows(loadingRowsByLorry["Lorry B"], "loadingB", "orderedQty", {
      name: (row) => row.name,
      orderedQty: (row) => Number(row.orderedQty || 0),
      orderedValue: (row) => Number(row.orderedValue || 0),
      deliveredQty: (row) => Number(row.deliveredQty || 0),
      deliveredValue: (row) => Number(row.deliveredValue || 0),
      bundles: (row) => Number(row.bundles || 0),
      singles: (row) => Number(row.balance || 0)
    }),
    [loadingRowsByLorry, tableSort]
  );

  const salesRangeTotal = useMemo(
    () => Number(sortedSalesWiseRows.reduce((acc, row) => acc + Number(row.total || 0), 0).toFixed(2)),
    [sortedSalesWiseRows]
  );

  const loadingSummaryA = useMemo(() => {
    const rows = loadingRowsByLorry["Lorry A"] || [];
    return {
      orderedQty: rows.reduce((acc, row) => acc + Number(row.orderedQty || 0), 0),
      orderedValue: rows.reduce((acc, row) => acc + Number(row.orderedValue || 0), 0),
      deliveredQty: rows.reduce((acc, row) => acc + Number(row.deliveredQty || 0), 0),
      deliveredValue: rows.reduce((acc, row) => acc + Number(row.deliveredValue || 0), 0)
    };
  }, [loadingRowsByLorry]);

  const loadingSummaryB = useMemo(() => {
    const rows = loadingRowsByLorry["Lorry B"] || [];
    return {
      orderedQty: rows.reduce((acc, row) => acc + Number(row.orderedQty || 0), 0),
      orderedValue: rows.reduce((acc, row) => acc + Number(row.orderedValue || 0), 0),
      deliveredQty: rows.reduce((acc, row) => acc + Number(row.deliveredQty || 0), 0),
      deliveredValue: rows.reduce((acc, row) => acc + Number(row.deliveredValue || 0), 0)
    };
  }, [loadingRowsByLorry]);

  const deliveryRows = useMemo(() => {
    const rows = (state.sales || [])
      .filter((sale) => inDateRange(sale.createdAt, deliveryDateFrom, deliveryDateTo))
      .filter((sale) => (deliveryLorry === "all" ? true : sale.lorry === deliveryLorry))
      .map((sale) => {
        const undeliveredQty = (sale.deliveryAdjustments || []).reduce(
          (acc, adj) => acc + (adj.lines || []).reduce((lineAcc, line) => lineAcc + Number(line.quantity || 0), 0),
          0
        );
        const soldQty = (sale.lines || []).reduce((acc, line) => acc + Number(line.quantity || 0), 0);
        return {
          sale,
          id: sale.id,
          when: new Date(sale.createdAt).toLocaleString(),
          rep: sale.cashier || "-",
          lorry: sale.lorry || "-",
          total: Number(sale.total || 0),
          soldQty,
          undeliveredQty,
          confirmed: Boolean(sale.deliveryConfirmedAt)
        };
      });
    return rows.sort((a, b) => new Date(b.sale.createdAt).getTime() - new Date(a.sale.createdAt).getTime());
  }, [state.sales, deliveryDateFrom, deliveryDateTo, deliveryLorry]);

  const deliveryReportSales = useMemo(
    () => (state.sales || [])
      .filter((sale) => inDateRange(sale.createdAt, deliveryReportDateFrom, deliveryReportDateTo))
      .filter((sale) => (deliveryLorry === "all" ? true : sale.lorry === deliveryLorry)),
    [state.sales, deliveryReportDateFrom, deliveryReportDateTo, deliveryLorry]
  );

  const deliveredItemRows = useMemo(() => {
    const sales = deliveryReportSales.filter((sale) => Boolean(sale.deliveryConfirmedAt));
    const map = new Map();
    for (const sale of sales) {
      const undeliveredByProduct = new Map();
      for (const adj of (sale.deliveryAdjustments || [])) {
        for (const line of (adj.lines || [])) {
          undeliveredByProduct.set(line.productId, (undeliveredByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
        }
      }
      for (const line of (sale.lines || [])) {
        const soldQty = Number(line.quantity || 0);
        const undeliveredQty = Number(undeliveredByProduct.get(line.productId) || 0);
        const deliveredQty = Math.max(0, soldQty - undeliveredQty);
        if (deliveredQty <= 0) continue;
        const unitPrice = Number(line.price || 0);
        const key = line.productId || line.name;
        const current = map.get(key) || {
          key,
          item: line.name || productInfoById.get(line.productId)?.name || "Unknown",
          sku: productInfoById.get(line.productId)?.sku || "-",
          qty: 0,
          value: 0
        };
        current.qty += deliveredQty;
        current.value += deliveredQty * unitPrice;
        map.set(key, current);
      }
    }
    return [...map.values()].sort((a, b) => b.qty - a.qty);
  }, [deliveryReportSales, productInfoById]);

  const deliveredTotals = useMemo(() => ({
    qty: deliveredItemRows.reduce((acc, row) => acc + Number(row.qty || 0), 0),
    value: Number(deliveredItemRows.reduce((acc, row) => acc + Number(row.value || 0), 0).toFixed(2))
  }), [deliveredItemRows]);

  const soldTotals = useMemo(() => ({
    qty: deliveryReportSales.reduce(
      (acc, sale) => acc + (sale.lines || []).reduce((lineAcc, line) => lineAcc + Number(line.quantity || 0), 0),
      0
    ),
    value: Number(deliveryReportSales.reduce((acc, sale) => acc + Number(sale.total || 0), 0).toFixed(2))
  }), [deliveryReportSales]);

  const reportDeliverySales = useMemo(
    () => (state.sales || [])
      .filter((sale) => inDateRange(sale.createdAt, reportDeliveryDateFrom, reportDeliveryDateTo))
      .filter((sale) => (reportDeliveryLorry === "all" ? true : sale.lorry === reportDeliveryLorry)),
    [state.sales, reportDeliveryDateFrom, reportDeliveryDateTo, reportDeliveryLorry]
  );

  const reportDeliveryRows = useMemo(() => {
    const rows = reportDeliverySales.map((sale) => {
      const soldQty = (sale.lines || []).reduce((acc, line) => acc + Number(line.quantity || 0), 0);
      const undeliveredByProduct = new Map();
      for (const adj of (sale.deliveryAdjustments || [])) {
        for (const line of (adj.lines || [])) {
          undeliveredByProduct.set(line.productId, (undeliveredByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
        }
      }
      let undeliveredQty = 0;
      let deliveredQty = 0;
      let deliveredValue = 0;
      for (const line of (sale.lines || [])) {
        const sold = Number(line.quantity || 0);
        const undelivered = Math.max(0, Number(undeliveredByProduct.get(line.productId) || 0));
        const delivered = Math.max(0, sold - undelivered);
        undeliveredQty += undelivered;
        deliveredQty += delivered;
        deliveredValue += delivered * Number(line.price || 0);
      }
      return {
        id: sale.id,
        date: sale.createdAt ? new Date(sale.createdAt).toLocaleDateString() : "-",
        rep: sale.cashier || "-",
        lorry: sale.lorry || "-",
        status: sale.deliveryConfirmedAt ? "Confirmed" : "Pending",
        soldQty,
        undeliveredQty,
        deliveredQty,
        deliveredValue: Number(deliveredValue.toFixed(2))
      };
    });
    return rows.sort((a, b) => Number(b.id) - Number(a.id));
  }, [reportDeliverySales]);

  const reportDeliverySummary = useMemo(() => {
    const totalBills = reportDeliveryRows.length;
    const confirmedBills = reportDeliveryRows.filter((row) => row.status === "Confirmed").length;
    const pendingBills = totalBills - confirmedBills;
    const soldQtyTotal = reportDeliveryRows.reduce((acc, row) => acc + Number(row.soldQty || 0), 0);
    const undeliveredQtyTotal = reportDeliveryRows.reduce((acc, row) => acc + Number(row.undeliveredQty || 0), 0);
    const deliveredQtyTotal = reportDeliveryRows.reduce((acc, row) => acc + Number(row.deliveredQty || 0), 0);
    const deliveredValueTotal = Number(reportDeliveryRows.reduce((acc, row) => acc + Number(row.deliveredValue || 0), 0).toFixed(2));
    const deliveryRate = soldQtyTotal > 0 ? Number(((deliveredQtyTotal / soldQtyTotal) * 100).toFixed(1)) : 0;
    return {
      totalBills,
      confirmedBills,
      pendingBills,
      soldQtyTotal,
      undeliveredQtyTotal,
      deliveredQtyTotal,
      deliveredValueTotal,
      deliveryRate
    };
  }, [reportDeliveryRows]);

  const viewedSale = useMemo(
    () => (state.sales || []).find((sale) => String(sale.id) === String(viewSaleId)) || null,
    [state.sales, viewSaleId]
  );

  const deliverySale = useMemo(
    () => (state.sales || []).find((sale) => String(sale.id) === String(deliverySaleId)) || null,
    [state.sales, deliverySaleId]
  );

  const openAdminSaleEdit = (sale) => {
    setEditingAdminSaleId(sale.id);
    setAdminSaleEditLines((sale.lines || []).map((line) => ({
      productId: line.productId,
      name: line.name,
      quantity: Number(line.quantity || 0)
    })));
    setAdminSaleEditError("");
  };

  const saveAdminSaleEdit = async () => {
    try {
      const lines = adminSaleEditLines
        .map((line) => ({ ...line, quantity: Number(line.quantity || 0) }))
        .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
      if (!editingAdminSaleId || !lines.length) {
        setAdminSaleEditError("Keep at least one item in bill.");
        return;
      }
      setSavingAdminSaleEdit(true);
      setAdminSaleEditError("");
      await patchSale(editingAdminSaleId, { lines });
      setEditingAdminSaleId("");
      setAdminSaleEditLines([]);
      setNotice("Sale updated.");
    } catch (error) {
      setAdminSaleEditError(error.message);
    } finally {
      setSavingAdminSaleEdit(false);
    }
  };

  const deleteAdminSale = async (sale) => {
    try {
      const ok = window.confirm(`Delete sale #${sale.id}? This will restore stock and remove linked returns.`);
      if (!ok) return;
      setDeletingSaleId(String(sale.id));
      await deleteSale(sale.id);
      setNotice(`Sale #${sale.id} deleted.`);
      if (editingAdminSaleId && String(editingAdminSaleId) === String(sale.id)) {
        setEditingAdminSaleId("");
        setAdminSaleEditLines([]);
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setDeletingSaleId("");
    }
  };

  const printAdminSaleReceipt = (sale) => {
    openSaleReceiptPrint({
      sale,
      customers: state.customers || [],
      products: state.products || [],
      onPopupBlocked: () => setNotice("Allow popups to print receipt.")
    });
  };

  const openDeliveryModal = (sale) => {
    setDeliverySaleId(String(sale.id));
    setDeliveryDraft({});
    setDeliveryError("");
  };

  const onDeliveryDraftChange = (productId, value) => {
    setDeliveryDraft((current) => ({ ...current, [productId]: value }));
  };

  const saveDeliveryAdjust = async () => {
    try {
      if (!deliverySale) {
        setDeliveryError("Sale not found.");
        return;
      }
      const lines = (deliverySale.lines || [])
        .map((line) => ({
          productId: line.productId,
          quantity: Number(deliveryDraft[line.productId] || 0)
        }))
        .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
      setSavingDelivery(true);
      setDeliveryError("");
      await submitDeliveryAdjustment(deliverySale.id, { lines, markConfirmed: true });
      setDeliverySaleId("");
      setDeliveryDraft({});
      setNotice(`Delivery confirmed for sale #${deliverySale.id}.`);
    } catch (error) {
      setDeliveryError(error.message);
    } finally {
      setSavingDelivery(false);
    }
  };

  const openCustomerAdd = () => {
    setCustomerForm({ id: "", name: "", phone: "", address: "" });
    setShowCustomerForm(true);
  };

  const openCustomerEdit = () => {
    const first = (state.customers || [])[0];
    if (!first) {
      setNotice("No customer to edit.");
      return;
    }
    setCustomerForm({ id: first.id, name: first.name, phone: first.phone || "", address: first.address || "" });
    setShowCustomerForm(true);
  };

  const openCustomerEditByRow = (row) => {
    if (!row) return;
    const matched = (state.customers || []).find((item) => String(item.name || "").trim().toLowerCase() === String(row.name || "").trim().toLowerCase());
    if (!matched) {
      setNotice("Selected customer was not found in saved list.");
      return;
    }
    setCustomerForm({
      id: matched.id,
      name: matched.name || row.name || "",
      phone: matched.phone || row.phone || "",
      address: matched.address || row.address || ""
    });
    setShowCustomerForm(true);
  };

  const saveCustomer = () => {
    if (!customerForm.name.trim()) {
      setNotice("Customer name is required.");
      return;
    }
    const payload = { name: customerForm.name.trim(), phone: customerForm.phone, address: customerForm.address };
    const action = customerForm.id ? updateCustomer(customerForm.id, payload) : createCustomer(payload);
    action
      .then(() => {
        setShowCustomerForm(false);
        setNotice("Customer saved.");
      })
      .catch((error) => setNotice(error.message));
  };

  const openStaffAdd = () => {
    setStaffForm({ id: "", name: "", role: "", phone: "" });
    setShowStaffForm(true);
  };

  const openStaffEditByRow = (row) => {
    if (!row) return;
    const matched = (state.staff || []).find(
      (item) => String(item.name || "").trim().toLowerCase() === String(row.name || "").trim().toLowerCase()
    );
    if (!matched) {
      setNotice("Selected staff was not found in saved staff list.");
      return;
    }
    setStaffForm({
      id: matched.id,
      name: matched.name || row.name || "",
      role: matched.role || row.role || "",
      phone: matched.phone || row.phone || ""
    });
    setShowStaffForm(true);
  };

  const saveStaff = () => {
    if (!staffForm.name.trim()) {
      setNotice("Staff name is required.");
      return;
    }
    const payload = { name: staffForm.name.trim(), role: staffForm.role, phone: staffForm.phone };
    const action = staffForm.id ? updateStaff(staffForm.id, payload) : createStaff(payload);
    action
      .then(() => {
        setShowStaffForm(false);
        setNotice("Staff saved.");
      })
      .catch((error) => setNotice(error.message));
  };

  const openStockAdd = () => {
    setStockMode("add");
    setStockForm({ productId: "", quantity: "", stock: "", sku: "" });
    setStockSearch("");
    setShowStockSuggestions(false);
    setNewStockItemForm({ sku: "", category: "General", billingPrice: "", mrp: "" });
    setShowStockForm(true);
  };

  const openStockEdit = () => {
    setStockMode("edit");
    setStockForm({
      productId: state.products[0]?.id || "",
      quantity: "",
      stock: state.products[0]?.stock || "",
      sku: state.products[0]?.sku || ""
    });
    setShowStockForm(true);
  };

  const onStockProductChange = (productId) => {
    const selected = state.products.find((item) => item.id === productId);
    setStockForm((current) => ({
      ...current,
      productId,
      sku: selected?.sku || "",
      stock: stockMode === "edit" ? String(selected?.stock ?? "") : current.stock
    }));
  };

  const onStockSearchChange = (value) => {
    setStockSearch(value);
    setShowStockSuggestions(true);
    setStockForm((current) => ({ ...current, productId: "", sku: "" }));
  };

  const onSelectExistingStockItem = (product) => {
    setStockSearch(product.name);
    setStockForm((current) => ({
      ...current,
      productId: product.id,
      sku: product.sku
    }));
    setNewStockItemForm((current) => ({
      ...current,
      billingPrice: String(product.billingPrice ?? ""),
      mrp: String(product.mrp ?? product.price ?? "")
    }));
    setShowStockSuggestions(false);
  };

  const saveStock = async () => {
    try {
      const selected = state.products.find((item) => item.id === stockForm.productId);
      if (stockMode === "add") {
        const qty = Number(stockForm.quantity || 0);
        const billingPrice = Number(newStockItemForm.billingPrice);
        const mrp = Number(newStockItemForm.mrp);
        if (Number.isNaN(qty) || qty <= 0) {
          setNotice("Enter a valid quantity.");
          return;
        }
        if (Number.isNaN(billingPrice) || billingPrice < 0 || Number.isNaN(mrp) || mrp <= 0) {
          setNotice("Billing Price and MRP are required.");
          return;
        }

        if (selected) {
          await patchProduct(selected.id, {
            stock: Number(selected.stock) + qty,
            billingPrice,
            mrp,
            price: mrp
          });
          setNotice(`Stock added to ${selected.name}.`);
        } else {
          const name = stockSearch.trim();
          if (!name) {
            setNotice("Type item name.");
            return;
          }
          const generatedSkuBase = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "ITEM";
          const generatedSku = `${generatedSkuBase}${Math.floor(100 + Math.random() * 900)}`;
          await createProduct({
            name,
            sku: newStockItemForm.sku.trim() || generatedSku,
            category: newStockItemForm.category.trim() || "General",
            billingPrice,
            mrp,
            price: mrp,
            stock: qty
          });
          setNotice(`New item created: ${name}.`);
        }
      } else {
        if (!selected) {
          setNotice("Select a valid product.");
          return;
        }
        await patchProduct(selected.id, {
          stock: Number(stockForm.stock || selected.stock),
          sku: String(stockForm.sku || selected.sku).trim()
        });
        setNotice("Stock updated.");
      }
      setShowStockForm(false);
    } catch (error) {
      setNotice(error.message);
    }
  };

  const deleteStockProductById = async (product) => {
    try {
      if (!product?.id) return;
      const ok = window.confirm(`Delete product ${product.name} (${product.sku})? This cannot be undone.`);
      if (!ok) return;
      setDeletingProduct(true);
      await deleteProduct(product.id);
      setNotice(`Product deleted: ${product.name}.`);
      if (stockForm.productId === product.id) {
        setShowStockForm(false);
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setDeletingProduct(false);
    }
  };

  const importStock = async (rawText) => {
    try {
      const lines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (!lines.length) {
        setNotice("Paste stock rows first.");
        return;
      }

      const productBySku = new Map(state.products.map((p) => [p.sku.toLowerCase(), p]));
      const updates = [];
      const creates = [];
      const unknown = [];

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const cells = line.split(",").map((v) => (v || "").trim());
        if (!cells.length) continue;

        const first = cells[0].toLowerCase();
        if (i === 0 && (first === "sku" || first === "name")) {
          continue;
        }

        if (cells.length <= 2) {
          const [skuRaw, stockRaw] = cells;
          if (!skuRaw || stockRaw === "") continue;
          const product = productBySku.get(skuRaw.toLowerCase());
          if (!product) {
            unknown.push(skuRaw);
            continue;
          }
          const stock = Number(stockRaw);
          if (Number.isNaN(stock)) continue;
          updates.push({ productId: product.id, stock });
          continue;
        }

        const hasSizeColumn = cells.length >= 7;
        const name = cells[0];
        const size = hasSizeColumn ? (cells[1] || "") : "";
        const skuRaw = hasSizeColumn ? cells[2] : cells[1];
        const category = hasSizeColumn ? (cells[3] || "General") : (cells[2] || "General");
        const rawA = hasSizeColumn ? cells[4] : cells[3];
        const rawB = hasSizeColumn ? cells[5] : cells[4];
        const rawC = hasSizeColumn ? cells[6] : cells[5];
        if (!name || !skuRaw || rawA === undefined || rawB === undefined) continue;

        const hasBillingAndMrp = rawC !== undefined;
        const billingPrice = Number(rawA);
        const mrp = Number(hasBillingAndMrp ? rawB : rawA);
        const stockRaw = hasBillingAndMrp ? rawC : rawB;
        const stock = Number(stockRaw);
        if (Number.isNaN(billingPrice) || Number.isNaN(mrp) || Number.isNaN(stock)) continue;

        const existing = productBySku.get(skuRaw.toLowerCase());
        if (existing) {
          updates.push({ productId: existing.id, stock, billingPrice, mrp, size });
        } else {
          creates.push({ name, size, sku: skuRaw, category, billingPrice, mrp, price: mrp, stock });
        }
      }

      if (!updates.length && !creates.length) {
        setNotice("No valid stock rows found. Use: sku,stock OR name,sku,category,price,stock OR name,sku,category,billingPrice,mrp,stock OR name,size,sku,category,billingPrice,mrp,stock");
        return;
      }

      await Promise.all(
        updates.map((u) =>
          patchProduct(u.productId, { stock: u.stock, billingPrice: u.billingPrice, mrp: u.mrp, price: u.mrp, size: u.size })
        )
      );
      await Promise.all(creates.map((row) => createProduct(row)));
      setNotice(
        unknown.length
          ? `Imported ${updates.length} updates, created ${creates.length}. Unknown SKU: ${unknown.join(", ")}`
          : `Imported ${updates.length} updates, created ${creates.length} products.`
      );
    } catch (error) {
      setNotice(error.message);
    }
  };

  const onImportFileSelected = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await importStock(text);
    event.target.value = "";
  };

  const navItems = [
    { id: "dashboard", label: "Dashboard" },
    { id: "customers", label: "Customers" },
    { id: "stock", label: "Stock" },
    { id: "staff", label: "Staff" },
    { id: "deliveries", label: "Deliveries" },
    { id: "reports", label: "Reports" },
    { id: "loadings", label: "Loadings" }
  ];

  return (
    <>
      {message && !/(error|invalid|required|cannot|unable|failed|not found|select|enter|type|exceeds)/i.test(String(message)) ? <p className="notice">{message}</p> : null}
      {notice && !/(error|invalid|required|cannot|unable|failed|not found|select|enter|type|exceeds)/i.test(String(notice)) ? <p className="notice">{notice}</p> : null}
      <main className="admin-shell">
        <button
          type="button"
          className={`admin-mobile-nav-toggle menu-toggle-btn ${mobileNavOpen ? "open" : ""}`}
          onClick={() => setMobileNavOpen((current) => !current)}
          aria-expanded={mobileNavOpen}
          aria-controls="admin-sidebar-nav"
          aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
        >
          <span className="menu-toggle-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="menu-toggle-label">{mobileNavOpen ? "Close" : "Menu"}</span>
        </button>

        {mobileNavOpen ? (
          <button
            type="button"
            className="admin-mobile-nav-backdrop"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close menu"
          />
        ) : null}

        <aside id="admin-sidebar-nav" className={`admin-sidebar ${mobileNavOpen ? "open" : ""}`}>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activePage === item.id ? "active" : ""}
              onClick={() => setActivePage(item.id)}
            >
              {item.label}
            </button>
          ))}
          <div className="side-menu-footer">
            <a href="https://www.jnco.tech" target="_blank" rel="noreferrer">
              <img src="/powered.png" alt="Powered by" />
            </a>
          </div>
        </aside>

        <section className="admin-content">
          {activePage === "customers" ? (
            <section className="admin-mobile-section admin-customers-panel">
              <div className="customers-head">
                <h2>Customers</h2>
                <button type="button" className="customer-add-icon-btn" onClick={openCustomerAdd} title="Add Customer" aria-label="Add Customer">
                  <span className="fab-plus">+</span>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 20c0-4.5 3.6-8 8-8s8 3.5 8 8" />
                  </svg>
                </button>
              </div>
              <input
                className="customers-search search-icon-input"
                value={customerPanelSearch}
                onChange={(e) => setCustomerPanelSearch(e.target.value)}
                placeholder="Search Customer"
              />
              <div className="admin-table customer-table customers-table">
                <div className="customers-table-divider">
                  <span>CUSTOMERS TABLE</span>
                </div>
                <header>
                  <button type="button" className="th-sort" onClick={() => toggleSort("customers", "name")}>Name{sortMark("customers", "name")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("customers", "phone")}>Phone{sortMark("customers", "phone")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customers", "orders")}>Orders{sortMark("customers", "orders")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customers", "spent")}>Total Spent (LKR){sortMark("customers", "spent")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customers", "outstanding")}>Outstanding (LKR){sortMark("customers", "outstanding")}</button>
                  </header>
                {sortedCustomerRows.length ? sortedCustomerRows.map((row) => (
                  <article
                    key={row.name}
                    className="customers-clickable-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setCustomerDetailName(row.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setCustomerDetailName(row.name);
                      }
                    }}
                  >
                    <span>{row.name}</span>
                    <span>{row.phone || "-"}</span>
                    <span>{row.orders}</span>
                    <span>{Number(row.spent || 0).toFixed(2)}</span>
                    <span className={Number(row.outstanding || 0) > 0 ? "outstanding-text" : ""}>{Number(row.outstanding || 0).toFixed(2)}</span>
                  </article>
                )) : <p>No customer records yet.</p>}
              </div>
              <section className="customers-summary-card">
                <div className="customers-summary-divider">
                  <span>SUMMARY</span>
                </div>
                <div className="customers-summary-head">
                  <h3>Customer Summary</h3>
                  <p>Based on current list</p>
                </div>
                <div className="customers-summary-grid">
                  <article>
                    <span>Total Customers</span>
                    <strong>{customerPageSummary.totalCustomers}</strong>
                  </article>
                  <article>
                    <span>Active Customers</span>
                    <strong>{customerPageSummary.activeCustomers}</strong>
                  </article>
                  <article>
                    <span>Customers with Outstanding</span>
                    <strong>{customerPageSummary.customersWithOutstanding}</strong>
                  </article>
                  <article>
                    <span>Total Orders</span>
                    <strong>{customerPageSummary.totalOrders}</strong>
                  </article>
                  <article>
                    <span>Total Spent (LKR)</span>
                    <strong>{Number(customerPageSummary.totalSpent || 0).toFixed(2)}</strong>
                  </article>
                  <article className="warn">
                    <span>Total Outstanding (LKR)</span>
                    <strong>{Number(customerPageSummary.totalOutstanding || 0).toFixed(2)}</strong>
                  </article>
                </div>
                <div className="customers-summary-foot">
                  <article>
                    <span>Top Customer</span>
                    <strong>{customerPageSummary.topCustomerName}</strong>
                    <p>LKR {Number(customerPageSummary.topCustomerSpent || 0).toFixed(2)}</p>
                  </article>
                  <article>
                    <span>Average Order Value</span>
                    <strong>LKR {Number(customerPageSummary.averageOrderValue || 0).toFixed(2)}</strong>
                  </article>
                </div>
              </section>
            </section>
          ) : null}

          {activePage === "stock" ? (
            <section className="admin-mobile-section admin-stock-panel">
              <h2>Stock</h2>
              {showStockForm ? (
                <div className="admin-inline-form stock-form-panel">
                  {stockMode === "add" ? (
                    <>
                      <input
                        value={stockSearch}
                        onChange={(e) => onStockSearchChange(e.target.value)}
                        onFocus={() => setShowStockSuggestions(true)}
                        placeholder="Type item name"
                      />
                      {showStockSuggestions && stockSearchMatches.length ? (
                        <div className="stock-suggestions">
                          {stockSearchMatches.map((product) => (
                            <button key={product.id} type="button" onClick={() => onSelectExistingStockItem(product)}>
                              {product.name} ({product.sku})
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {stockForm.productId ? (
                        <p className="form-hint">Existing item selected. Quantity will be added to current stock.</p>
                      ) : (
                        <>
                          <p className="form-hint">No match selected. A new item will be created.</p>
                          <input value={newStockItemForm.sku} onChange={(e) => setNewStockItemForm((c) => ({ ...c, sku: e.target.value }))} placeholder="SKU (optional)" />
                          <input value={newStockItemForm.category} onChange={(e) => setNewStockItemForm((c) => ({ ...c, category: e.target.value }))} placeholder="Category (optional)" />
                        </>
                      )}
                      <input
                        type="number"
                        step="0.01"
                        value={newStockItemForm.billingPrice}
                        onChange={(e) => setNewStockItemForm((c) => ({ ...c, billingPrice: e.target.value }))}
                        placeholder="Billing Price (required)"
                      />
                      <input
                        type="number"
                        step="0.01"
                        value={newStockItemForm.mrp}
                        onChange={(e) => setNewStockItemForm((c) => ({ ...c, mrp: e.target.value }))}
                        placeholder="MRP (required)"
                      />
                      <input type="number" value={stockForm.quantity} onChange={(e) => setStockForm((c) => ({ ...c, quantity: e.target.value }))} placeholder="Quantity" />
                    </>
                  ) : (
                    <>
                      <select value={stockForm.productId} onChange={(e) => onStockProductChange(e.target.value)}>
                        {state.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                      </select>
                      <input value={stockForm.sku || ""} onChange={(e) => setStockForm((c) => ({ ...c, sku: e.target.value }))} placeholder="Edit SKU" />
                      <input type="number" value={stockForm.stock} onChange={(e) => setStockForm((c) => ({ ...c, stock: e.target.value }))} placeholder="Set stock" />
                    </>
                  )}
                  <div>
                    <button type="button" onClick={saveStock}>Save</button>
                    <button type="button" className="ghost" onClick={() => setShowStockForm(false)}>Cancel</button>
                  </div>
                </div>
              ) : null}
              <div className="stock-current-head">
                <h3>Current Stock</h3>
                <div className="admin-page-actions stock-current-actions stock-actions-tech">
                  <button type="button" onClick={openStockAdd}>Add Stock</button>
                  <button type="button" onClick={openStockEdit}>Edit Stock</button>
                  <button type="button" onClick={() => stockFileRef.current?.click()}>Import Stock</button>
                  <input
                    ref={stockFileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden-file-input"
                    onChange={onImportFileSelected}
                  />
                </div>
              </div>
              <input
                className="admin-search-input stock-search-input search-icon-input"
                value={stockPanelSearch}
                onChange={(e) => setStockPanelSearch(e.target.value)}
                placeholder="Search product / SKU / size"
              />
              <div className="admin-table stock-table stock-table-tech">
                <header>
                  <button type="button" className="th-sort" onClick={() => toggleSort("stock", "sku")}>SKU{sortMark("stock", "sku")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("stock", "billingPrice")}>Billing Price (LKR){sortMark("stock", "billingPrice")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("stock", "mrp")}>MRP (LKR){sortMark("stock", "mrp")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("stock", "stock")}>Stock{sortMark("stock", "stock")}</button>
                  <span className="th-action">Action</span>
                </header>
                {sortedStockRows.map((item) => (
                  <article key={item.id}>
                    <span>{item.sku}</span>
                    <span>{Number(item.billingPrice ?? item.price ?? 0).toFixed(2)}</span>
                    <span>{Number(item.mrp ?? item.price ?? 0).toFixed(2)}</span>
                    <span className={item.stock <= 25 ? "low" : ""}>{item.stock}</span>
                    <span className="action-cell">
                      <button type="button" className="row-danger" onClick={() => deleteStockProductById(item)} disabled={deletingProduct}>
                        Delete
                      </button>
                    </span>
                  </article>
                ))}
              </div>
              <div className="returned-stock-panel returned-stock-tech">
                <h3>Returned Stock</h3>
                <div className="admin-table returns-table">
                  <header>
                    <span>Sale ID</span>
                    <span>Item</span>
                    <span>Qty</span>
                    <span>Rep</span>
                    <span>Reason</span>
                  </header>
                  {adminReturnRows.length ? adminReturnRows.map((row) => (
                    <article key={row.id}>
                      <span>#{row.saleId}</span>
                      <span>{row.item}</span>
                      <span>{row.qty}</span>
                      <span>{row.rep}</span>
                      <span>{row.reason}</span>
                    </article>
                  )) : <p className="form-hint">No returned stock records yet.</p>}
                </div>
              </div>
            </section>
          ) : null}

          {activePage === "staff" ? (
            <section className="admin-mobile-section">
              <div className="staff-head">
                <h2>Staff</h2>
                <div className="staff-head-actions">
                  <button type="button" onClick={openStaffAdd}>Add Staff</button>
                </div>
              </div>
              {showStaffForm ? (
                <div className="admin-inline-form">
                  <input value={staffForm.name} onChange={(e) => setStaffForm((c) => ({ ...c, name: e.target.value }))} placeholder="Staff name" />
                  <input value={staffForm.role} onChange={(e) => setStaffForm((c) => ({ ...c, role: e.target.value }))} placeholder="Role" />
                  <input value={staffForm.phone} onChange={(e) => setStaffForm((c) => ({ ...c, phone: e.target.value }))} placeholder="Phone" />
                  <div>
                    <button type="button" onClick={saveStaff}>Save</button>
                    <button type="button" className="ghost" onClick={() => setShowStaffForm(false)}>Cancel</button>
                  </div>
                </div>
              ) : null}
              <div className="admin-table">
                <header>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "name")}>Staff{sortMark("staff", "name")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "role")}>Role{sortMark("staff", "role")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "orders")}>Orders{sortMark("staff", "orders")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "revenue")}>Revenue{sortMark("staff", "revenue")}</button>
                </header>
                {sortedStaffRows.length ? sortedStaffRows.map((row) => (
                  <article
                    key={row.name}
                    className="staff-clickable-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => openStaffEditByRow(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openStaffEditByRow(row);
                      }
                    }}
                  >
                    <span>{row.name}</span>
                    <span>{row.role || "-"}</span>
                    <span>{row.orders}</span>
                    <span>{currency(row.revenue)}</span>
                  </article>
                )) : <p>No staff sales records yet.</p>}
              </div>
              <div className="staff-summary-divider">
                <span>STAFF SUMMARY</span>
              </div>
              <section className="staff-summary-card">
                <div className="staff-summary-top">
                  <article>
                    <span>Total Staff</span>
                    <strong>{staffPageSummary.totalStaff}</strong>
                  </article>
                  <article>
                    <span>Active Staff</span>
                    <strong>{staffPageSummary.activeStaff}</strong>
                  </article>
                  <article>
                    <span>Total Orders</span>
                    <strong>{staffPageSummary.totalOrders}</strong>
                  </article>
                  <article>
                    <span>Total Revenue (LKR)</span>
                    <strong>{staffPageSummary.totalRevenue.toFixed(2)}</strong>
                  </article>
                </div>
                <div className="staff-summary-bottom">
                  <article>
                    <span>Avg Revenue / Staff (LKR)</span>
                    <strong>{staffPageSummary.avgRevenuePerStaff.toFixed(2)}</strong>
                  </article>
                  <article className="staff-summary-highlight">
                    <span>Top Performer</span>
                    <strong>{staffPageSummary.topPerformerName}</strong>
                    <p>{staffPageSummary.topPerformerOrders} orders • {currency(staffPageSummary.topPerformerRevenue)}</p>
                  </article>
                </div>
              </section>
            </section>
          ) : null}

          {activePage === "deliveries" ? (
            <section className="admin-mobile-section deliveries-page">
              <h2>Deliveries</h2>
              <div className="rep-date-filters">
                <select value={deliveryLorry} onChange={(e) => setDeliveryLorry(e.target.value)}>
                  <option value="all">All Lorries</option>
                  <option value="Lorry A">Lorry A</option>
                  <option value="Lorry B">Lorry B</option>
                </select>
                <label className="rep-date-field">
                  <span>From</span>
                  <input type="date" value={deliveryDateFrom} onChange={(e) => setDeliveryDateFrom(e.target.value)} />
                </label>
                <label className="rep-date-field">
                  <span>To</span>
                  <input type="date" value={deliveryDateTo} onChange={(e) => setDeliveryDateTo(e.target.value)} />
                </label>
              </div>
              <div className="admin-table deliveries-table">
                <header>
                  <span className="delivery-col-id">Sale ID</span>
                  <span className="delivery-col-date">Date/Time</span>
                  <span className="delivery-col-rep">Rep</span>
                  <span className="delivery-col-lorry">Lorry</span>
                  <span className="delivery-col-total">Total (LKR)</span>
                  <span className="delivery-col-status">Status</span>
                  <span className="th-action delivery-col-action">Action</span>
                </header>
                {deliveryRows.length ? deliveryRows.map((row) => (
                  <article key={`d-${row.id}`}>
                    <span className="delivery-col-id delivery-sale-cell">
                      <strong className="delivery-sale-id">#{row.id}</strong>
                      <small className="delivery-sale-meta">{row.when} • {row.rep}</small>
                    </span>
                    <span className="delivery-col-date delivery-cell-date">{row.when}</span>
                    <span className="delivery-col-rep">{row.rep}</span>
                    <span className="delivery-col-lorry">{row.lorry}</span>
                    <span className="delivery-col-total">{Number(row.total || 0).toFixed(2)}</span>
                    <span className="delivery-col-status">
                      <span className={row.confirmed ? "delivery-status confirmed" : "delivery-status pending"}>
                        {row.confirmed ? "Confirmed" : "Pending"}
                      </span>
                    </span>
                    <span className="action-cell delivery-col-action">
                      <button type="button" className="delivery-action-btn" onClick={() => openDeliveryModal(row.sale)}>
                        {row.confirmed ? "Update" : "Confirm"}
                      </button>
                    </span>
                  </article>
                )) : <p>No delivery bills found for selected filters.</p>}
              </div>
              <div className="report-head deliveries-report-head" style={{ marginTop: "0.65rem" }}>
                <h3>Delivered Items Report</h3>
              </div>
              <div className="rep-date-filters">
                <label className="rep-date-field">
                  <span>From</span>
                  <input type="date" value={deliveryReportDateFrom} onChange={(e) => setDeliveryReportDateFrom(e.target.value)} />
                </label>
                <label className="rep-date-field">
                  <span>To</span>
                  <input type="date" value={deliveryReportDateTo} onChange={(e) => setDeliveryReportDateTo(e.target.value)} />
                </label>
              </div>
              <div className="delivery-kpi-grid">
                <article>
                  <span>Sold Qty</span>
                  <strong>{soldTotals.qty}</strong>
                </article>
                <article>
                  <span>Sold Value</span>
                  <strong>{currency(soldTotals.value)}</strong>
                </article>
                <article>
                  <span>Delivered Qty</span>
                  <strong>{deliveredTotals.qty}</strong>
                </article>
                <article>
                  <span>Delivered Value</span>
                  <strong>{currency(deliveredTotals.value)}</strong>
                </article>
              </div>
              <div className="admin-table deliveries-report-table">
                <header>
                  <span>Item</span>
                  <span>SKU</span>
                  <span>Delivered Qty</span>
                  <span>Delivered Value</span>
                </header>
                {deliveredItemRows.length ? deliveredItemRows.map((row) => (
                  <article key={`dr-${row.key}`}>
                    <span>{row.item}</span>
                    <span>{row.sku}</span>
                    <span>{row.qty}</span>
                    <span>{currency(row.value)}</span>
                  </article>
                )) : <p>No delivered item records for selected filters.</p>}
              </div>
            </section>
          ) : null}

          {activePage === "dashboard" ? (
            <div className="admin-mobile admin-dashboard">
              <section className="admin-mobile-section dashboard-snapshot-panel">
                <h2>Admin Snapshot</h2>
                <div className="snapshot-layout">
                  <div className="snapshot-grid">
                    <article><p>Total sales</p><strong>{dashboard.salesCount}</strong></article>
                    <article><p>Today sales</p><strong>{dashboard.todaySalesCount}</strong></article>
                    <article><p>Today revenue</p><strong>{dashboard.todayRevenue.toFixed(0)}</strong></article>
                    <article><p>Low Stock</p><strong>{dashboard.lowStockItems.length}</strong></article>
                  </div>
                  <button type="button" className="low-stock-card" onClick={() => setShowLowStock(true)}>
                    <strong>Low Stock</strong>
                    <span>Click to popup the list</span>
                  </button>
                </div>
              </section>

              <section className="admin-mobile-section sales-day-panel dashboard-chart-panel">
                <h2>Sales Chart by Day</h2>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={chartDateFrom} onChange={(e) => setChartDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={chartDateTo} onChange={(e) => setChartDateTo(e.target.value)} />
                  </label>
                </div>
                <div className="bar-chart">
                  {chartData.map((item) => (
                    <div key={item.key} className="bar-col">
                      <div className="bar-value">{item.count}</div>
                      <div className="bar-wrap">
                        <div className="bar" style={{ height: `${(item.count / maxCount) * 100}%` }} />
                      </div>
                      <div className="bar-meta">{Number(item.revenue || 0).toFixed(2)}</div>
                      <div className="bar-label">{item.short}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="admin-mobile-section rep-chart-panel dashboard-chart-panel">
                <div className="chart-title-row rep-title-row">
                  <h2 className="rep-chart-title">Sales Chart by Rep</h2>
                  <div className="rep-search rep-search-wide">
                    <select value={selectedRep} onChange={(e) => setSelectedRep(e.target.value)}>
                      <option value="">All reps</option>
                      {repChartData.map((item) => (
                        <option key={item.rep} value={item.rep}>{item.rep}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={repDateFrom} onChange={(e) => setRepDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={repDateTo} onChange={(e) => setRepDateTo(e.target.value)} />
                  </label>
                </div>
                <div className="rep-result">
                  Matched reps: {filteredRepChartData.length}
                  {(repDateFrom || repDateTo) ? ` • Range: ${repDateFrom || "start"} to ${repDateTo || "today"}` : ""}
                </div>
                <div className="bar-chart rep-bar-chart">
                  {filteredRepChartData.map((item) => (
                    <div key={item.rep} className="bar-col">
                      <div className="bar-value">{item.count}</div>
                      <div className="bar-wrap">
                        <div className="bar" style={{ height: `${(item.count / repMaxCount) * 100}%` }} />
                      </div>
                      <div className="bar-label">{item.rep}</div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          {activePage === "reports" ? (
            <div className="admin-mobile admin-reports">
              <section className="admin-mobile-section report-panel report-itemwise-panel">
                <div className="report-head">
                  <h2>Item Wise Report</h2>
                  <select value={itemReportLorry} onChange={(e) => setItemReportLorry(e.target.value)}>
                    <option value="all">All Lorries</option>
                    <option value="Lorry A">Lorry A</option>
                    <option value="Lorry B">Lorry B</option>
                  </select>
                </div>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={itemDateFrom} onChange={(e) => setItemDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={itemDateTo} onChange={(e) => setItemDateTo(e.target.value)} />
                  </label>
                </div>
                <div className="admin-table item-wise-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "name")}>Item{sortMark("itemWise", "name")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "sku")}>SKU{sortMark("itemWise", "sku")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "qty")}>Sold Qty{sortMark("itemWise", "qty")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "bundles")}>Bundles{sortMark("itemWise", "bundles")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "singles")}>Singles{sortMark("itemWise", "singles")}</button>
                  </header>
                  {sortedItemWiseRows.length ? sortedItemWiseRows.map((row) => (
                    <article key={row.key}>
                      <span>{row.name}</span>
                      <span>{row.sku}</span>
                      <span>{row.qty}</span>
                      <span>{getBundleBreakdown(row).bundles}</span>
                      <span>{getBundleBreakdown(row).singles}</span>
                    </article>
                  )) : <p>No item-wise records yet.</p>}
                </div>
              </section>

              <section className="admin-mobile-section report-panel report-saleswise-panel">
                <h2>Sales Wise Report</h2>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={salesDateFrom} onChange={(e) => setSalesDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={salesDateTo} onChange={(e) => setSalesDateTo(e.target.value)} />
                  </label>
                </div>
                <div className="sales-range-kpi">
                  <span className="sales-range-kpi-label">Selected Range Total Sale Value</span>
                  <strong className="sales-range-kpi-value">{currency(salesRangeTotal)}</strong>
                </div>
                <div className="admin-table sales-wise-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("salesWise", "id")}>Sale ID{sortMark("salesWise", "id")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("salesWise", "when")}>Date{sortMark("salesWise", "when")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("salesWise", "lorry")}>Lorry{sortMark("salesWise", "lorry")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("salesWise", "total")}>Total<br />(LKR){sortMark("salesWise", "total")}</button>
                    <span className="th-action">Actions</span>
                  </header>
                  {sortedSalesWiseRows.length ? sortedSalesWiseRows.slice(0, 50).map((row) => (
                    <article key={row.id}>
                      <span className="sales-id-cell">
                        <strong>#{row.id}</strong>
                        <small>{row.rep}</small>
                      </span>
                      <span>{row.when}</span>
                      <span>{row.lorry}</span>
                      <span>{Number(row.total || 0).toFixed(2)}</span>
                      <span className="action-cell">
                        <button type="button" className="ghost" onClick={() => setViewSaleId(String(row.id))}>View</button>
                        <button type="button" className="ghost" onClick={() => openAdminSaleEdit(row.raw)}>Edit</button>
                        <button type="button" className="row-danger" onClick={() => deleteAdminSale(row.raw)} disabled={deletingSaleId === String(row.id)}>
                          {deletingSaleId === String(row.id) ? "..." : "🗑"}
                        </button>
                      </span>
                    </article>
                  )) : <p>No sales records yet.</p>}
                </div>
              </section>

              <section className="admin-mobile-section report-panel report-customerwise-panel">
                <h2>Customer Wise Report</h2>
                <div className="admin-table customer-wise-report-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customerWise", "name")}>Customer{sortMark("customerWise", "name")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customerWise", "orders")}>Orders{sortMark("customerWise", "orders")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customerWise", "spent")}>Total Spent (LKR){sortMark("customerWise", "spent")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customerWise", "lastAt")}>Last Purchase{sortMark("customerWise", "lastAt")}</button>
                  </header>
                {sortedCustomerWiseRows.length ? sortedCustomerWiseRows.map((row) => (
                  <article key={row.name}>
                    <span>{row.name}</span>
                    <span>{row.orders}</span>
                    <span>{Number(row.spent || 0).toFixed(2)}</span>
                    <span>{row.lastAt ? new Date(row.lastAt).toLocaleDateString() : "-"}</span>
                  </article>
                )) : <p>No customer-wise records yet.</p>}
              </div>
                <section className="customers-summary-card">
                  <div className="customers-summary-divider">
                    <span>SUMMARY</span>
                  </div>
                  <div className="customers-summary-head">
                    <h3>Customer Snapshot</h3>
                    <p>Live from filtered customer records</p>
                  </div>
                  <div className="customers-summary-grid">
                    <article>
                      <span>Total Customers</span>
                      <strong>{customerPageSummary.totalCustomers}</strong>
                    </article>
                    <article>
                      <span>Active Customers</span>
                      <strong>{customerPageSummary.activeCustomers}</strong>
                    </article>
                    <article className="warn">
                      <span>With Outstanding</span>
                      <strong>{customerPageSummary.customersWithOutstanding}</strong>
                    </article>
                  </div>
                  <div className="customers-summary-foot">
                    <article>
                      <span>Total Orders</span>
                      <strong>{customerPageSummary.totalOrders}</strong>
                      <p>Avg order value: {currency(customerPageSummary.averageOrderValue)}</p>
                    </article>
                    <article>
                      <span>Total Spent</span>
                      <strong>{currency(customerPageSummary.totalSpent)}</strong>
                      <p className="outstanding-text">Outstanding: {currency(customerPageSummary.totalOutstanding)}</p>
                    </article>
                    <article>
                      <span>Top Customer</span>
                      <strong>{customerPageSummary.topCustomerName}</strong>
                      <p>{currency(customerPageSummary.topCustomerSpent)}</p>
                    </article>
                  </div>
                </section>
              </section>

              <section className="admin-mobile-section report-panel report-delivery-panel">
                <div className="delivery-report-divider">
                  <span>DELIVERY INTELLIGENCE</span>
                </div>
                <div className="report-head">
                  <h2>Delivery Report</h2>
                  <select value={reportDeliveryLorry} onChange={(e) => setReportDeliveryLorry(e.target.value)}>
                    <option value="all">All Lorries</option>
                    <option value="Lorry A">Lorry A</option>
                    <option value="Lorry B">Lorry B</option>
                  </select>
                </div>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={reportDeliveryDateFrom} onChange={(e) => setReportDeliveryDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={reportDeliveryDateTo} onChange={(e) => setReportDeliveryDateTo(e.target.value)} />
                  </label>
                </div>
                <div className="delivery-report-kpi-grid">
                  <article><span>Total Bills</span><strong>{reportDeliverySummary.totalBills}</strong></article>
                  <article><span>Confirmed</span><strong>{reportDeliverySummary.confirmedBills}</strong></article>
                  <article><span>Pending</span><strong>{reportDeliverySummary.pendingBills}</strong></article>
                  <article><span>Sold Qty</span><strong>{reportDeliverySummary.soldQtyTotal}</strong></article>
                  <article><span>Delivered Qty</span><strong>{reportDeliverySummary.deliveredQtyTotal}</strong></article>
                  <article><span>Undelivered Qty</span><strong>{reportDeliverySummary.undeliveredQtyTotal}</strong></article>
                  <article><span>Delivered Value (LKR)</span><strong>{reportDeliverySummary.deliveredValueTotal.toFixed(2)}</strong></article>
                  <article><span>Delivery Rate</span><strong>{reportDeliverySummary.deliveryRate}%</strong></article>
                </div>
                <div className="admin-table delivery-report-sales-table">
                  <header>
                    <span>Sale ID</span>
                    <span>Date</span>
                    <span>Rep</span>
                    <span>Lorry</span>
                    <span>Status</span>
                    <span>Sold</span>
                    <span>ND</span>
                    <span>Delivered</span>
                    <span>Value (LKR)</span>
                  </header>
                  {reportDeliveryRows.length ? reportDeliveryRows.map((row) => (
                    <article key={`rdr-${row.id}`}>
                      <span>#{row.id}</span>
                      <span>{row.date}</span>
                      <span>{row.rep}</span>
                      <span>{row.lorry}</span>
                      <span>
                        <span className={row.status === "Confirmed" ? "delivery-status confirmed" : "delivery-status pending"}>
                          {row.status}
                        </span>
                      </span>
                      <span>{row.soldQty}</span>
                      <span>{row.undeliveredQty}</span>
                      <span>{row.deliveredQty}</span>
                      <span>{row.deliveredValue.toFixed(2)}</span>
                    </article>
                  )) : <p>No delivery report records for selected filters.</p>}
                </div>
              </section>
            </div>
          ) : null}

          {activePage === "loadings" ? (
            <div className="admin-mobile loadings-page">
              <section className="admin-mobile-section loading-range-panel">
                <h2>Loading Date Range</h2>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={loadingDateFrom} onChange={(e) => setLoadingDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={loadingDateTo} onChange={(e) => setLoadingDateTo(e.target.value)} />
                  </label>
                </div>
              </section>
              <section className="admin-mobile-section loading-lorry-panel loading-lorry-a">
                <h2>Lorry A Loading</h2>
                <div className="loading-summary-grid">
                  <article>
                    <span>Ordered Qty</span>
                    <strong>{loadingSummaryA.orderedQty}</strong>
                  </article>
                  <article>
                    <span>Ordered Value</span>
                    <strong>{currency(loadingSummaryA.orderedValue)}</strong>
                  </article>
                  <article>
                    <span>Delivered Qty</span>
                    <strong>{loadingSummaryA.deliveredQty}</strong>
                  </article>
                  <article>
                    <span>Delivered Value</span>
                    <strong>{currency(loadingSummaryA.deliveredValue)}</strong>
                  </article>
                </div>
                <div className="admin-table loading-table loading-table-a">
                  <header>
                    <button type="button" className="th-sort loading-col-item" onClick={() => toggleSort("loadingA", "name")}>Item{sortMark("loadingA", "name")}</button>
                    <button type="button" className="th-sort loading-col-ordered-qty" onClick={() => toggleSort("loadingA", "orderedQty")}>Ord Qty{sortMark("loadingA", "orderedQty")}</button>
                    <button type="button" className="th-sort loading-col-ordered-value" onClick={() => toggleSort("loadingA", "orderedValue")}>Ord Value{sortMark("loadingA", "orderedValue")}</button>
                    <button type="button" className="th-sort loading-col-bundles" onClick={() => toggleSort("loadingA", "bundles")}>Bundles{sortMark("loadingA", "bundles")}</button>
                    <button type="button" className="th-sort loading-col-singles" onClick={() => toggleSort("loadingA", "singles")}>Singles{sortMark("loadingA", "singles")}</button>
                    <button type="button" className="th-sort loading-col-delivered-qty" onClick={() => toggleSort("loadingA", "deliveredQty")}>Del Qty{sortMark("loadingA", "deliveredQty")}</button>
                    <button type="button" className="th-sort loading-col-delivered-value" onClick={() => toggleSort("loadingA", "deliveredValue")}>Del Value{sortMark("loadingA", "deliveredValue")}</button>
                  </header>
                  {sortedLoadingA.length ? sortedLoadingA.map((row) => (
                    <article key={`a-${row.key}`}>
                      <span className="loading-col-item">{row.name}</span>
                      <span className="loading-col-ordered-qty">{row.orderedQty}</span>
                      <span className="loading-col-ordered-value">{currency(row.orderedValue)}</span>
                      <span className="loading-col-bundles">{row.bundles}</span>
                      <span className="loading-col-singles">{row.balance}</span>
                      <span className="loading-col-delivered-qty">{row.deliveredQty}</span>
                      <span className="loading-col-delivered-value">{currency(row.deliveredValue)}</span>
                    </article>
                  )) : <p>No loading data for Lorry A.</p>}
                </div>
              </section>

              <section className="admin-mobile-section loading-lorry-panel loading-lorry-b">
                <h2>Lorry B Loading</h2>
                <div className="loading-summary-grid">
                  <article>
                    <span>Ordered Qty</span>
                    <strong>{loadingSummaryB.orderedQty}</strong>
                  </article>
                  <article>
                    <span>Ordered Value</span>
                    <strong>{currency(loadingSummaryB.orderedValue)}</strong>
                  </article>
                  <article>
                    <span>Delivered Qty</span>
                    <strong>{loadingSummaryB.deliveredQty}</strong>
                  </article>
                  <article>
                    <span>Delivered Value</span>
                    <strong>{currency(loadingSummaryB.deliveredValue)}</strong>
                  </article>
                </div>
                <div className="admin-table loading-table loading-table-b">
                  <header>
                    <button type="button" className="th-sort loading-col-item" onClick={() => toggleSort("loadingB", "name")}>Item{sortMark("loadingB", "name")}</button>
                    <button type="button" className="th-sort loading-col-ordered-qty" onClick={() => toggleSort("loadingB", "orderedQty")}>Ord Qty{sortMark("loadingB", "orderedQty")}</button>
                    <button type="button" className="th-sort loading-col-ordered-value" onClick={() => toggleSort("loadingB", "orderedValue")}>Ord Value{sortMark("loadingB", "orderedValue")}</button>
                    <button type="button" className="th-sort loading-col-bundles" onClick={() => toggleSort("loadingB", "bundles")}>Bundles{sortMark("loadingB", "bundles")}</button>
                    <button type="button" className="th-sort loading-col-singles" onClick={() => toggleSort("loadingB", "singles")}>Singles{sortMark("loadingB", "singles")}</button>
                    <button type="button" className="th-sort loading-col-delivered-qty" onClick={() => toggleSort("loadingB", "deliveredQty")}>Del Qty{sortMark("loadingB", "deliveredQty")}</button>
                    <button type="button" className="th-sort loading-col-delivered-value" onClick={() => toggleSort("loadingB", "deliveredValue")}>Del Value{sortMark("loadingB", "deliveredValue")}</button>
                  </header>
                  {sortedLoadingB.length ? sortedLoadingB.map((row) => (
                    <article key={`b-${row.key}`}>
                      <span className="loading-col-item">{row.name}</span>
                      <span className="loading-col-ordered-qty">{row.orderedQty}</span>
                      <span className="loading-col-ordered-value">{currency(row.orderedValue)}</span>
                      <span className="loading-col-bundles">{row.bundles}</span>
                      <span className="loading-col-singles">{row.balance}</span>
                      <span className="loading-col-delivered-qty">{row.deliveredQty}</span>
                      <span className="loading-col-delivered-value">{currency(row.deliveredValue)}</span>
                    </article>
                  )) : <p>No loading data for Lorry B.</p>}
                </div>
              </section>
            </div>
      ) : null}
        </section>
      </main>

      {showCustomerForm ? (
        <div className="low-stock-modal" onClick={() => setShowCustomerForm(false)}>
          <div className="low-stock-modal-card customer-entry-modal" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>{customerForm.id ? "Edit Customer" : "Add Customer"}</h3>
              <button type="button" onClick={() => setShowCustomerForm(false)}>Close</button>
            </div>
            <div className="admin-inline-form customer-entry-grid">
              <input value={customerForm.name} onChange={(e) => setCustomerForm((c) => ({ ...c, name: e.target.value }))} placeholder="Customer name" />
              <input value={customerForm.phone} onChange={(e) => setCustomerForm((c) => ({ ...c, phone: e.target.value }))} placeholder="Phone" />
              <textarea value={customerForm.address} onChange={(e) => setCustomerForm((c) => ({ ...c, address: e.target.value }))} placeholder="Address" />
              <div className="customer-entry-actions">
                <button type="button" onClick={saveCustomer}>Save Customer</button>
                <button type="button" className="ghost" onClick={() => setShowCustomerForm(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {customerDetailData ? (
        <div className="low-stock-modal" onClick={() => setCustomerDetailName("")}>
          <div className="low-stock-modal-card customer-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>{customerDetailData.row.name}</h3>
              <button type="button" onClick={() => setCustomerDetailName("")}>Close</button>
            </div>
            <div className="customer-detail-grid">
              <article>
                <span>Total Bills</span>
                <strong>{customerDetailData.totalBills}</strong>
              </article>
              <article>
                <span>Total Spent (LKR)</span>
                <strong>{Number(customerDetailData.row.spent || 0).toFixed(2)}</strong>
              </article>
              <article className={Number(customerDetailData.row.outstanding || 0) > 0 ? "warn" : ""}>
                <span>Outstanding (LKR)</span>
                <strong>{Number(customerDetailData.row.outstanding || 0).toFixed(2)}</strong>
              </article>
              <article>
                <span>Total Item Qty</span>
                <strong>{customerDetailData.totalQty}</strong>
              </article>
              <article>
                <span>Average Bill Value</span>
                <strong>LKR {Number(customerDetailData.averageBillValue || 0).toFixed(2)}</strong>
              </article>
              <article>
                <span>Last Purchase</span>
                <strong>{customerDetailData.lastSaleAt ? new Date(customerDetailData.lastSaleAt).toLocaleDateString() : "-"}</strong>
              </article>
            </div>
            <div className="customer-detail-meta">
              <p><strong>Phone:</strong> {customerDetailData.row.phone || "-"}</p>
              <p><strong>Address:</strong> {customerDetailData.row.address || "-"}</p>
            </div>
            <div className="customer-detail-recent">
              <h4>Recent Bills</h4>
              {customerDetailData.recentSales.length ? (
                <div className="customer-detail-recent-list">
                  {customerDetailData.recentSales.map((sale) => (
                    <article key={sale.id}>
                      <span>#{sale.id}</span>
                      <span>{new Date(sale.createdAt).toLocaleDateString()}</span>
                      <strong>{currency(sale.total || 0)}</strong>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="form-hint">No recent sales found.</p>
              )}
            </div>
            <div className="customer-detail-actions">
              <button
                type="button"
                onClick={() => {
                  openCustomerEditByRow(customerDetailData.row);
                  setCustomerDetailName("");
                }}
              >
                Edit Customer
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editingAdminSaleId ? (
        <div className="low-stock-modal" onClick={() => { setEditingAdminSaleId(""); setAdminSaleEditLines([]); setAdminSaleEditError(""); }}>
          <div className="low-stock-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Edit Sale #{editingAdminSaleId}</h3>
              <button type="button" onClick={() => { setEditingAdminSaleId(""); setAdminSaleEditLines([]); setAdminSaleEditError(""); }}>Close</button>
            </div>
            <div className="admin-inline-form">
              {adminSaleEditLines.map((line) => (
                <div key={line.productId} className="stock-row">
                  <span>{line.name}</span>
                  <input type="number" min="1" value={line.quantity} onChange={(e) => setAdminSaleEditLines((current) => current.map((l) => (l.productId === line.productId ? { ...l, quantity: e.target.value } : l)))} />
                  <button type="button" className="row-danger" onClick={() => setAdminSaleEditLines((current) => current.filter((l) => l.productId !== line.productId))}>Remove</button>
                </div>
              ))}
              {adminSaleEditError ? <p className="form-hint">{adminSaleEditError}</p> : null}
              <div>
                <button type="button" onClick={saveAdminSaleEdit} disabled={savingAdminSaleEdit}>{savingAdminSaleEdit ? "Saving..." : "Save Edit"}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {viewedSale ? (
        <div className="low-stock-modal" onClick={() => setViewSaleId("")}>
          <div className="low-stock-modal-card receipt-preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Receipt #{viewedSale.id}</h3>
              <button type="button" className="ghost" onClick={() => setViewSaleId("")}>Close</button>
            </div>
            <div className="receipt-preview">
              <h4>M.W.M.B CHANDRASEKARA - MATALE DISTRIBUTOR</h4>
              <p>{new Date(viewedSale.createdAt).toLocaleString()} • {viewedSale.customerName} • {viewedSale.paymentType}</p>
              <div className="admin-table receipt-table">
                <header>
                  <span>Item Code</span>
                  <span>Qty</span>
                  <span>Price<br />LKR</span>
                  <span>Item Discount</span>
                  <span>Total<br />LKR</span>
                </header>
                {(viewedSale.lines || []).map((line) => (
                  <article key={`${viewedSale.id}-${line.productId}`}>
                    <span>{line.sku || productInfoById.get(line.productId)?.sku || "-"}</span>
                    <span>{line.quantity}</span>
                    <span>{Number(line.price || 0).toFixed(2)}</span>
                    <span>{Number(line.itemDiscount || 0) > 0 ? currency(line.itemDiscount) : "-"}</span>
                    <span>{Number((Number(line.price || 0) * Number(line.quantity || 0)) || 0).toFixed(2)}</span>
                  </article>
                ))}
              </div>
              <div className="receipt-summary-row">
                <div className="receipt-summary-texts">
                  <p className="form-hint">Discount: {currency(viewedSale.discount || 0)}</p>
                  <p className="form-hint"><strong>Total: {currency(viewedSale.total || 0)}</strong></p>
                </div>
                <button type="button" className="receipt-print-action" onClick={() => printAdminSaleReceipt(viewedSale)}>Print</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {deliverySale ? (
        <div className="low-stock-modal" onClick={() => { setDeliverySaleId(""); setDeliveryDraft({}); setDeliveryError(""); }}>
          <div className="low-stock-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Confirm Delivery #{deliverySale.id}</h3>
              <button type="button" onClick={() => { setDeliverySaleId(""); setDeliveryDraft({}); setDeliveryError(""); }}>Close</button>
            </div>
            <p className="form-hint">{new Date(deliverySale.createdAt).toLocaleString()} • {deliverySale.cashier || "-"} • {deliverySale.lorry || "-"}</p>
            <div className="admin-table deliveries-lines-table">
              <header>
                <span>Item</span>
                <span>Sold</span>
                <span>Already ND</span>
                <span>Not Delivered</span>
              </header>
              {(deliverySale.lines || []).map((line) => {
                const prevUndelivered = (deliverySale.deliveryAdjustments || [])
                  .reduce((acc, adj) => acc + (adj.lines || [])
                    .filter((x) => x.productId === line.productId)
                    .reduce((xAcc, x) => xAcc + Number(x.quantity || 0), 0), 0);
                const prevReturnedGood = (state.returns || [])
                  .filter((ret) => String(ret.saleId) === String(deliverySale.id))
                  .reduce((acc, ret) => acc + (ret.lines || [])
                    .filter((x) => x.productId === line.productId && String(x.condition || "").toLowerCase() === "good")
                    .reduce((xAcc, x) => xAcc + Number(x.quantity || 0), 0), 0);
                const maxQty = Math.max(0, Number(line.quantity || 0) - prevUndelivered - prevReturnedGood);
                return (
                  <article key={`dl-${deliverySale.id}-${line.productId}`}>
                    <span>{line.name}</span>
                    <span>{line.quantity}</span>
                    <span>{prevUndelivered}</span>
                    <span>
                      <input
                        type="number"
                        min="0"
                        max={maxQty}
                        value={deliveryDraft[line.productId] ?? ""}
                        onChange={(e) => onDeliveryDraftChange(line.productId, e.target.value)}
                        placeholder={`max ${maxQty}`}
                      />
                    </span>
                  </article>
                );
              })}
            </div>
            <div className="delivery-history">
              <h4>Delivery History</h4>
              {(deliverySale.deliveryAdjustments || []).length ? (
                <div className="delivery-history-list">
                  {deliverySale.deliveryAdjustments.map((adj) => (
                    <article key={adj.id} className="delivery-history-row">
                      <p>
                        <strong>{new Date(adj.createdAt).toLocaleString()}</strong>
                        {" • "}
                        {adj.by || "admin"}
                      </p>
                      <p>
                        {(adj.lines || []).map((line) => `${line.name}: ${line.quantity}`).join(" | ")}
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="form-hint">No previous delivery adjustments.</p>
              )}
            </div>
            {deliveryError ? <p className="form-hint">{deliveryError}</p> : null}
            <div className="admin-page-actions">
              <button type="button" onClick={saveDeliveryAdjust} disabled={savingDelivery}>
                {savingDelivery ? "Saving..." : "Confirm Delivery"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showLowStock ? (
        <div className="low-stock-modal" onClick={() => setShowLowStock(false)}>
          <div className="low-stock-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Low Stock List</h3>
              <button type="button" onClick={() => setShowLowStock(false)}>Close</button>
            </div>
            <div className="low-stock-modal-list">
              {dashboard.lowStockItems.length ? dashboard.lowStockItems.map((item) => (
                <article key={item.id} className="list-row">
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.sku} • {item.category}</p>
                  </div>
                  <strong>{item.stock}</strong>
                </article>
              )) : <p>No low stock items.</p>}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};

export const App = () => {
  const [state, setState] = useState({ settings: {}, products: [], sales: [], returns: [] });
  const [dashboard, setDashboard] = useState({ salesCount: 0, todaySalesCount: 0, todayRevenue: 0, lowStockItems: [] });
  const [search, setSearch] = useState("");
  const [cashier, setCashier] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [lorry, setLorry] = useState("");
  const [paymentType, setPaymentType] = useState(PAYMENT_TYPES[0]);
  const [cashReceived, setCashReceived] = useState("");
  const [creditDueDate, setCreditDueDate] = useState("");
  const [discountMode, setDiscountMode] = useState("amount");
  const [discountValue, setDiscountValue] = useState("");
  const [cart, setCart] = useState([]);
  const [message, setMessage] = useState("");
  const [errorModal, setErrorModal] = useState("");
  const [authError, setAuthError] = useState("");
  const [session, setSession] = useState(null);

  const showErrorModal = (text) => {
    const value = String(text || "").trim();
    setMessage("");
    setErrorModal(value || "Something went wrong.");
  };

  const taxRate = 0;
  const effectiveCartLines = useMemo(
    () => cart.map((line) => ({ ...line, itemDiscount: lineItemDiscount(line), price: lineFinalPrice(line) })),
    [cart]
  );
  const discountAmount = useMemo(() => {
    const raw = Number(discountValue || 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const subTotal = Number(effectiveCartLines.reduce((acc, line) => acc + (Number(line.price || 0) * Number(line.quantity || 0)), 0).toFixed(2));
    if (discountMode === "percent") {
      const clamped = Math.min(raw, 100);
      return Number(((subTotal * clamped) / 100).toFixed(2));
    }
    return Number(raw.toFixed(2));
  }, [effectiveCartLines, discountMode, discountValue]);
  const totals = useMemo(() => calculateTotals({ lines: effectiveCartLines, taxRate, discount: discountAmount }), [effectiveCartLines, taxRate, discountAmount]);

  useEffect(() => {
    const handleInvalidSession = () => {
      sessionStorage.removeItem(SESSION_KEY);
      setSession(null);
      setAuthError("Session expired. Please sign in again.");
    };

    setAuthCallbacks({
      onRefresh: (nextSession) => {
        setSession(nextSession);
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
      },
      onInvalid: handleInvalidSession
    });

    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.accessToken) {
        setAuthSession(parsed);
        setSession(parsed);
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    if (!session) return undefined;
    let mounted = true;

    const load = async () => {
      try {
        await fetchMe();
        const [freshState, freshDashboard] = await Promise.all([fetchState(), fetchDashboard()]);
        if (!mounted) return;
        setState(freshState);
        setDashboard(freshDashboard);
      } catch (error) {
        if (mounted) showErrorModal(error.message);
      }
    };

    load();

    const socket = io(getApiBase(), {
      transports: ["websocket", "polling"],
      auth: { token: getAccessToken() }
    });

    socket.on(SOCKET_EVENTS.STATE_SYNC, (next) => {
      if (mounted) setState(next);
    });
    socket.on(SOCKET_EVENTS.SALE_CREATED, () => fetchDashboard().then((d) => mounted && setDashboard(d)).catch(() => {}));

    return () => {
      mounted = false;
      socket.disconnect();
    };
  }, [session?.accessToken]);

  useEffect(() => {
    if (session?.user?.role === "cashier") {
      setCashier(session.user.username || "");
    }
  }, [session?.user?.role, session?.user?.username]);

  useEffect(() => {
    if (paymentType !== "cash") setCashReceived("");
    if (paymentType !== "credit") setCreditDueDate("");
  }, [paymentType]);

  const login = async ({ username, password }) => {
    const attempts = [
      { role: "admin", username, password },
      { role: "cashier", username, password }
    ];
    try {
      let nextSession = null;
      for (const payload of attempts) {
        try {
          nextSession = await loginApi(payload);
          break;
        } catch {}
      }
      if (!nextSession) throw new Error("Invalid credentials");
      setAuthSession(nextSession);
      setSession(nextSession);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
      setAuthError("");
      setMessage("");
    } catch (error) {
      setAuthError(error.message);
    }
  };

  const logout = async () => {
    await logoutApi();
    clearAuthSession();
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
    setCart([]);
    setMessage("");
  };

  const checkout = async () => {
    try {
      if (!lorry) {
        showErrorModal("Select delivery lorry (Lorry A or Lorry B).");
        return;
      }
      if (paymentType === "cash") {
        const paid = Number(cashReceived || 0);
        if (!Number.isFinite(paid) || paid < 0) {
          showErrorModal("Cash received must be 0 or more.");
          return;
        }
      }
      if (paymentType === "credit" && !creditDueDate) {
        showErrorModal("Select credit due date.");
        return;
      }
      const sale = await submitSale({
        cashier,
        customerName,
        lorry,
        paymentType,
        cashReceived: paymentType === "cash" ? Number(cashReceived || 0) : undefined,
        creditDueDate: paymentType === "credit" ? creditDueDate : undefined,
        discount: discountAmount,
        taxRate: 0,
        lines: effectiveCartLines
      });
      openSaleReceiptPrint({
        sale,
        customers: state.customers || [],
        products: state.products || [],
        fallbackCustomerName: customerName,
        onPopupBlocked: () => showErrorModal(`Sale ${sale.id} completed, but popup is blocked. Allow popups to print receipt.`)
      });
      setMessage(`Sale ${sale.id} completed. Total ${currency(sale.total)}.`);
      setCart([]);
      setDiscountValue("");
      setCashReceived("");
      setCreditDueDate("");
      setDashboard(await fetchDashboard());
    } catch (error) {
      showErrorModal(error.message);
    }
  };

  if (!session?.user) {
    return <LoginScreen onLogin={login} error={authError} />;
  }

  return (
    <div className="shell">
      <Header dashboard={dashboard} user={session.user} onLogout={logout} />
      {session.user.role === "cashier" ? (
        <CashierView
          state={state}
          dashboard={dashboard}
          search={search}
          setSearch={setSearch}
          cashier={cashier}
          customerName={customerName}
          setCustomerName={setCustomerName}
          lorry={lorry}
          setLorry={setLorry}
          paymentType={paymentType}
          setPaymentType={setPaymentType}
          cashReceived={cashReceived}
          setCashReceived={setCashReceived}
          creditDueDate={creditDueDate}
          setCreditDueDate={setCreditDueDate}
          discountMode={discountMode}
          setDiscountMode={setDiscountMode}
          discountValue={discountValue}
          setDiscountValue={setDiscountValue}
          cart={cart}
          setCart={setCart}
          totals={totals}
          message={message}
          checkout={checkout}
        />
      ) : (
        <AdminView
          state={state}
          dashboard={dashboard}
          message={message}
          onError={showErrorModal}
        />
      )}
      {errorModal ? (
        <div className="low-stock-modal" onClick={() => setErrorModal("")}>
          <div className="low-stock-modal-card error-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Error</h3>
              <button type="button" onClick={() => setErrorModal("")}>Close</button>
            </div>
            <p className="error-modal-text">{errorModal}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
};
