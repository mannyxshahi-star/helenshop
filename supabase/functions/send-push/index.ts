import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:manny.gharibshahi@protonmail.com";
const webhookSecret = Deno.env.get("PUSH_WEBHOOK_SECRET") || "";
const siteUrl = Deno.env.get("HELENSHOP_SITE_URL") || "https://mannyxshahi-star.github.io/helenshop/";

type PushRow = {
  id: string;
  role: "owner" | "customer";
  order_id: string | null;
  order_code: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type WebhookPayload = {
  type?: string;
  table?: string;
  record?: Record<string, unknown>;
  old_record?: Record<string, unknown>;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function orderUrl(code?: string | null) {
  const url = new URL(siteUrl);
  if (code) url.searchParams.set("code", code);
  return url.toString();
}

function controlUrl() {
  return new URL("control.html", siteUrl).toString();
}

function isReceipt(record: Record<string, unknown>) {
  const photo = typeof record.photo_data === "string" ? record.photo_data : "";
  return record.sender === "customer" && photo.startsWith("data:image/");
}

function notificationFor(payload: WebhookPayload) {
  const record = payload.record || {};
  const old = payload.old_record || {};
  const code = typeof record.code === "string" ? record.code : (typeof record.order_code === "string" ? record.order_code : "");

  if (payload.table === "orders" && payload.type === "INSERT") {
    return [{ role: "owner", orderId: null, title: "سفارش جدید", body: code ? `سفارش ${code} ثبت شد.` : "یک سفارش جدید ثبت شد.", tag: `order-${code}`, url: controlUrl() }];
  }

  if (payload.table === "orders" && payload.type === "UPDATE" && old.status !== record.status) {
    const orderId = typeof record.id === "string" ? record.id : null;
    if (record.status === "approved") {
      return [{ role: "customer", orderId, title: "سفارشت تایید شد", body: code ? `سفارش ${code} تایید شد؛ شماره کارت در صفحه سفارش است.` : "سفارشت تایید شد.", tag: `order-${code}-approved`, url: orderUrl(code) }];
    }
    if (record.status === "payment_confirmed") {
      return [{ role: "customer", orderId, title: "پرداخت تایید شد", body: code ? `پرداخت سفارش ${code} تایید شد.` : "پرداخت تایید شد.", tag: `order-${code}-paid`, url: orderUrl(code) }];
    }
    if (record.status === "rejected") {
      return [{ role: "customer", orderId, title: "سفارش رد شد", body: code ? `سفارش ${code} رد شد.` : "سفارش رد شد.", tag: `order-${code}-rejected`, url: orderUrl(code) }];
    }
  }

  if (payload.table === "order_messages" && payload.type === "INSERT") {
    const orderId = typeof record.order_id === "string" ? record.order_id : null;
    if (record.sender === "customer") {
      const receipt = isReceipt(record);
      return [{
        role: "owner",
        orderId: null,
        title: receipt ? "رسید پرداخت رسید" : "پیام جدید مشتری",
        body: code ? (receipt ? `رسید پرداخت سفارش ${code} ارسال شد.` : `برای سفارش ${code} پیام جدید آمد.`) : "پیام جدید مشتری آمد.",
        tag: `message-${String(record.id || code)}`,
        url: controlUrl(),
      }];
    }
    if (record.sender === "owner") {
      const rawBody = typeof record.body === "string" ? record.body : "";
      const prefix = "【اعلان】";
      if (rawBody.startsWith(prefix)) {
        const rest = rawBody.slice(prefix.length);
        const nl = rest.indexOf("\n");
        const title = (nl === -1 ? rest : rest.slice(0, nl)).trim() || "پیام فروشگاه";
        const body = nl === -1 ? "" : rest.slice(nl + 1).trim();
        return [{ role: "customer", orderId, title, body: body || (code ? `برای سفارش ${code} اعلان جدید آمد.` : "اعلان جدید آمد."), tag: `message-${String(record.id || code)}`, url: orderUrl(code) }];
      }
      return [{ role: "customer", orderId, title: "پاسخ فروشگاه", body: code ? `فروشگاه به سفارش ${code} پاسخ داد.` : "فروشگاه پاسخ داد.", tag: `message-${String(record.id || code)}`, url: orderUrl(code) }];
    }
  }

  return [];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey || !webhookSecret) {
    return json({ ok: false, error: "push_not_configured" }, 500);
  }
  if (req.headers.get("x-push-webhook-secret") !== webhookSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const payload = await req.json().catch(() => null) as WebhookPayload | null;
  if (!payload) return json({ ok: false, error: "bad_json" }, 400);

  const notes = notificationFor(payload);
  if (!notes.length) return json({ ok: true, sent: 0, skipped: true });

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let sent = 0;
  let removed = 0;
  for (const note of notes) {
    let query = supabase.from("push_subscriptions").select("id,role,order_id,order_code,endpoint,p256dh,auth").eq("role", note.role);
    if (note.role === "customer") {
      if (!note.orderId) continue;
      query = query.eq("order_id", note.orderId);
    }
    const { data, error } = await query;
    if (error) return json({ ok: false, error: "subscription_lookup_failed" }, 500);
    for (const row of (data || []) as PushRow[]) {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify({ title: note.title, body: note.body, tag: note.tag, url: note.url }),
          { TTL: 86400, urgency: "high" },
        );
        sent += 1;
      } catch (err) {
        const statusCode = typeof err === "object" && err && "statusCode" in err ? Number((err as { statusCode?: unknown }).statusCode) : 0;
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", row.id);
          removed += 1;
        }
      }
    }
  }

  return json({ ok: true, sent, removed });
});
