(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  const data = HelenData.createDataLayer({ config: window.HELENSHOP_CONFIG, demo: params.get("demo") === "1" });
  const loginCard = document.getElementById("loginCard");
  const panel = document.getElementById("panel");
  const logoutBtn = document.getElementById("logoutBtn");
  const loginMessage = document.getElementById("loginMessage");
  const productEditor = document.getElementById("productEditor");
  const ordersEl = document.getElementById("orders");
  const settingsMessage = document.getElementById("settingsMessage");
  let products = [];
  let orders = [];
  let settings = { card_number: "" };
  let scanStream = null;
  let scanTimer = null;
  let scannedOrder = null;

  const faNum = (n) => Number(n).toLocaleString("fa-IR");
  const money = (n) => n === null || n === undefined ? "بدون قیمت" : faNum(n) + " تومان";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const msg = (el, text, kind) => { el.innerHTML = text ? `<div class="notice ${kind || ""}">${esc(text)}</div>` : ""; };

  function notice() {
    const el = document.getElementById("modeNotice");
    if (data.mode === "demo") el.innerHTML = '<div class="notice">حالت نمایشی محلی است؛ ورود و تغییرها فقط در همین مرورگر اثر دارند و امنیت واقعی ندارند.</div>';
    else if (data.mode === "setup") el.innerHTML = '<div class="notice err">Supabase هنوز تنظیم نشده است؛ ورود مالک تا تکمیل تنظیمات فعال نمی‌شود.</div>';
    else el.innerHTML = "";
  }
  function setAuthedUi() {
    const authed = Boolean(data.getSession());
    loginCard.classList.toggle("hidden", authed);
    panel.classList.toggle("hidden", !authed);
    logoutBtn.classList.toggle("hidden", !authed);
  }
  function statusText(status) {
    return ({ pending: "در انتظار تایید", approved: "تاییدشده", payment_confirmed: "پرداخت تایید شد", rejected: "ردشده" })[status] || status;
  }
  function renderProducts() {
    productEditor.innerHTML = '<table class="table"><thead><tr><th>محصول</th><th>قیمت تومان</th><th>موجودی</th><th>وضعیت</th><th></th></tr></thead><tbody>' + products.map((p) => `<tr>
      <td><strong>${esc(p.name)}</strong><div class="small">${esc(p.description || "")}</div></td>
      <td><input data-price="${esc(p.id)}" inputmode="numeric" value="${p.price_toman === null ? "" : esc(p.price_toman)}" placeholder="خالی = بدون قیمت"></td>
      <td><input data-stock="${esc(p.id)}" inputmode="numeric" value="${p.stock_quantity === null ? "" : esc(p.stock_quantity)}" placeholder="خالی = نامحدود"></td>
      <td><label class="row"><input type="checkbox" data-available="${esc(p.id)}" ${p.is_available ? "checked" : ""} style="width:auto"> موجود</label></td>
      <td><button class="btn primary" type="button" data-save-product="${esc(p.id)}">ذخیره</button></td>
    </tr>`).join("") + "</tbody></table>";
    productEditor.querySelectorAll("[data-save-product]").forEach((b) => b.addEventListener("click", () => saveProduct(b.dataset.saveProduct)));
  }
  async function saveProduct(id) {
    const price = productEditor.querySelector(`[data-price="${CSS.escape(id)}"]`).value.trim();
    const stock = productEditor.querySelector(`[data-stock="${CSS.escape(id)}"]`).value.trim();
    const available = productEditor.querySelector(`[data-available="${CSS.escape(id)}"]`).checked;
    try {
      await data.updateProduct(id, {
        price_toman: price === "" ? null : Number(price),
        stock_quantity: stock === "" ? null : Number(stock),
        is_available: available
      });
      await loadAll();
    } catch { msg(settingsMessage, "ذخیره محصول انجام نشد. ورود یا دسترسی را بررسی کنید.", "err"); }
  }
  function renderOrders() {
    const filter = document.getElementById("statusFilter").value;
    const list = orders.filter((o) => !filter || o.status === filter);
    if (!list.length) { ordersEl.innerHTML = '<p class="muted">سفارشی نیست.</p>'; return; }
    ordersEl.innerHTML = list.map((o) => {
      const items = (o.items || []).map((i) => `${esc(i.name)} × ${faNum(i.quantity)}`).join("، ");
      const amount = o.final_amount_toman ?? o.total_toman;
      return `<article class="card" style="margin-top:10px">
        <div class="row between"><strong>${esc(o.code)}</strong><span class="status ${esc(o.status)}">${esc(statusText(o.status))}</span></div>
        <p class="muted">${esc(o.customer_name || "")} ${esc(o.customer_phone || "")}<br>${items}<br>${esc(o.note || "")}</p>
        <p>مبلغ: ${money(amount)} ${o.card_number ? `| کارت: <span dir="ltr">${esc(o.card_number)}</span>` : ""}</p>
        <div class="row">
          <input data-amount="${esc(o.id)}" inputmode="numeric" placeholder="مبلغ نهایی" value="${amount === null || amount === undefined ? "" : esc(amount)}" style="max-width:180px">
          <input data-card="${esc(o.id)}" placeholder="شماره کارت" value="${esc(o.card_number || settings.card_number || "")}" style="max-width:240px">
          <button class="btn primary" type="button" data-approve="${esc(o.id)}">تایید و ارسال کارت</button>
          <button class="btn" type="button" data-confirm="${esc(o.id)}">پرداخت تایید شد</button>
          <button class="btn danger" type="button" data-reject="${esc(o.id)}">رد</button>
        </div>
      </article>`;
    }).join("");
    ordersEl.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => approve(b.dataset.approve)));
    ordersEl.querySelectorAll("[data-confirm]").forEach((b) => b.addEventListener("click", () => patchOrder(b.dataset.confirm, { status: "payment_confirmed" })));
    ordersEl.querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", () => patchOrder(b.dataset.reject, { status: "rejected" })));
  }
  function renderScannedOrder() {
    const el = document.getElementById("scannedOrder");
    if (!scannedOrder) { el.innerHTML = ""; return; }
    const o = scannedOrder;
    const items = (o.items || []).map((i) => `${esc(i.name)} × ${faNum(i.quantity)}`).join("، ");
    const amount = o.final_amount_toman ?? o.total_toman;
    el.innerHTML = `<article class="invoice"><div class="row between"><strong>${esc(o.code)}</strong><span class="status ${esc(o.status)}">${esc(statusText(o.status))}</span></div>
      <p class="muted">${esc(o.customer_name || "")} ${esc(o.customer_phone || "")}<br>${items}</p>
      <p>مبلغ: ${money(amount)} ${o.card_number ? `| کارت: <span dir="ltr">${esc(o.card_number)}</span>` : ""}</p>
      <div class="row"><button class="btn primary" type="button" data-scan-approve>تایید و ارسال کارت</button><button class="btn" type="button" data-scan-confirm>پرداخت تایید شد</button><button class="btn danger" type="button" data-scan-reject>رد</button></div></article>`;
    el.querySelector("[data-scan-approve]").addEventListener("click", async () => { await patchOrder(o.id, { status: "approved", final_amount_toman: amount ?? null, card_number: settings.card_number || o.card_number || null }); scannedOrder = orders.find((x) => x.id === o.id) || scannedOrder; renderScannedOrder(); });
    el.querySelector("[data-scan-confirm]").addEventListener("click", async () => { await patchOrder(o.id, { status: "payment_confirmed" }); scannedOrder = orders.find((x) => x.id === o.id) || scannedOrder; renderScannedOrder(); });
    el.querySelector("[data-scan-reject]").addEventListener("click", async () => { await patchOrder(o.id, { status: "rejected" }); scannedOrder = orders.find((x) => x.id === o.id) || scannedOrder; renderScannedOrder(); });
  }
  async function validateQrText(text) {
    const scanMessage = document.getElementById("scanMessage");
    try {
      scannedOrder = await data.ownerValidateQr(text);
      msg(scanMessage, "QR معتبر است؛ سفارش باز شد.", "ok");
      renderScannedOrder();
      stopScanner();
    } catch { scannedOrder = null; renderScannedOrder(); msg(scanMessage, "QR معتبر نیست.", "err"); }
  }
  function stopScanner() {
    if (scanTimer) cancelAnimationFrame(scanTimer);
    scanTimer = null;
    if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
    const video = document.getElementById("qrVideo");
    video.style.display = "none";
    document.getElementById("stopScan").classList.add("hidden");
    document.getElementById("startScan").classList.remove("hidden");
  }
  async function startScanner() {
    if (!data.getSession()) return;
    const video = document.getElementById("qrVideo");
    const canvas = document.getElementById("qrCanvas");
    const scanMessage = document.getElementById("scanMessage");
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.srcObject = scanStream;
      video.style.display = "block";
      await video.play();
      document.getElementById("startScan").classList.add("hidden");
      document.getElementById("stopScan").classList.remove("hidden");
      const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
      const tick = async () => {
        if (!scanStream) return;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (codes && codes[0] && codes[0].rawValue) { await validateQrText(codes[0].rawValue); return; }
          } else if (window.jsQR && video.videoWidth) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (code && code.data) { await validateQrText(code.data); return; }
          }
        } catch { /* keep scanning */ }
        scanTimer = requestAnimationFrame(tick);
      };
      tick();
    } catch { msg(scanMessage, "دوربین در دسترس نیست؛ لینک یا توکن را دستی وارد کنید.", "err"); stopScanner(); }
  }
  async function approve(id) {
    const amount = ordersEl.querySelector(`[data-amount="${CSS.escape(id)}"]`).value.trim();
    const card = ordersEl.querySelector(`[data-card="${CSS.escape(id)}"]`).value.trim();
    await patchOrder(id, { status: "approved", final_amount_toman: amount === "" ? null : Number(amount), card_number: card || null });
  }
  async function patchOrder(id, patch) {
    try { await data.updateOrder(id, patch); await loadAll(); }
    catch { msg(settingsMessage, "تغییر سفارش انجام نشد. ورود یا دسترسی را بررسی کنید.", "err"); }
  }
  async function loadAll() {
    if (!data.getSession()) { setAuthedUi(); return; }
    try {
      [products, orders, settings] = await Promise.all([data.getProducts(), data.listOrders(), data.getSettings()]);
      document.getElementById("cardNumber").value = settings.card_number || "";
      renderProducts(); renderOrders(); setAuthedUi();
    } catch {
      await data.logout(); setAuthedUi();
      msg(loginMessage, "نشست معتبر نیست. دوباره وارد شوید.", "err");
    }
  }

  document.getElementById("loginBtn").addEventListener("click", async () => {
    msg(loginMessage, "");
    try {
      await data.login(document.getElementById("username").value.trim(), document.getElementById("password").value);
      document.getElementById("password").value = "";
      await loadAll();
    } catch { msg(loginMessage, "نام کاربری یا رمز عبور درست نیست.", "err"); }
  });
  document.getElementById("password").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("loginBtn").click(); });
  logoutBtn.addEventListener("click", async () => { stopScanner(); await data.logout(); setAuthedUi(); });
  document.getElementById("startScan").addEventListener("click", startScanner);
  document.getElementById("stopScan").addEventListener("click", stopScanner);
  document.getElementById("manualQrBtn").addEventListener("click", () => validateQrText(document.getElementById("manualQr").value));
  document.getElementById("refreshBtn").addEventListener("click", loadAll);
  document.getElementById("statusFilter").addEventListener("change", renderOrders);
  document.getElementById("saveCard").addEventListener("click", async () => {
    try {
      settings = await data.saveSettings({ card_number: document.getElementById("cardNumber").value.trim() });
      msg(settingsMessage, "شماره کارت ذخیره شد.", "ok"); renderOrders();
    } catch { msg(settingsMessage, "ذخیره شماره کارت انجام نشد.", "err"); }
  });

  notice();
  setAuthedUi();
  loadAll();
  setInterval(loadAll, 20000);
})();
