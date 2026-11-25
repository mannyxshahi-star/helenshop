(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  const data = HelenData.createDataLayer({ config: window.HELENSHOP_CONFIG, demo: params.get("demo") === "1" });
  const productsEl = document.getElementById("products");
  const cartCountEl = document.getElementById("cartCount");
  const cartHintEl = document.getElementById("cartHint");
  const sheet = document.getElementById("cartSheet");
  const cartItemsEl = document.getElementById("cartItems");
  const orderMessageEl = document.getElementById("orderMessage");
  const trackResultEl = document.getElementById("trackResult");
  let products = [];
  const cart = new Map();
  let trackingToken = params.get("token") || "";

  const faNum = (n) => Number(n).toLocaleString("fa-IR");
  const money = (n) => n === null || n === undefined ? "قیمت پس از تایید" : faNum(n) + " تومان";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function notice() {
    const el = document.getElementById("modeNotice");
    if (data.mode === "demo") el.innerHTML = '<div class="notice">حالت نمایشی محلی است؛ داده‌ها واقعی نیستند و فقط در همین مرورگر ذخیره می‌شوند.</div>';
    else if (data.mode === "setup") el.innerHTML = '<div class="notice err">اتصال فروشگاه هنوز تنظیم نشده است. کلیدهای Supabase باید در assets/config.js قرار بگیرند.</div>';
    else el.innerHTML = "";
  }

  function cartItems() {
    return [...cart.entries()].filter(([, q]) => q > 0).map(([product_id, quantity]) => ({ product_id, quantity }));
  }
  function renderCartBar() {
    const count = cartItems().reduce((s, i) => s + i.quantity, 0);
    cartCountEl.textContent = faNum(count) + " کالا";
    cartHintEl.textContent = count ? "برای ثبت سفارش ادامه دهید" : "سبد خالی است";
  }
  function renderProducts() {
    if (!products.length) {
      productsEl.innerHTML = '<div class="card"><p class="muted">محصولی برای نمایش نیست.</p></div>';
      return;
    }
    productsEl.innerHTML = products.map((p) => {
      const sellable = data.productSellable(p);
      const qty = cart.get(p.id) || 0;
      const stockText = p.stock_quantity === null ? "موجود" : (Number(p.stock_quantity) > 0 ? "موجودی: " + faNum(p.stock_quantity) : "ناموجود");
      return `<article class="card">
        <div class="product-visual">${esc(p.name.slice(0, 1))}</div>
        <h3>${esc(p.name)}<span class="badge ${sellable ? "ok" : "off"}">${sellable ? esc(stockText) : "ناموجود"}</span></h3>
        <div class="muted">${esc(p.description || "")}</div>
        <div class="price">${money(p.price_toman)} <span class="small">/ ${esc(p.unit_label || "عدد")}</span></div>
        <div class="qtyrow"><span class="small">تعداد</span><div class="qty">
          <button type="button" data-dec="${esc(p.id)}" ${sellable ? "" : "disabled"}>−</button><output>${faNum(qty)}</output><button type="button" data-inc="${esc(p.id)}" ${sellable ? "" : "disabled"}>+</button>
        </div></div>
      </article>`;
    }).join("");
    productsEl.querySelectorAll("[data-inc]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.inc, 1)));
    productsEl.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.dec, -1)));
    renderCartBar();
  }
  function changeQty(id, delta) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    let next = (cart.get(id) || 0) + delta;
    if (p.stock_quantity !== null) next = Math.min(next, Number(p.stock_quantity));
    cart.set(id, Math.max(0, next));
    renderProducts();
  }
  function renderCart() {
    const items = cartItems();
    if (!items.length) {
      cartItemsEl.innerHTML = '<p class="muted">سبد خالی است.</p>';
      return;
    }
    cartItemsEl.innerHTML = '<table class="table"><thead><tr><th>محصول</th><th>تعداد</th><th>قیمت</th></tr></thead><tbody>' + items.map((i) => {
      const p = products.find((x) => x.id === i.product_id);
      return `<tr><td>${esc(p ? p.name : i.product_id)}</td><td>${faNum(i.quantity)}</td><td>${money(p ? p.price_toman : null)}</td></tr>`;
    }).join("") + "</tbody></table>";
  }
  function statusText(status) {
    return ({ pending: "در انتظار تایید", approved: "تایید شد؛ منتظر پرداخت", payment_confirmed: "پرداخت تایید شد", rejected: "رد شد" })[status] || status;
  }
  function trackingUrl(order) {
    const token = order.order_token || trackingToken;
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("code", order.code);
    if (token) url.searchParams.set("token", token);
    if (params.get("demo") === "1") url.searchParams.set("demo", "1");
    return url.toString();
  }
  function qrSvg(text) {
    try {
      const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
      const border = 4;
      const size = qr.size + border * 2;
      let path = "";
      for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) path += `M${x + border},${y + border}h1v1h-1z`;
      return `<svg viewBox="0 0 ${size} ${size}" width="220" height="220" role="img" aria-label="QR پیگیری سفارش" style="background:#fff;border-radius:14px;padding:8px"><path d="${path}" fill="#000"/></svg>`;
    } catch { return ""; }
  }
  function renderOrder(order) {
    if (!order) return '<div class="notice err">سفارشی با این مشخصات پیدا نشد.</div>';
    const amount = order.final_amount_toman ?? order.total_toman;
    const pay = order.status === "approved" ? `<p>مبلغ قابل پرداخت: <strong>${money(amount)}</strong></p><p>شماره کارت: <strong dir="ltr">${esc(order.card_number || "")}</strong></p>` : "";
    const done = order.status === "payment_confirmed" ? '<div class="notice ok">پرداخت تایید شد</div>' : "";
    const items = (order.items || []).map((i) => `<tr><td>${esc(i.name)}</td><td>${faNum(i.quantity)}</td><td>${money(i.price_toman)}</td></tr>`).join("");
    const link = trackingUrl(order);
    const qr = (order.order_token || trackingToken) ? `<div style="text-align:center;margin:12px 0">${qrSvg(link)}<div class="small">QR پیگیری سفارش</div><a class="small" href="${esc(link)}">لینک پیگیری</a></div>` : "";
    return `<div class="invoice"><div class="row between"><strong>کد سفارش: ${esc(order.code)}</strong><span class="status ${esc(order.status)}">${esc(statusText(order.status))}</span></div>
      <table class="table"><thead><tr><th>محصول</th><th>تعداد</th><th>قیمت واحد</th></tr></thead><tbody>${items}</tbody></table>
      <p>تحویل درب محل</p>${pay}${done}${qr}<p>${esc(order.slogan || "")}</p></div>`;
  }
  async function loadProducts() {
    try { products = await data.getProducts(); renderProducts(); }
    catch (e) { productsEl.innerHTML = '<div class="notice err">دریافت محصولات ناموفق بود.</div>'; }
  }
  async function track(code, phone, token) {
    const clean = String(code || "").trim().toUpperCase();
    if (!clean) return;
    trackResultEl.innerHTML = '<p class="muted">در حال بررسی…</p>';
    try {
      const order = await data.getOrderStatus({ code: clean, phone: phone || "", token: token || trackingToken || "" });
      trackResultEl.innerHTML = renderOrder(order);
      if (order) localStorage.setItem("helenshop_last_code", order.code);
    } catch { trackResultEl.innerHTML = '<div class="notice err">بررسی سفارش ناموفق بود.</div>'; }
  }

  document.getElementById("openCart").addEventListener("click", () => { renderCart(); sheet.classList.add("open"); });
  document.getElementById("closeCart").addEventListener("click", () => sheet.classList.remove("open"));
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.classList.remove("open"); });
  document.getElementById("trackBtn").addEventListener("click", () => document.getElementById("trackCode").focus());
  document.getElementById("trackSubmit").addEventListener("click", () => track(document.getElementById("trackCode").value, document.getElementById("trackPhone").value));
  document.getElementById("submitOrder").addEventListener("click", async () => {
    orderMessageEl.innerHTML = "";
    try {
      const order = await data.createOrder({
        customer_name: document.getElementById("customerName").value.trim(),
        customer_phone: document.getElementById("customerPhone").value.trim(),
        note: document.getElementById("customerNote").value.trim(),
        items: cartItems()
      });
      cart.clear(); renderProducts();
      trackingToken = order.order_token || trackingToken;
      orderMessageEl.innerHTML = '<div class="notice ok">سفارش ثبت شد. کد و QR را نگه دارید.</div>' + renderOrder(order);
      document.getElementById("trackCode").value = order.code;
      document.getElementById("trackPhone").value = document.getElementById("customerPhone").value;
      trackResultEl.innerHTML = renderOrder(order);
      await loadProducts();
    } catch (e) {
      orderMessageEl.innerHTML = '<div class="notice err">ثبت سفارش انجام نشد. موجودی یا اتصال را بررسی کنید.</div>';
    }
  });

  notice();
  loadProducts();
  const initialCode = params.get("code") || localStorage.getItem("helenshop_last_code");
  if (initialCode) { document.getElementById("trackCode").value = initialCode; if (trackingToken) track(initialCode, "", trackingToken); }
  setInterval(loadProducts, 15000);
  setInterval(() => { const c = document.getElementById("trackCode").value; const p = document.getElementById("trackPhone").value; if (c && (p || trackingToken)) track(c, p, trackingToken); }, 20000);
})();
