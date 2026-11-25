(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelenData = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const SLOGANS = [
    "فقط مال ما خوشمزه اس 😋",
    "مال ما فقط خوردن داره 😋",
    "امیدوارم لذت ببری از خوردن 😋"
  ];

  const SEED_PRODUCTS = [
    { id: "kashk", name: "کشک", description: "کشک محلی، آماده‌ی مصرف", unit_label: "بسته", price_toman: null, stock_quantity: null, is_available: true, sort_order: 1 },
    { id: "qara", name: "قارا", description: "قارای محلی با طعم اصیل", unit_label: "بسته", price_toman: null, stock_quantity: null, is_available: true, sort_order: 2 },
    { id: "goat-oil", name: "روغن حیوانی", description: "روغن بز سفید", unit_label: "شیشه", price_toman: null, stock_quantity: null, is_available: true, sort_order: 3 },
    { id: "yogurt", name: "ماست", description: "ماست محلی تازه", unit_label: "ظرف", price_toman: null, stock_quantity: null, is_available: true, sort_order: 4 },
    { id: "local-butter", name: "کره‌ی محلی", description: "کره‌ی بز سفید", unit_label: "بسته", price_toman: null, stock_quantity: null, is_available: true, sort_order: 5 },
    { id: "honey", name: "عسل", description: "عسل طبیعی", unit_label: "شیشه", price_toman: null, stock_quantity: null, is_available: true, sort_order: 6 }
  ];

  function isConfigured(config) {
    return Boolean(
      config &&
      typeof config.SUPABASE_URL === "string" &&
      config.SUPABASE_URL.startsWith("https://") &&
      !config.SUPABASE_URL.includes("YOUR_PROJECT") &&
      typeof config.SUPABASE_ANON_KEY === "string" &&
      config.SUPABASE_ANON_KEY.length > 20 &&
      !config.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")
    );
  }

  function memoryStorage() {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k)
    };
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function nowIso() { return new Date().toISOString(); }
  function makeCode(existing) {
    let code;
    do { code = "MS-" + String(Math.floor(100000 + Math.random() * 900000)); }
    while (existing && existing.some((o) => o.code === code));
    return code;
  }
  function productSellable(p) {
    return Boolean(p && p.is_available && (p.stock_quantity === null || p.stock_quantity === undefined || Number(p.stock_quantity) > 0));
  }
  function normalizeProduct(p) {
    return {
      ...p,
      price_toman: p.price_toman === "" || p.price_toman === undefined ? null : p.price_toman,
      stock_quantity: p.stock_quantity === "" || p.stock_quantity === undefined ? null : p.stock_quantity,
      is_available: Boolean(p.is_available)
    };
  }
  function normalizePhone(phone) { return String(phone || "").replace(/[^0-9+]/g, ""); }
  function base64Url(bytes) {
    let binary = "";
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    const b64 = typeof btoa !== "undefined" ? btoa(binary) : Buffer.from(bytes).toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function randomToken() {
    const bytes = new Uint8Array(32);
    const c = globalThis.crypto;
    if (!c || !c.getRandomValues) throw new Error("CRYPTO_UNAVAILABLE");
    c.getRandomValues(bytes);
    return base64Url(bytes);
  }
  async function sha256Hex(text) {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new Error("CRYPTO_UNAVAILABLE");
    const digest = await c.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function parseTrackingPayload(text) {
    const raw = String(text || "").trim();
    if (!raw) return { code: "", token: "" };
    try {
      const url = new URL(raw);
      return {
        code: (url.searchParams.get("code") || "").toUpperCase(),
        token: url.searchParams.get("token") || ""
      };
    } catch {
      const codeMatch = raw.toUpperCase().match(/MS-\d{6}/);
      const tokenMatch = raw.match(/[A-Za-z0-9_-]{32,}/);
      return { code: codeMatch ? codeMatch[0] : "", token: tokenMatch && (!codeMatch || tokenMatch[0] !== codeMatch[0]) ? tokenMatch[0] : "" };
    }
  }

  function createDataLayer(options) {
    const opts = options || {};
    const config = opts.config || {};
    const storage = opts.storage || (typeof localStorage !== "undefined" ? localStorage : memoryStorage());
    const fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    const demo = Boolean(opts.demo || config.DEMO_MODE);
    const configured = isConfigured(config);
    const mode = configured ? "supabase" : (demo ? "demo" : "setup");
    const base = configured ? config.SUPABASE_URL.replace(/\/$/, "") : "";
    const anon = config.SUPABASE_ANON_KEY || "";
    const SESSION_KEY = "helenshop_owner_session";

    function getSession() {
      try { return JSON.parse(storage.getItem(SESSION_KEY) || "null"); } catch { return null; }
    }
    function setSession(session) {
      if (session) storage.setItem(SESSION_KEY, JSON.stringify(session));
      else storage.removeItem(SESSION_KEY);
    }
    function requireSession() {
      const s = getSession();
      if (!s || !s.access_token) {
        const err = new Error("AUTH_REQUIRED");
        err.code = "AUTH_REQUIRED";
        throw err;
      }
      return s;
    }
    function headers(token, extra) {
      return {
        apikey: anon,
        Authorization: "Bearer " + (token || anon),
        "Content-Type": "application/json",
        ...(extra || {})
      };
    }
    async function request(path, init) {
      if (!fetchImpl) throw new Error("FETCH_UNAVAILABLE");
      const res = await fetchImpl(base + path, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const err = new Error((data && (data.message || data.error_description || data.error)) || ("HTTP_" + res.status));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }

    function demoRead(key, fallback) {
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : clone(fallback);
      } catch { return clone(fallback); }
    }
    function demoWrite(key, value) { storage.setItem(key, JSON.stringify(value)); }
    function demoProducts() {
      const products = demoRead("helenshop_demo_products", SEED_PRODUCTS);
      if (!storage.getItem("helenshop_demo_products")) demoWrite("helenshop_demo_products", products);
      return products.map(normalizeProduct).sort((a, b) => a.sort_order - b.sort_order);
    }
    function demoOrders() { return demoRead("helenshop_demo_orders", []); }
    function demoSettings() { return demoRead("helenshop_demo_settings", { card_number: "" }); }

    async function getProducts() {
      if (mode === "setup") return [];
      if (mode === "demo") return demoProducts();
      const rows = await request("/rest/v1/products?select=*&order=sort_order.asc", { headers: headers() });
      return rows.map(normalizeProduct);
    }

    async function createOrder(input) {
      const items = (input.items || []).filter((i) => Number(i.quantity) > 0);
      if (!items.length) throw new Error("EMPTY_CART");
      if (mode === "setup") throw new Error("SETUP_REQUIRED");
      if (mode === "supabase") {
        const rows = await request("/rest/v1/rpc/create_order", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            p_customer_name: input.customer_name || "",
            p_customer_phone: input.customer_phone || "",
            p_items: items,
            p_note: input.note || ""
          })
        });
        return Array.isArray(rows) ? rows[0] : rows;
      }
      const products = demoProducts();
      const byId = new Map(products.map((p) => [p.id, p]));
      const snapshot = [];
      let total = 0;
      let hasPrice = true;
      for (const item of items) {
        const p = byId.get(item.product_id);
        const qty = Number(item.quantity);
        if (!productSellable(p)) throw new Error("PRODUCT_UNAVAILABLE:" + item.product_id);
        if (p.stock_quantity !== null && qty > Number(p.stock_quantity)) throw new Error("INSUFFICIENT_STOCK:" + item.product_id);
        if (p.price_toman === null) hasPrice = false; else total += Number(p.price_toman) * qty;
        snapshot.push({ product_id: p.id, name: p.name, unit_label: p.unit_label, quantity: qty, price_toman: p.price_toman });
        if (p.stock_quantity !== null) p.stock_quantity = Number(p.stock_quantity) - qty;
      }
      demoWrite("helenshop_demo_products", products);
      const orders = demoOrders();
      const orderToken = randomToken();
      const order = {
        id: "demo-" + Date.now(),
        code: makeCode(orders),
        token_hash: await sha256Hex(orderToken),
        customer_name: input.customer_name || "",
        customer_phone: input.customer_phone || "",
        note: input.note || "",
        items: snapshot,
        status: "pending",
        total_toman: hasPrice ? total : null,
        final_amount_toman: null,
        card_number: null,
        slogan: SLOGANS[Math.floor(Math.random() * SLOGANS.length)],
        created_at: nowIso(),
        updated_at: nowIso()
      };
      orders.unshift(order);
      demoWrite("helenshop_demo_orders", orders);
      return { ...clone(order), order_token: orderToken };
    }

    function demoRateLimited(code) {
      const attempts = demoRead("helenshop_demo_lookup_attempts", {});
      const list = (attempts[code] || []).filter((t) => Date.now() - t < 15 * 60 * 1000);
      attempts[code] = list;
      demoWrite("helenshop_demo_lookup_attempts", attempts);
      return list.length >= 10;
    }
    function demoRecordFailedLookup(code) {
      const attempts = demoRead("helenshop_demo_lookup_attempts", {});
      attempts[code] = [...(attempts[code] || []), Date.now()].filter((t) => Date.now() - t < 15 * 60 * 1000);
      demoWrite("helenshop_demo_lookup_attempts", attempts);
    }
    async function getOrderStatus(input) {
      const code = String((input && input.code) || "").trim().toUpperCase();
      const token = String((input && input.token) || "");
      const phone = normalizePhone(input && input.phone);
      if (!code || (!token && !phone)) return null;
      if (mode === "setup") return null;
      if (mode === "demo") {
        if (demoRateLimited(code)) return null;
        const order = demoOrders().find((o) => o.code === code);
        const tokenOk = Boolean(order && token && order.token_hash === await sha256Hex(token));
        const phoneOk = Boolean(order && phone && normalizePhone(order.customer_phone) === phone);
        if (!order || (!tokenOk && !phoneOk)) { demoRecordFailedLookup(code); return null; }
        const { token_hash, ...publicOrder } = order;
        return clone(publicOrder);
      }
      const rows = await request("/rest/v1/rpc/get_order_status", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ p_code: code, p_token: token || null, p_phone: phone || null })
      });
      return Array.isArray(rows) ? (rows[0] || null) : rows;
    }
    async function getOrderByCode(code, phone) { return getOrderStatus({ code, phone }); }
    async function ownerValidateQr(payloadText) {
      const s = requireSession();
      const parsed = parseTrackingPayload(payloadText);
      if (!parsed.code || !parsed.token) throw new Error("INVALID_QR");
      if (mode === "demo") {
        if (demoRateLimited(parsed.code)) throw new Error("INVALID_QR");
        const order = demoOrders().find((o) => o.code === parsed.code);
        if (!order || order.token_hash !== await sha256Hex(parsed.token)) { demoRecordFailedLookup(parsed.code); throw new Error("INVALID_QR"); }
        return clone(order);
      }
      const rows = await request("/rest/v1/rpc/owner_get_order_by_token", {
        method: "POST",
        headers: headers(s.access_token),
        body: JSON.stringify({ p_code: parsed.code, p_token: parsed.token })
      });
      const order = Array.isArray(rows) ? rows[0] : rows;
      if (!order) throw new Error("INVALID_QR");
      return order;
    }

    async function login(username, password) {
      if (!username || !password) throw new Error("USERNAME_PASSWORD_REQUIRED");
      if (mode === "setup") throw new Error("SETUP_REQUIRED");
      if (mode === "demo") {
        // Local demo only: this creates a browser-local demo session and grants no backend access.
        const session = { access_token: "demo-local-session", user: { username }, demo: true, created_at: nowIso() };
        setSession(session);
        return session;
      }
      const data = await request("/functions/v1/username-login", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ username, password })
      });
      if (!data || !data.access_token) throw new Error("LOGIN_FAILED");
      const session = { access_token: data.access_token, refresh_token: data.refresh_token || null, user: data.user || { username }, expires_at: data.expires_at || null };
      setSession(session);
      return session;
    }

    async function logout() {
      const s = getSession();
      setSession(null);
      if (mode === "supabase" && s && s.access_token && fetchImpl) {
        try { await request("/auth/v1/logout", { method: "POST", headers: headers(s.access_token) }); } catch { /* local session already cleared */ }
      }
    }

    async function listOrders() {
      const s = requireSession();
      if (mode === "demo") return clone(demoOrders());
      return request("/rest/v1/orders?select=*&order=created_at.desc", { headers: headers(s.access_token) });
    }

    async function updateProduct(id, patch) {
      const s = requireSession();
      const clean = {
        price_toman: patch.price_toman === "" || patch.price_toman === undefined ? null : (patch.price_toman === null ? null : Number(patch.price_toman)),
        stock_quantity: patch.stock_quantity === "" || patch.stock_quantity === undefined ? null : (patch.stock_quantity === null ? null : Number(patch.stock_quantity)),
        is_available: Boolean(patch.is_available),
        updated_at: nowIso()
      };
      if ((clean.price_toman !== null && (!Number.isFinite(clean.price_toman) || clean.price_toman < 0)) ||
          (clean.stock_quantity !== null && (!Number.isFinite(clean.stock_quantity) || clean.stock_quantity < 0))) {
        throw new Error("INVALID_PRODUCT_PATCH");
      }
      if (mode === "demo") {
        const products = demoProducts().map((p) => p.id === id ? normalizeProduct({ ...p, ...clean }) : p);
        demoWrite("helenshop_demo_products", products);
        return products.find((p) => p.id === id);
      }
      const rows = await request("/rest/v1/products?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: headers(s.access_token, { Prefer: "return=representation" }),
        body: JSON.stringify(clean)
      });
      const updated = Array.isArray(rows) ? rows[0] : rows;
      if (!updated) throw new Error("PRODUCT_UPDATE_FAILED");
      return updated;
    }

    async function updateOrder(id, patch) {
      const s = requireSession();
      const clean = { ...patch, updated_at: nowIso() };
      if (mode === "demo") {
        const orders = demoOrders();
        const idx = orders.findIndex((o) => o.id === id);
        if (idx < 0) throw new Error("ORDER_NOT_FOUND");
        const before = orders[idx];
        const after = { ...before, ...clean };
        if (before.status !== "rejected" && after.status === "rejected") {
          const products = demoProducts();
          for (const item of before.items || []) {
            const p = products.find((x) => x.id === item.product_id);
            if (p && p.stock_quantity !== null) p.stock_quantity = Number(p.stock_quantity) + Number(item.quantity);
          }
          demoWrite("helenshop_demo_products", products);
        }
        orders[idx] = after;
        demoWrite("helenshop_demo_orders", orders);
        return clone(after);
      }
      const rows = await request("/rest/v1/orders?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: headers(s.access_token, { Prefer: "return=representation" }),
        body: JSON.stringify(clean)
      });
      return Array.isArray(rows) ? rows[0] : rows;
    }

    async function getSettings() {
      if (mode === "demo") return demoSettings();
      if (mode === "setup") return { card_number: "" };
      const s = getSession();
      const rows = await request("/rest/v1/shop_settings?select=key,value", { headers: headers(s ? s.access_token : null) });
      const out = { card_number: "" };
      for (const row of rows || []) out[row.key] = row.value;
      return out;
    }

    async function saveSettings(settings) {
      const s = requireSession();
      if (mode === "demo") {
        const next = { ...demoSettings(), ...settings };
        demoWrite("helenshop_demo_settings", next);
        return next;
      }
      const rows = Object.entries(settings).map(([key, value]) => ({ key, value: String(value || ""), updated_at: nowIso() }));
      await request("/rest/v1/shop_settings", {
        method: "POST",
        headers: headers(s.access_token, { Prefer: "resolution=merge-duplicates,return=representation" }),
        body: JSON.stringify(rows)
      });
      return getSettings();
    }

    return {
      mode,
      configured,
      slogans: SLOGANS,
      getProducts,
      createOrder,
      getOrderStatus,
      getOrderByCode,
      ownerValidateQr,
      login,
      logout,
      getSession,
      listOrders,
      updateProduct,
      updateOrder,
      getSettings,
      saveSettings,
      productSellable
    };
  }

  return { createDataLayer, isConfigured, parseTrackingPayload, SEED_PRODUCTS, SLOGANS };
});
