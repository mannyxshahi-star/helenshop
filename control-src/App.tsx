import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// The Space hosting scrim has no GitHub Pages equivalent; layout below is copied verbatim.
const SafeAreaTopScrim = (_props: { backgroundColor?: string }) => null;

type BreakdownKind = "device" | "os" | "browser" | "lang" | "tz";

type Product = {
  id: string;
  name: string;
  description: string;
  unit_label: string;
  price_toman: number | null;
  stock_quantity: number | null;
  is_available: boolean;
  sort_order: number;
};
type OrderItem = { product_id: string; name: string; unit_label: string; quantity: number; price_toman: number | null };
type Order = {
  id: string;
  code: string;
  customer_name: string;
  customer_phone: string;
  note: string;
  items: OrderItem[];
  status: string;
  total_toman: number | null;
  final_amount_toman: number | null;
  card_number: string | null;
  slogan: string;
  archived_at?: string | null;
  created_at: string;
};
type ShopData = { products: Product[]; orders: Order[]; messages: OrderMessage[]; settings: { card_number: string } };
type OrderMessage = { id: string; order_id: string; order_code: string; sender: string; body: string; photo_data: string | null; created_at: string };

declare global {
  interface Window {
    HELENSHOP_CONFIG: unknown;
    HelenData: {
      createDataLayer: (opts: { config: unknown; demo: boolean }) => {
        mode: string;
        getProducts: () => Promise<Product[]>;
        listOrders: () => Promise<Order[]>;
        getSettings: () => Promise<{ card_number: string }>;
        login: (u: string, p: string) => Promise<unknown>;
        logout: () => Promise<void>;
        getSession: () => unknown;
        updateProduct: (id: string, patch: { price_toman: number | null; stock_quantity: number | null; is_available: boolean }) => Promise<unknown>;
        updateOrder: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
        saveSettings: (s: { card_number: string }) => Promise<{ card_number: string }>;
        ownerValidateQr: (text: string) => Promise<Order>;
        listOrderMessages: (orderId: string) => Promise<OrderMessage[]>;
        listRecentOrderMessages: (limit?: number) => Promise<OrderMessage[]>;
        ownerSendOrderMessage: (orderId: string, body: string, photoData?: string | null) => Promise<OrderMessage>;
        savePushSubscription: (input: { role: "owner" | "customer"; subscription: unknown; code?: string; token?: string; phone?: string }) => Promise<unknown>;
        deleteOrder: (id: string) => Promise<unknown>;
        productSellable: (p: Product) => boolean;
      };
    };
    HelenNotify?: {
      permission: () => string;
      requestPermission: (dataLayer: unknown, input: unknown) => Promise<{ permission: string; push: { ok: boolean; reason?: string } }>;
      refreshSubscription?: (dataLayer: unknown, input: unknown) => Promise<{ ok: boolean; reason?: string }>;
      show: (title: string, body: string, options?: { key?: string; tag?: string; url?: string }) => Promise<boolean>;
      playBell?: () => boolean;
    };
    jsQR?: (data: Uint8ClampedArray, w: number, h: number, opts?: unknown) => { data: string } | null;
  }
}

const hsParams = new URLSearchParams(location.search);
const data = window.HelenData.createDataLayer({
  config: window.HELENSHOP_CONFIG,
  demo: hsParams.get("demo") === "1",
});

const STATUS_LABEL: Record<string, string> = {
  pending: "در انتظار تایید",
  approved: "تایید شد — در انتظار پرداخت",
  payment_confirmed: "پرداخت تایید شد",
  rejected: "رد شد",
};
const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "بدون قیمت" : `${fmt(Number(n))} تومان`;
const faQty = (q: number) => fmt(Number(q));

const CUSTOM_NOTIFICATION_PREFIX = "【اعلان】";
function customNotificationBody(title: string, body: string) {
  const cleanTitle = title.trim() || "پیام فروشگاه";
  const cleanBody = body.trim();
  return `${CUSTOM_NOTIFICATION_PREFIX}${cleanTitle}${cleanBody ? `\n${cleanBody}` : ""}`;
}
function parseCustomNotification(body: string | null | undefined) {
  const text = String(body || "");
  if (!text.startsWith(CUSTOM_NOTIFICATION_PREFIX)) return null;
  const rest = text.slice(CUSTOM_NOTIFICATION_PREFIX.length);
  const nl = rest.indexOf("\n");
  return {
    title: (nl === -1 ? rest : rest.slice(0, nl)).trim() || "پیام فروشگاه",
    body: nl === -1 ? "" : rest.slice(nl + 1).trim(),
  };
}
function isPaymentReceiptMessage(m: OrderMessage) {
  return m.sender !== "owner" && Boolean(m.photo_data && m.photo_data.startsWith("data:image/"));
}
function receiptOrderIds(messages: OrderMessage[]) {
  const ids = new Set<string>();
  for (const m of messages || []) if (isPaymentReceiptMessage(m)) ids.add(m.order_id);
  return ids;
}
function isArchived(order: Order) {
  return Boolean(order.archived_at);
}
function stageRank(order: Order, hasReceipt: boolean) {
  if (isArchived(order)) return 90;
  if (order.status === "approved" && hasReceipt) return 0;
  if (order.status === "pending") return 1;
  if (order.status === "approved") return 2;
  if (order.status === "payment_confirmed") return 3;
  if (order.status === "rejected") return 4;
  return 5;
}

const fmt = (n: number) => n.toLocaleString("fa-IR");

function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat("fa-IR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

function fmtDayShort(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat("fa-IR", {
    day: "numeric",
    month: "short",
  }).format(d);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Always render in Tehran time so snapshot times line up with the
  // Tehran-day buckets the stats API reports, regardless of viewer locale.
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function fmtVisitDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

function fmtVisitTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

// Stay duration as minute:second in Persian digits (e.g. ۱:۲۳). A missing,
// null, or non-finite value renders as «—» — never NaN — so rows recorded
// before duration tracking shipped read clean.
function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) {
    return "—";
  }
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${fmt(m)}:${fmt(s).padStart(2, "۰")}`;
}

type BreakdownKind = "device" | "os" | "browser" | "lang" | "tz";


const LABELS: Record<BreakdownKind, Record<string, string>> = {
  device: {
    mobile: "موبایل",
    desktop: "دسکتاپ",
    tablet: "تبلت",
    other: "سایر",
    unknown: "نامشخص",
  },
  os: {
    Android: "اندروید",
    iOS: "آی‌اواس",
    Windows: "ویندوز",
    "Windows 10": "ویندوز ۱۰",
    "Windows 11": "ویندوز ۱۱",
    macOS: "مک‌اواس",
    "Mac OS": "مک‌اواس",
    Linux: "لینوکس",
    Ubuntu: "اوبونتو",
    "Chrome OS": "کروم‌اواس",
    other: "سایر",
    unknown: "نامشخص",
  },
  browser: {
    Chrome: "کروم",
    "Chrome Mobile": "کروم موبایل",
    Samsung: "سامسونگ اینترنت",
    "Samsung Internet": "سامسونگ اینترنت",
    "Samsung Browser": "سامسونگ اینترنت",
    Firefox: "فایرفاکس",
    "Firefox Mobile": "فایرفاکس موبایل",
    Safari: "سافاری",
    "Mobile Safari": "سافاری موبایل",
    Edge: "مایکروسافت اج",
    Opera: "اپرا",
    "Opera Mini": "اپرا مینی",
    Brave: "بریو",
    Chromium: "کرومیوم",
    other: "سایر",
    unknown: "نامشخص",
  },
  lang: {
    en: "انگلیسی",
    "en-US": "انگلیسی",
    "en-GB": "انگلیسی",
    fa: "فارسی",
    "fa-IR": "فارسی",
    ar: "عربی",
    de: "آلمانی",
    fr: "فرانسوی",
    es: "اسپانیایی",
    ru: "روسی",
    tr: "ترکی",
    az: "آذربایجانی",
    ku: "کردی",
    ps: "پشتو",
    ur: "اردو",
    hi: "هندی",
    zh: "چینی",
    ja: "ژاپنی",
    ko: "کره‌ای",
    it: "ایتالیایی",
    pt: "پرتغالی",
    nl: "هلندی",
    sv: "سوئدی",
    no: "نروژی",
    nb: "نروژی",
    da: "دانمارکی",
    fi: "فنلاندی",
    pl: "لهستانی",
    uk: "اوکراینی",
    other: "سایر",
    unknown: "نامشخص",
  },
  tz: {
    "Asia/Tehran": "تهران",
    "Asia/Kabul": "کابل",
    "Asia/Dubai": "دبی",
    "Asia/Baghdad": "بغداد",
    "Asia/Riyadh": "ریاض",
    "Asia/Qatar": "قطر",
    "Asia/Kuwait": "کویت",
    "Asia/Baku": "باکو",
    "Asia/Yerevan": "ایروان",
    "Asia/Tbilisi": "تفلیس",
    "Asia/Istanbul": "استانبول",
    "Europe/Istanbul": "استانبول",
    "Asia/Kolkata": "هند",
    "Asia/Calcutta": "هند",
    "Asia/Karachi": "کراچی",
    "Asia/Almaty": "آلماتی",
    "Asia/Tashkent": "تاشکند",
    "Asia/Tokyo": "توکیو",
    "Asia/Shanghai": "شانگهای",
    "Asia/Singapore": "سنگاپور",
    "Europe/London": "لندن",
    "Europe/Berlin": "برلین",
    "Europe/Paris": "پاریس",
    "Europe/Madrid": "مادرید",
    "Europe/Rome": "رم",
    "Europe/Amsterdam": "آمستردام",
    "Europe/Moscow": "مسکو",
    "Europe/Oslo": "اسلو",
    "Europe/Stockholm": "استکهلم",
    "America/New_York": "نیویورک",
    "America/Chicago": "شیکاگو",
    "America/Denver": "دنور",
    "America/Los_Angeles": "لس‌آنجلس",
    "America/Toronto": "تورنتو",
    "America/Vancouver": "ونکوور",
    "America/Sao_Paulo": "سائوپائولو",
    "Australia/Sydney": "سیدنی",
    "Pacific/Auckland": "اوکلند",
    UTC: "ساعت جهانی (UTC)",
    other: "سایر",
    unknown: "نامشخص",
  },
};

function labelFor(kind: BreakdownKind, key: string): string {
  const map = LABELS[kind];
  const direct = map[key];
  if (direct) return direct;
  // Language tags like "en-US" / "fa_IR": fall back to the base language.
  if (kind === "lang") {
    const base = key.split(/[-_]/)[0];
    if (base && map[base]) return map[base];
  }
  return key;
}

const BAR_GRADIENTS = [
  "linear-gradient(to left, #2dd4bf, #1c39bb)",
  "linear-gradient(to left, #0d9488, #22d3ee)",
  "linear-gradient(to left, #34d399, #2dd4bf)",
  "linear-gradient(to left, #22d3ee, #5b83f0)",
];

/* Shared Liquid Glass control styles: fully rounded, touch-sized
   (min 44px tall), consistent across every panel. */
const FIELD_CLASS =
  "w-full rounded-full border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3 text-sm text-[var(--text)] outline-none transition placeholder:text-[var(--dim)] focus:border-[var(--accent)] disabled:opacity-50";
const FIELD_LTR_CLASS = `${FIELD_CLASS} tnum text-left`;
const TEXTAREA_CLASS =
  "w-full rounded-3xl border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3 text-sm text-[var(--text)] outline-none transition placeholder:text-[var(--dim)] focus:border-[var(--accent)] disabled:opacity-50";
const BTN_PRIMARY_CLASS =
  "min-h-11 rounded-full px-5 py-3 text-sm font-bold text-white shadow-lg transition active:scale-[0.98] disabled:opacity-40";
const BTN_PRIMARY_STYLE = {
  background: "linear-gradient(120deg, #14b8a6, #1c39bb)",
} as const;
const BTN_GHOST_CLASS =
  "min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3 text-sm font-bold text-[var(--text)] transition active:scale-[0.98] disabled:opacity-40";
const LABEL_CLASS = "text-xs font-bold text-[var(--text)]";
const HINT_CLASS = "font-normal text-[var(--dim)]";
/* Subsection heading inside a song card: a short teal bar + bold label,
   so each card reads as ordered groups instead of one long form. */
const SUBHEAD_CLASS =
  "flex items-center gap-2 text-[13px] font-black text-[var(--text)] before:h-4 before:w-1 before:shrink-0 before:rounded-full before:bg-[var(--accent)] before:content-['']";

function Breakdown({
  title,
  kind,
  entries,
}: {
  title: string;
  kind: BreakdownKind;
  entries: Record<string, number>;
}) {
  const sorted = Object.entries(entries).sort((a, b) => b[1] - a[1]);
  const sum = sorted.reduce((acc, [, v]) => acc + v, 0);
  if (sorted.length === 0) {
    return (
      <section aria-label={title} className="py-3">
        <h3 className="text-sm font-bold text-[var(--text)]">{title}</h3>
        <p className="mt-2 text-sm text-[var(--dim)]">هنوز داده‌ای نیست.</p>
      </section>
    );
  }
  return (
    <section aria-label={title} className="py-3">
      <h3 className="text-sm font-bold text-[var(--text)]">{title}</h3>
      <ul className="mt-2.5 space-y-2.5">
        {sorted.map(([key, value], i) => {
          const pct = sum > 0 ? Math.round((value / sum) * 100) : 0;
          const label = labelFor(kind, key);
          return (
            <li key={key}>
              <div className="flex items-baseline justify-between gap-3">
                <span
                  dir="auto"
                  className="min-w-0 truncate text-sm text-[var(--text)]"
                >
                  {label}
                </span>
                <span className="tnum shrink-0 text-sm text-[var(--dim)]">
                  {fmt(value)} · {fmt(pct)}٪
                </span>
              </div>
              <div
                className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-alt)]"
                role="img"
                aria-label={`${label}: ${fmt(value)} بازدید، ${fmt(pct)} درصد`}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(pct, value > 0 ? 3 : 0)}%`,
                    background:
                      BAR_GRADIENTS[i % BAR_GRADIENTS.length] ??
                      BAR_GRADIENTS[0],
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((acc, p) => acc + (p.value ?? 0), 0);
  return (
    <div
      dir="rtl"
      className="rounded-lg border border-[var(--border)] bg-[#101c4e] px-3 py-2 shadow-lg"
    >
      <p className="text-xs font-bold text-[var(--text)]">
        {label ? fmtDay(String(label)) : ""}
      </p>
      {payload.map((p) => (
        <p key={p.name} className="tnum mt-1 text-xs text-[var(--dim)]">
          <span style={{ color: p.color }}>●</span> {p.name}: {fmt(p.value)}
        </p>
      ))}
      <p className="tnum mt-1 border-t border-[var(--border)] pt-1 text-xs font-bold text-[var(--text)]">
        مجموع: {fmt(total)}
      </p>
    </div>
  );
}

function SpecRow({
  label,
  value,
  ltr,
}: {
  label: string;
  value: string;
  ltr?: boolean;
}) {
  const empty = value.trim() === "";
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-xs text-[var(--dim)]">{label}</span>
      {empty ? (
        <span className="text-sm text-[var(--dim)]">ثبت نشده</span>
      ) : (
        <span
          dir={ltr ? "ltr" : "auto"}
          className={`min-w-0 truncate text-sm text-[var(--text)] ${ltr ? "tnum text-left" : ""}`}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function GlassSection({
  title,
  ariaLabel,
  children,
  className = "",
}: {
  title?: string;
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={ariaLabel ?? title}
      className={`glass rounded-[24px] p-3.5 sm:p-4 ${className}`}
    >
      {title ? (
        <h2 className="text-sm font-black text-[var(--text)]">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}


function OrderCard({
  order,
  cardNumber,
  onPatch,
  onDelete,
  busy,
  hasReceipt = false,
}: {
  order: Order;
  cardNumber: string;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  busy: boolean;
  hasReceipt?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [card, setCard] = useState("");
  const [messages, setMessages] = useState<OrderMessage[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [reply, setReply] = useState("");
  const [notifyTitle, setNotifyTitle] = useState("");
  const [notifyBody, setNotifyBody] = useState("");
  const [notifyStatus, setNotifyStatus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msgBusy, setMsgBusy] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);
  const shouldLoadMessages = open || hasReceipt || order.status === "approved" || order.status === "payment_confirmed";
  useEffect(() => {
    if (!shouldLoadMessages) return;
    let alive = true;
    data.listOrderMessages(order.id).then((list) => { if (alive) { setMessages(list || []); setMessagesLoaded(true); } }).catch(() => { if (alive) setMsgError("پیام‌ها بارگذاری نشد."); });
    return () => { alive = false; };
  }, [shouldLoadMessages, order.id]);
  const sendReply = async () => {
    const body = reply.trim();
    if (!body) return;
    setMsgBusy(true);
    setMsgError(null);
    try {
      const msg = await data.ownerSendOrderMessage(order.id, body, null);
      setMessages((prev) => [...prev, msg]);
      setReply("");
    } catch {
      setMsgError("پاسخ ارسال نشد.");
    } finally {
      setMsgBusy(false);
    }
  };
  const sendCustomNotification = async () => {
    const body = notifyBody.trim();
    const title = notifyTitle.trim();
    if (!title && !body) return;
    setMsgBusy(true);
    setMsgError(null);
    setNotifyStatus(null);
    try {
      const msg = await data.ownerSendOrderMessage(order.id, customNotificationBody(title, body), null);
      setMessages((prev) => [...prev, msg]);
      setNotifyTitle("");
      setNotifyBody("");
      setNotifyStatus("اعلان برای مشتری ارسال شد.");
    } catch {
      setMsgError("اعلان ارسال نشد.");
    } finally {
      setMsgBusy(false);
    }
  };
  const archived = isArchived(order);
  const paymentPhotos = messages.filter(isPaymentReceiptMessage);
  const latestPaymentPhoto = paymentPhotos.length > 0 ? paymentPhotos[paymentPhotos.length - 1] : null;
  const receiptReceived = order.status === "approved" && (hasReceipt || latestPaymentPhoto !== null);
  const statusLabel = archived
    ? "رد شد — بایگانی"
    : receiptReceived
      ? "رسید پرداخت رسید"
      : (STATUS_LABEL[order.status] ?? order.status);
  const itemsText = (order.items || [])
    .map((i) => `${i.name} — ${faQty(i.quantity)} کیلوگرم`)
    .join(" · ");
  const amountValue = order.final_amount_toman ?? order.total_toman;
  const parsedAmount = amount.trim() === "" ? amountValue : Number(amount.replace(/[^0-9]/g, ""));
  const effectiveAmount = parsedAmount === null || parsedAmount === undefined || !Number.isFinite(Number(parsedAmount)) ? null : Number(parsedAmount);
  const effectiveCard = card.trim() || order.card_number || cardNumber || "";
  const approveDisabled = busy || !effectiveCard || effectiveAmount === null || effectiveAmount <= 0;
  const detailsId = `order-${order.id}`;

  const rejectButton = (
    <button
      type="button"
      disabled={busy}
      onClick={() => onPatch(order.id, { status: "rejected" })}
      className="min-h-11 shrink-0 rounded-full bg-[var(--surface)] px-3.5 py-2 text-xs font-bold text-[var(--danger)] disabled:opacity-40"
    >
      رد سفارش
    </button>
  );
  const confirmPaymentButton = (
    <button
      type="button"
      disabled={busy}
      onClick={() => onPatch(order.id, { status: "payment_confirmed" })}
      className={BTN_PRIMARY_CLASS}
      style={BTN_PRIMARY_STYLE}
    >
      پرداخت تایید شد
    </button>
  );
  const archiveButton = (
    <button
      type="button"
      disabled={busy}
      onClick={() => onPatch(order.id, { archived_at: new Date().toISOString() })}
      className={BTN_GHOST_CLASS}
    >
      بایگانی سفارش ردشده
    </button>
  );
  const restoreButton = (
    <button
      type="button"
      disabled={busy}
      onClick={() => onPatch(order.id, { archived_at: null })}
      className={BTN_GHOST_CLASS}
    >
      بازگردانی از بایگانی
    </button>
  );
  const deleteControls = confirmDelete ? (
    <div className="mt-2 rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
      <p className="text-xs text-[var(--dim)]">حذف قطعی سفارش ردشده انجام شود؟ این کار برگشت ندارد.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(order.id)}
          className="min-h-11 shrink-0 rounded-full bg-[var(--surface)] px-3.5 py-2 text-xs font-bold text-[var(--danger)] disabled:opacity-40"
        >
          حذف قطعی
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)} className={BTN_GHOST_CLASS}>
          انصراف
        </button>
      </div>
    </div>
  ) : (
    <button
      type="button"
      disabled={busy}
      onClick={() => setConfirmDelete(true)}
      className="min-h-11 shrink-0 rounded-full bg-[var(--surface)] px-3.5 py-2 text-xs font-bold text-[var(--danger)] disabled:opacity-40"
    >
      حذف سفارش ردشده
    </button>
  );

  return (
    <article className="glass overflow-hidden rounded-3xl">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={`مشخصات سفارش ${order.code}`}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-3 p-3 text-right"
      >
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-black text-white"
          style={{
            background:
              order.status === "payment_confirmed" || receiptReceived
                ? "linear-gradient(135deg, #0d9488, #2dd4bf)"
                : "linear-gradient(135deg, #1c39bb, #5b83f0)",
          }}
        >
          {statusLabel.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-[var(--text)]">
            <span dir="ltr">{order.code}</span>
            <span className="font-normal text-[var(--dim)]"> · {statusLabel}</span>
          </span>
          <span className="tnum mt-0.5 block truncate text-xs text-[var(--dim)]">
            {fmtTime(order.created_at)}
            {order.customer_name ? ` · ${order.customer_name}` : ""}
          </span>
        </span>
        <span className="tnum shrink-0 rounded-full bg-[var(--surface-alt)] px-2.5 py-1 text-xs text-[var(--text)]">
          {money(amountValue)}
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 text-sm text-[var(--dim)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {open ? (
        <div
          id={detailsId}
          className="mx-3 mb-3 border-t border-[var(--border)] pt-2"
        >
          <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <SpecRow label="خریدار" value={order.customer_name || ""} />
            <SpecRow label="موبایل" value={order.customer_phone || ""} ltr />
            <SpecRow label="زمان ثبت" value={fmtTime(order.created_at)} />
            <SpecRow label="وضعیت" value={statusLabel} />
            <SpecRow label="مبلغ" value={money(amountValue)} />
            <SpecRow label="شماره کارت" value={order.card_number || ""} ltr />
          </div>
          <p className="mt-1 text-sm text-[var(--text)]">{itemsText}</p>
          {order.note ? (
            <p className="mt-1 text-xs text-[var(--dim)]">توضیحات مشتری: {order.note}</p>
          ) : null}

          {order.status === "pending" && !archived ? (
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <div className="grid gap-2.5 sm:grid-cols-2">
                <div>
                  <label htmlFor={`amt-${order.id}`} className={LABEL_CLASS}>
                    مبلغ نهایی سفارش (تومان)
                  </label>
                  <div className="mt-2">
                    <input
                      id={`amt-${order.id}`}
                      inputMode="numeric"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={amountValue === null || amountValue === undefined ? "" : String(amountValue)}
                      className={FIELD_LTR_CLASS}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor={`card-${order.id}`} className={LABEL_CLASS}>
                    شماره کارت
                  </label>
                  <div className="mt-2">
                    <input
                      id={`card-${order.id}`}
                      dir="ltr"
                      value={card}
                      onChange={(e) => setCard(e.target.value)}
                      placeholder={order.card_number || cardNumber}
                      className={FIELD_LTR_CLASS}
                    />
                  </div>
                </div>
              </div>
              {approveDisabled && !busy ? (
                <p className="mt-2 text-xs text-[var(--dim)]">برای تایید، مبلغ نهایی و شماره کارت لازم است.</p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={approveDisabled}
                  onClick={() =>
                    onPatch(order.id, {
                      status: "approved",
                      final_amount_toman: effectiveAmount,
                      card_number: effectiveCard || null,
                    })
                  }
                  className={BTN_PRIMARY_CLASS}
                  style={BTN_PRIMARY_STYLE}
                >
                  تایید سفارش و ارسال شماره کارت
                </button>
                {rejectButton}
              </div>
            </div>
          ) : null}

          {order.status === "approved" && !receiptReceived ? (
            <div className="mt-3 rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
              <b className="block text-xs text-[var(--dim)]">در انتظار رسید پرداخت</b>
              <p className="mt-1 text-xs text-[var(--dim)]">وقتی رسید مشتری برسد، دکمه‌های تایید پرداخت و رد همین‌جا فعال می‌شوند.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" disabled className={BTN_GHOST_CLASS}>
                  در انتظار رسید پرداخت
                </button>
                {rejectButton}
              </div>
            </div>
          ) : null}

          {order.status === "payment_confirmed" ? (
            <div className="mt-3 rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
              <b className="block text-xs text-[var(--dim)]">پرداخت تایید شده است</b>
              <p className="mt-1 text-xs text-[var(--dim)]">اقدام دیگری برای این سفارش لازم نیست.</p>
            </div>
          ) : null}

          {order.status === "rejected" && !archived ? (
            <div className="mt-3 rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
              <b className="block text-xs text-[var(--dim)]">سفارش رد شده است</b>
              <p className="mt-1 text-xs text-[var(--dim)]">برای خلوت‌کردن صف فعال، آن را بایگانی کن؛ حذف فقط با تایید قطعی انجام می‌شود.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {archiveButton}
                {deleteControls}
              </div>
            </div>
          ) : null}

          {archived ? (
            <div className="mt-3 rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
              <b className="block text-xs text-[var(--dim)]">سفارش بایگانی شده است</b>
              <p className="mt-1 text-xs text-[var(--dim)]">این سفارش در صف فعال نیست؛ رکوردش برای سابقه نگه داشته شده است.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {restoreButton}
                {deleteControls}
              </div>
            </div>
          ) : null}

          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <h3 className="text-xs font-black text-[var(--text)]">پیام‌ها و رسید پرداخت</h3>
            {order.status === "approved" ? (
              <div className="mt-2 rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
                <b className="block text-xs text-[var(--dim)]">رسید پرداخت مشتری</b>
                {latestPaymentPhoto ? (
                  <>
                    <p className="mt-1">آخرین اسکرین‌شات رسید پرداخت · {fmtTime(latestPaymentPhoto.created_at)}</p>
                    {latestPaymentPhoto.body ? <p className="mt-1">{latestPaymentPhoto.body}</p> : null}
                    <img src={latestPaymentPhoto.photo_data as string} alt="اسکرین‌شات رسید پرداخت مشتری" className="mt-2 max-w-full rounded-xl" />
                  </>
                ) : receiptReceived ? (
                  <p className="mt-1 text-xs text-[var(--dim)]">رسید پرداخت ارسال شده است؛ در حال بارگذاری اسکرین‌شات…</p>
                ) : (
                  <p className="mt-1 text-xs text-[var(--dim)]">هنوز اسکرین‌شات رسید پرداختی ارسال نشده است.</p>
                )}
                <p className="mt-2 text-xs text-[var(--dim)]">تایید پرداخت فقط بعد از دیده‌شدن واریز در حساب بانکی باشد؛ اسکرین‌شات به‌تنهایی کافی نیست.</p>
                {receiptReceived ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {confirmPaymentButton}
                    {rejectButton}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="mt-2 flex flex-col gap-2">
              {!messagesLoaded && messages.length === 0 ? (
                <p className="text-xs text-[var(--dim)]">در حال بارگذاری پیام‌ها…</p>
              ) : messages.length === 0 ? (
                <p className="text-xs text-[var(--dim)]">هنوز پیامی نیست.</p>
              ) : messages.map((m) => {
                const custom = m.sender === "owner" ? parseCustomNotification(m.body) : null;
                return (
                <div key={m.id} className="rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
                  <b className="block text-xs text-[var(--dim)]">{custom ? "اعلان فروشگاه" : m.sender === "owner" ? "فروشگاه" : "مشتری"} · {fmtTime(m.created_at)}</b>
                  {custom ? (
                    <>
                      <p className="mt-1 font-bold">{custom.title}</p>
                      {custom.body ? <p className="mt-1">{custom.body}</p> : null}
                    </>
                  ) : m.body ? <p className="mt-1">{m.body}</p> : null}
                  {m.photo_data && m.photo_data.startsWith("data:image/") ? (
                    <>
                      {m.sender !== "owner" && (order.status === "approved" || order.status === "payment_confirmed") ? (
                        <b className="mt-2 block text-xs text-[var(--dim)]">اسکرین‌شات رسید پرداخت</b>
                      ) : null}
                      <img src={m.photo_data} alt="عکس پیام مشتری" className="mt-2 max-w-full rounded-xl" />
                    </>
                  ) : null}
                </div>
                );
              })}
            </div>
            {msgError ? <p className="mt-2 text-xs text-[var(--danger)]">{msgError}</p> : null}
            {notifyStatus ? <p className="mt-2 text-xs text-[var(--accent)]">{notifyStatus}</p> : null}
            <label htmlFor={`reply-${order.id}`} className={LABEL_CLASS}>
              پاسخ به مشتری
            </label>
            <div className="mt-2">
              <textarea
                id={`reply-${order.id}`}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                className={FIELD_LTR_CLASS}
                placeholder="پاسخت را بنویس…"
              />
            </div>
            <button type="button" disabled={msgBusy || reply.trim() === ""} onClick={sendReply} className={`${BTN_PRIMARY_CLASS} mt-2`} style={BTN_PRIMARY_STYLE}>
              ارسال پاسخ
            </button>
            {!archived ? (
              <div className="mt-3 rounded-2xl bg-[var(--surface-alt)] p-2.5">
                <b className="block text-xs text-[var(--dim)]">اعلان سفارشی به مشتری</b>
                <div className="mt-2">
                  <input
                    id={`notify-title-${order.id}`}
                    value={notifyTitle}
                    onChange={(e) => setNotifyTitle(e.target.value)}
                    placeholder="عنوان اعلان"
                    className={FIELD_LTR_CLASS}
                  />
                </div>
                <div className="mt-2">
                  <textarea
                    id={`notify-body-${order.id}`}
                    value={notifyBody}
                    onChange={(e) => setNotifyBody(e.target.value)}
                    rows={2}
                    className={FIELD_LTR_CLASS}
                    placeholder="متن اعلان…"
                  />
                </div>
                <button type="button" disabled={msgBusy || (notifyTitle.trim() === "" && notifyBody.trim() === "")} onClick={sendCustomNotification} className={`${BTN_GHOST_CLASS} mt-2`}>
                  ارسال اعلان به مشتری
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function QrScanSection({ onPatch, onDelete, busy }: { onPatch: (id: string, patch: Record<string, unknown>) => void; onDelete: (id: string) => void; busy: boolean }) {
  const [manual, setManual] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [scanned, setScanned] = useState<Order | null>(null);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  };
  useEffect(() => stop, []);

  const validate = async (text: string) => {
    try {
      const order = await data.ownerValidateQr(text);
      setScanned(order);
      setMessage({ text: "QR معتبر است؛ سفارش باز شد.", error: false });
      stop();
    } catch {
      setScanned(null);
      setMessage({ text: "QR معتبر نیست.", error: true });
    }
  };

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      const detector =
        "BarcodeDetector" in window
          ? new (window as unknown as { BarcodeDetector: new (o: unknown) => { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector({ formats: ["qr_code"] })
          : null;
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (codes && codes[0] && codes[0].rawValue) { await validate(codes[0].rawValue); return; }
          } else if (window.jsQR && video.videoWidth && canvasRef.current) {
            const canvas = canvasRef.current;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
              if (code && code.data) { await validate(code.data); return; }
            }
          }
        } catch { /* keep scanning */ }
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setMessage({ text: "دوربین در دسترس نیست؛ لینک یا توکن را دستی وارد کنید.", error: true });
      stop();
    }
  };

  return (
    <GlassSection title="اسکن QR سفارش" className="mt-3">
      <p className="mt-1 text-xs text-[var(--dim)]">
        QR روی رسید مشتری را اسکن کن تا سفارشش باز شود.
      </p>
      <video
        ref={videoRef}
        playsInline
        muted
        className="mt-2.5 w-full rounded-3xl border border-[var(--border)]"
        style={{ display: scanning ? "block" : "none" }}
      />
      <canvas ref={canvasRef} className="hidden" />
      <div className="mt-2.5 flex gap-2">
        {scanning ? (
          <button type="button" onClick={stop} className={BTN_GHOST_CLASS}>
            توقف اسکن
          </button>
        ) : (
          <button type="button" onClick={start} className={BTN_PRIMARY_CLASS} style={BTN_PRIMARY_STYLE}>
            شروع اسکن
          </button>
        )}
      </div>
      <div className="mt-2.5 flex gap-2">
        <input
          dir="ltr"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="لینک یا توکن QR"
          aria-label="ورود دستی لینک یا توکن QR"
          className={`${FIELD_LTR_CLASS} min-w-0 flex-1`}
        />
        <button type="button" onClick={() => validate(manual)} className={`${BTN_GHOST_CLASS} shrink-0`}>
          بررسی
        </button>
      </div>
      {message ? (
        <p className={`mt-2 text-xs ${message.error ? "text-[var(--danger)]" : "text-[var(--accent)]"}`} aria-live="polite">
          {message.text}
        </p>
      ) : null}
      {scanned ? (
        <div className="mt-2.5">
          <OrderCard order={scanned} cardNumber="" onPatch={onPatch} onDelete={onDelete} busy={busy} />
        </div>
      ) : null}
    </GlassSection>
  );
}

function OrdersPanel({ shop, onPatch, onDelete, onRefresh, busy }: { shop: ShopData; onPatch: (id: string, patch: Record<string, unknown>) => void; onDelete: (id: string) => void; onRefresh: () => void; busy: boolean }) {
  const [filter, setFilter] = useState<string>("active");
  const [notifyPerm, setNotifyPerm] = useState<string>(() => window.HelenNotify?.permission() || "unsupported");
  const [broadcastTitle, setBroadcastTitle] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastStatus, setBroadcastStatus] = useState<string | null>(null);
  const receipts = receiptOrderIds(shop.messages || []);
  const options = [
    { value: "active", label: "فعال" },
    { value: "pending", label: "در انتظار تایید" },
    { value: "payment_confirmed", label: "پرداخت تایید شد" },
    { value: "archived", label: "بایگانی" },
  ];
  const list = shop.orders
    .filter((o) => {
      if (filter === "archived") return isArchived(o);
      if (isArchived(o)) return false;
      return filter === "active" || o.status === filter;
    })
    .sort((a, b) => stageRank(a, receipts.has(a.id)) - stageRank(b, receipts.has(b.id)) || String(b.created_at).localeCompare(String(a.created_at)));
  const enableNotifications = async () => {
    const result = await window.HelenNotify?.requestPermission(data, { role: "owner" });
    setNotifyPerm(result?.permission || window.HelenNotify?.permission() || "unsupported");
    window.HelenNotify?.playBell?.();
  };
  useEffect(() => {
    if (notifyPerm === "granted") {
      window.HelenNotify?.refreshSubscription?.(data, { role: "owner" })?.catch(() => undefined);
    }
  }, [notifyPerm]);
  const sendBroadcast = async () => {
    const title = broadcastTitle.trim();
    const body = broadcastBody.trim();
    if (!title && !body) return;
    const targets = shop.orders.filter((o) => !isArchived(o) && o.status !== "rejected");
    if (targets.length === 0) {
      setBroadcastStatus("سفارش فعالی برای ارسال اعلان نیست.");
      return;
    }
    setBroadcastBusy(true);
    setBroadcastStatus(null);
    try {
      for (const order of targets) {
        await data.ownerSendOrderMessage(order.id, customNotificationBody(title, body), null);
      }
      setBroadcastTitle("");
      setBroadcastBody("");
      setBroadcastStatus(`اعلان برای ${fmt(targets.length)} سفارش فعال ارسال شد.`);
      onRefresh();
    } catch {
      setBroadcastStatus("ارسال اعلان همگانی انجام نشد.");
    } finally {
      setBroadcastBusy(false);
    }
  };
  return (
    <GlassSection ariaLabel="پنل سفارش‌ها">
      <div className="mb-2.5 rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
        <b className="block text-xs text-[var(--dim)]">اعلان‌های پنل</b>
        <p className="mt-1 text-xs text-[var(--dim)]">
          {notifyPerm === "granted" ? "اعلان سفارش، پیام و رسید پرداخت فعال است." : notifyPerm === "denied" ? "اعلان مرورگر بسته است؛ اعلان داخل پنل نشان داده می‌شود." : "برای سفارش جدید، پیام مشتری و رسید پرداخت اعلان بگیر."}
        </p>
        {notifyPerm !== "granted" ? (
          <button type="button" onClick={enableNotifications} className={`${BTN_GHOST_CLASS} mt-2`}>
            فعال کردن اعلان‌ها
          </button>
        ) : null}
      </div>
      <div className="mb-2.5 rounded-2xl bg-[var(--surface-alt)] p-2.5 text-sm text-[var(--text)]">
        <b className="block text-xs text-[var(--dim)]">اعلان سفارشی همگانی</b>
        <div className="mt-2">
          <input value={broadcastTitle} onChange={(e) => setBroadcastTitle(e.target.value)} placeholder="عنوان اعلان" className={FIELD_LTR_CLASS} />
        </div>
        <div className="mt-2">
          <textarea value={broadcastBody} onChange={(e) => setBroadcastBody(e.target.value)} rows={2} placeholder="متن اعلان برای مشتری‌های سفارش‌های فعال…" className={FIELD_LTR_CLASS} />
        </div>
        <button type="button" disabled={broadcastBusy || (broadcastTitle.trim() === "" && broadcastBody.trim() === "")} onClick={sendBroadcast} className={`${BTN_PRIMARY_CLASS} mt-2`} style={BTN_PRIMARY_STYLE}>
          ارسال اعلان همگانی
        </button>
        {broadcastStatus ? <p className="mt-2 text-xs text-[var(--dim)]">{broadcastStatus}</p> : null}
      </div>
      <div
        role="radiogroup"
        aria-label="فیلتر وضعیت سفارش"
        className="grid grid-cols-4 gap-1 rounded-full bg-[var(--surface-alt)] p-1"
      >
        {options.map((o) => {
          const active = filter === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setFilter(o.value)}
              className={`min-h-11 rounded-full px-3 py-2.5 text-sm font-bold transition active:scale-[0.98] ${
                active ? "text-white shadow" : "text-[var(--dim)]"
              }`}
              style={active ? BTN_PRIMARY_STYLE : undefined}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {list.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--dim)]">سفارشی نیست.</p>
      ) : (
        <div className="mt-2.5 space-y-2">
          {list.map((o) => (
            <OrderCard key={o.id} order={o} cardNumber={shop.settings.card_number} onPatch={onPatch} onDelete={onDelete} busy={busy} hasReceipt={receipts.has(o.id)} />
          ))}
        </div>
      )}
      <QrScanSection onPatch={onPatch} onDelete={onDelete} busy={busy} />
    </GlassSection>
  );
}

function ProductRow({
  product,
  onSave,
  busy,
}: {
  product: Product;
  onSave: (id: string, patch: { price_toman: number | null; stock_quantity: number | null; is_available: boolean }) => void;
  busy: boolean;
}) {
  const [price, setPrice] = useState(product.price_toman === null ? "" : String(product.price_toman));
  const [stock, setStock] = useState(product.stock_quantity === null ? "" : String(product.stock_quantity));
  const [available, setAvailable] = useState(product.is_available);
  useEffect(() => {
    setPrice(product.price_toman === null ? "" : String(product.price_toman));
    setStock(product.stock_quantity === null ? "" : String(product.stock_quantity));
    setAvailable(product.is_available);
  }, [product.price_toman, product.stock_quantity, product.is_available]);
  return (
    <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface-alt)] p-3 sm:p-3.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-black text-[var(--text)]">{product.name}</h3>
        <span className="tnum shrink-0 rounded-full bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--text)]">
          {data.productSellable(product) ? "موجود" : "ناموجود"}
        </span>
      </div>
      <p className="mt-0.5 block truncate text-xs text-[var(--dim)]">{product.description}</p>
      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
        <div>
          <label htmlFor={`price-${product.id}`} className={LABEL_CLASS}>
            قیمت (تومان)<span className={HINT_CLASS}> — خالی یعنی بدون قیمت</span>
          </label>
          <div className="mt-2">
            <input
              id={`price-${product.id}`}
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={FIELD_LTR_CLASS}
            />
          </div>
        </div>
        <div>
          <label htmlFor={`stock-${product.id}`} className={LABEL_CLASS}>
            موجودی (کیلوگرم)<span className={HINT_CLASS}> — خالی یعنی نامحدود</span>
          </label>
          <div className="mt-2">
            <input
              id={`stock-${product.id}`}
              inputMode="decimal"
              step="0.5"
              min="0"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              className={FIELD_LTR_CLASS}
            />
          </div>
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label={`وضعیت موجودی ${product.name}`}
        className="mt-2.5 grid grid-cols-2 gap-1 rounded-full bg-[var(--surface)] p-1"
      >
        {[
          { value: true, label: "موجود" },
          { value: false, label: "ناموجود" },
        ].map((o) => {
          const active = available === o.value;
          return (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setAvailable(o.value)}
              className={`min-h-11 rounded-full px-3 py-2.5 text-sm font-bold transition active:scale-[0.98] ${
                active ? "text-white shadow" : "text-[var(--dim)]"
              }`}
              style={active ? BTN_PRIMARY_STYLE : undefined}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const toEn = (v: string) =>
              v
                .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
                .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
            const priceDigits = toEn(price).replace(/[^0-9]/g, "");
            const stockRaw = toEn(stock).replace(/[^0-9.]/g, "");
            onSave(product.id, {
              price_toman: price.trim() === "" ? null : Number(priceDigits),
              stock_quantity: stock.trim() === "" ? null : Number(stockRaw),
              is_available: available,
            });
          }}
          className={BTN_PRIMARY_CLASS}
          style={BTN_PRIMARY_STYLE}
        >
          ذخیره
        </button>
      </div>
    </div>
  );
}

function ProductsPanel({
  shop,
  onSaveProduct,
  onSaveCard,
  onLogout,
  busy,
}: {
  shop: ShopData;
  onSaveProduct: (id: string, patch: { price_toman: number | null; stock_quantity: number | null; is_available: boolean }) => void;
  onSaveCard: (card: string) => void;
  onLogout: () => void;
  busy: boolean;
}) {
  const [card, setCard] = useState(shop.settings.card_number || "");
  useEffect(() => setCard(shop.settings.card_number || ""), [shop.settings.card_number]);
  return (
    <>
      <GlassSection ariaLabel="پنل محصولات">
        <div className="space-y-2.5">
          {shop.products.map((p) => (
            <ProductRow key={p.id} product={p} onSave={onSaveProduct} busy={busy} />
          ))}
        </div>
      </GlassSection>
      <GlassSection title="شماره کارت فروشگاه" className="mt-3">
        <div className="mt-2.5">
          <label htmlFor="shop-card" className={LABEL_CLASS}>
            شماره کارت
          </label>
          <div className="mt-2">
            <input
              id="shop-card"
              dir="ltr"
              inputMode="numeric"
              value={card}
              onChange={(e) => setCard(e.target.value)}
              className={FIELD_LTR_CLASS}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSaveCard(card.trim())}
            className={BTN_PRIMARY_CLASS}
            style={BTN_PRIMARY_STYLE}
          >
            ذخیره شماره کارت
          </button>
          <button type="button" onClick={onLogout} className={BTN_GHOST_CLASS}>
            خروج
          </button>
        </div>
      </GlassSection>
    </>
  );
}

type DayRow = { day: string; total: number; mobile: number; desktop: number };

function last7Days(orders: Order[]): DayRow[] {
  const days: DayRow[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayOrders = orders.filter((o) => {
      const od = new Date(o.created_at);
      return od.getFullYear() === d.getFullYear() && od.getMonth() === d.getMonth() && od.getDate() === d.getDate();
    });
    days.push({
      day: key,
      total: dayOrders.length,
      mobile: dayOrders.filter((o) => o.status === "payment_confirmed").length,
      desktop: dayOrders.filter((o) => o.status !== "payment_confirmed").length,
    });
  }
  return days;
}

function StatsPanel({ shop, onPatch, onDelete, busy }: { shop: ShopData; onPatch: (id: string, patch: Record<string, unknown>) => void; onDelete: (id: string) => void; busy: boolean }) {
  const [showAllLog, setShowAllLog] = useState(false);
  const orders = shop.orders;
  const receipts = receiptOrderIds(shop.messages || []);
  const pending = orders.filter((o) => o.status === "pending").length;
  const confirmed = orders.filter((o) => o.status === "payment_confirmed").length;
  const days = last7Days(orders);
  const weekTotal = days.reduce((acc, d) => acc + d.total, 0);
  const weekConfirmed = days.reduce((acc, d) => acc + d.mobile, 0);
  const weekOther = days.reduce((acc, d) => acc + d.desktop, 0);
  const peak = days.reduce<DayRow | null>((best, d) => (best === null || d.total > best.total ? d : best), null);
  const statusEntries: Record<string, number> = {};
  orders.forEach((o) => {
    const label = STATUS_LABEL[o.status] ?? o.status;
    statusEntries[label] = (statusEntries[label] || 0) + 1;
  });
  const itemEntries: Record<string, number> = {};
  orders.forEach((o) =>
    (o.items || []).forEach((i) => {
      itemEntries[i.name] = (itemEntries[i.name] || 0) + Number(i.quantity);
    }),
  );
  const visibleLog = showAllLog ? orders : orders.slice(0, 8);
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <div
          className="rounded-3xl p-3 text-white shadow-lg"
          style={{ background: "linear-gradient(135deg, #0d9488 0%, #1c39bb 130%)" }}
        >
          <p className="text-xs font-bold text-white/75">کل سفارش‌ها</p>
          <p className="tnum mt-1.5 text-2xl font-black leading-none sm:text-3xl">{fmt(orders.length)}</p>
        </div>
        <div
          className="rounded-3xl p-3 text-white shadow-lg"
          style={{ background: "linear-gradient(135deg, #059669 0%, #0e7490 100%)" }}
        >
          <p className="text-xs font-bold text-white/75">در انتظار تایید</p>
          <p className="tnum mt-1.5 text-2xl font-black leading-none sm:text-3xl">{fmt(pending)}</p>
        </div>
        <div
          className="rounded-3xl p-3 text-white shadow-lg"
          style={{ background: "linear-gradient(135deg, #1c39bb 0%, #0ea5e9 140%)" }}
        >
          <p className="text-xs font-bold text-white/75">پرداخت تایید شد</p>
          <p className="tnum mt-1.5 text-2xl font-black leading-none sm:text-3xl">{fmt(confirmed)}</p>
        </div>
      </div>

      <p className="tnum mt-2.5 text-xs text-[var(--dim)]">
        این هفته: {fmt(weekTotal)} سفارش · {fmt(weekConfirmed)} پرداخت تاییدشده · {fmt(weekOther)} بقیه
        {peak && peak.total > 0 ? ` · پُرسفارش‌ترین روز: ${fmtDay(peak.day)} با ${fmt(peak.total)} سفارش` : ""}
      </p>

      <GlassSection title="سفارش روزانه — ۷ روز اخیر" className="mt-3">
        <div dir="ltr" className="mt-2.5 h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={days} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
              <defs>
                <linearGradient id="gradMobile" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2dd4bf" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#2dd4bf" stopOpacity={0.12} />
                </linearGradient>
                <linearGradient id="gradDesktop" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5b83f0" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#1c39bb" stopOpacity={0.15} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="day"
                tickFormatter={(v: string) => fmtDayShort(v)}
                tick={{ fontSize: 11, fill: "var(--dim)" }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
              />
              <YAxis
                domain={[0, "auto"]}
                allowDecimals={false}
                tickFormatter={(v: number) => fmt(v)}
                tick={{ fontSize: 11, fill: "var(--dim)" }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--border)", strokeWidth: 1 }} />
              <Legend
                formatter={(value: string) => <span style={{ color: "var(--text)", fontSize: 12 }}>{value}</span>}
              />
              <Area type="monotone" dataKey="mobile" name="پرداخت تایید شد" stackId="visits" stroke="#2dd4bf" strokeWidth={2} fill="url(#gradMobile)" />
              <Area type="monotone" dataKey="desktop" name="بقیه" stackId="visits" stroke="#5b83f0" strokeWidth={2} fill="url(#gradDesktop)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <ul className="mt-2 space-y-1">
          {[...days].reverse().map((d) => (
            <li
              key={d.day}
              className="tnum flex items-baseline justify-between border-t border-[var(--border)] pt-1.5 text-xs text-[var(--dim)] first:border-t-0"
            >
              <span className="text-[var(--text)]">{fmtDay(d.day)}</span>
              <span>
                {fmt(d.total)} سفارش · {fmt(d.mobile)} پرداخت تاییدشده · {fmt(d.desktop)} بقیه
              </span>
            </li>
          ))}
        </ul>
      </GlassSection>

      <div className="glass mt-3 grid grid-cols-1 gap-x-8 rounded-[24px] px-3.5 sm:grid-cols-2 sm:px-4">
        <Breakdown title="وضعیت سفارش‌ها" kind="device" entries={statusEntries} />
        <Breakdown title="اقلام سفارش‌ها" kind="device" entries={itemEntries} />
      </div>

      <GlassSection title="سفارش‌های اخیر" className="mt-3">
        <p className="mt-1 text-xs text-[var(--dim)]">
          روی هر کارت بزن تا مشخصات کاملش باز شود؛ ساعت‌ها به وقت تهران‌اند.
        </p>
        {orders.length === 0 ? (
          <p className="mt-2.5 text-sm text-[var(--dim)]">
            هنوز سفارشی ثبت نشده است؛ کارت هر سفارش بعد از ثبتش اینجا می‌آید.
          </p>
        ) : (
          <div className="mt-2.5 space-y-2">
            {orders.slice(0, 8).map((o) => (
              <OrderCard key={o.id} order={o} cardNumber={shop.settings.card_number} onPatch={onPatch} onDelete={onDelete} busy={busy} hasReceipt={receipts.has(o.id)} />
            ))}
          </div>
        )}
      </GlassSection>

      <GlassSection title="لاگ سفارش‌ها" className="mt-3">
        {orders.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--dim)]">هنوز رکوردی ثبت نشده است.</p>
        ) : (
          <>
            <ul className="mt-1.5">
              {visibleLog.map((o) => (
                <li
                  key={o.id}
                  className="tnum flex items-baseline justify-between gap-3 border-t border-[var(--border)] py-2 text-sm first:border-t-0"
                >
                  <span className="text-[var(--dim)]">{fmtTime(o.created_at)}</span>
                  <span className="text-[var(--text)]">
                    <span dir="ltr">{o.code}</span> · {STATUS_LABEL[o.status] ?? o.status}
                  </span>
                </li>
              ))}
            </ul>
            {orders.length > visibleLog.length || showAllLog ? (
              <button
                type="button"
                aria-expanded={showAllLog}
                onClick={() => setShowAllLog((v) => !v)}
                className="mt-1 min-h-11 w-full rounded-full text-sm font-bold text-[var(--accent)] transition active:scale-[0.98]"
              >
                {showAllLog ? "نمایش کمتر" : `نمایش همه (${fmt(orders.length)} رکورد)`}
              </button>
            ) : null}
          </>
        )}
      </GlassSection>
    </>
  );
}

type TabId = "stats" | "orders" | "products";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "stats", label: "آمار" },
  { id: "orders", label: "سفارش‌ها" },
  { id: "products", label: "محصولات" },
];

function TabIcon({ name }: { name: TabId }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
  if (name === "stats") {
    return (
      <svg {...common}>
        <path d="M3 3v16a2 2 0 0 0 2 2h16" />
        <path d="M7 14v3" />
        <path d="M12 9v8" />
        <path d="M17 5v12" />
      </svg>
    );
  }
  if (name === "orders") {
    return (
      <svg {...common}>
        <rect x="2" y="5" width="20" height="14" rx="3" />
        <path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [authed, setAuthed] = useState(Boolean(data.getSession()));
  const [tab, setTab] = useState<TabId>("stats");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const shop = useQuery({
    queryKey: ["shop"],
    queryFn: async (): Promise<ShopData> => {
      const [products, orders, settings, messages] = await Promise.all([
        data.getProducts(),
        data.listOrders(),
        data.getSettings(),
        data.listRecentOrderMessages(100).catch(() => [] as OrderMessage[]),
      ]);
      return { products, orders, settings, messages };
    },
    enabled: authed,
    refetchInterval: 20000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["shop"] });
  const patchOrder = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => data.updateOrder(id, patch),
    onSuccess: invalidate,
  });
  const deleteOrder = useMutation({
    mutationFn: (id: string) => data.deleteOrder(id),
    onSuccess: invalidate,
  });
  const saveProduct = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { price_toman: number | null; stock_quantity: number | null; is_available: boolean } }) =>
      data.updateProduct(id, patch),
    onSuccess: invalidate,
  });
  const saveCard = useMutation({
    mutationFn: (card: string) => data.saveSettings({ card_number: card }),
    onSuccess: invalidate,
  });
  const busy = patchOrder.isPending || deleteOrder.isPending || saveProduct.isPending || saveCard.isPending;
  const notifySeenRef = useRef<{ initialized: boolean; orderIds: Set<string>; messageIds: Set<string> }>({ initialized: false, orderIds: new Set(), messageIds: new Set() });
  useEffect(() => {
    if (!authed || !shop.data) return;
    const seen = notifySeenRef.current;
    const orders = shop.data.orders || [];
    const messages = shop.data.messages || [];
    if (!seen.initialized) {
      seen.orderIds = new Set(orders.map((o) => o.id));
      seen.messageIds = new Set(messages.map((m) => m.id));
      seen.initialized = true;
      return;
    }
    for (const order of orders) {
      if (!seen.orderIds.has(order.id)) {
        seen.orderIds.add(order.id);
        void window.HelenNotify?.show("سفارش جدید", `سفارش ${order.code} ثبت شد.`, { key: `owner-order-${order.id}`, tag: `owner-order-${order.id}`, url: location.href });
      }
    }
    for (const m of [...messages].reverse()) {
      if (seen.messageIds.has(m.id)) continue;
      seen.messageIds.add(m.id);
      if (m.sender === "owner") continue;
      const receipt = isPaymentReceiptMessage(m);
      void window.HelenNotify?.show(
        receipt ? "رسید پرداخت رسید" : "پیام جدید مشتری",
        receipt ? `رسید پرداخت سفارش ${m.order_code} ارسال شد.` : `برای سفارش ${m.order_code} پیام جدید آمد.`,
        { key: `owner-message-${m.id}`, tag: `owner-message-${m.id}`, url: location.href },
      );
    }
  }, [authed, shop.data]);

  useEffect(() => {
    const err = shop.error as { status?: number } | null;
    if (authed && err && err.status === 401) {
      void data.logout();
      setAuthed(false);
      setLoginError("نشست منقضی شده؛ دوباره وارد شو.");
    }
  }, [authed, shop.error]);

  const doLogin = async () => {
    setLoginError(null);
    try {
      await data.login(username.trim(), password);
      setPassword("");
      setAuthed(true);
      invalidate();
    } catch {
      setLoginError("نام کاربری یا رمز عبور درست نیست.");
    }
  };
  const doLogout = async () => {
    await data.logout();
    setAuthed(false);
  };

  const shopData = shop.data ?? null;
  const updatedAt = shopData?.orders[0]?.created_at ?? null;

  return (
    <div
      dir="rtl"
      lang="fa"
      className="min-h-screen overflow-x-clip [background:var(--page-grad)]"
    >
      <SafeAreaTopScrim backgroundColor="transparent" />

      <main className="mx-auto w-full max-w-3xl px-3 pb-6 pt-3 sm:px-4 sm:pt-4">
        {/* Header — a floating Liquid Glass bar */}
        <div className="glass-deep flex max-w-full items-center justify-between gap-3 overflow-hidden rounded-full py-2 pl-2 pr-5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-black text-[var(--text)]">
              پنل کنترل سایت
            </h1>
            <p className="tnum mt-0.5 truncate text-xs text-[var(--dim)]">
              {authed
                ? shop.isError
                  ? "اتصال ناموفق بود"
                  : updatedAt
                    ? `آخرین سفارش: ${fmtTime(updatedAt)}`
                    : shop.isPending
                      ? "در حال اتصال به فروشگاه…"
                      : "متصل به فروشگاه"
                : "ورود مالک"}
            </p>
          </div>
          {authed ? (
            <button
              type="button"
              aria-label="به‌روزرسانی"
              onClick={() => shop.refetch()}
              disabled={shop.isFetching}
              className={`${BTN_PRIMARY_CLASS} shrink-0`}
              style={BTN_PRIMARY_STYLE}
            >
              {shop.isFetching ? "در حال دریافت…" : "↻ به‌روزرسانی"}
            </button>
          ) : null}
        </div>

        {!authed ? (
          <GlassSection title="ورود مالک" className="mt-3.5">
            <div className="mt-2.5">
              <label htmlFor="owner-username" className={LABEL_CLASS}>
                نام کاربری
              </label>
              <div className="mt-2">
                <input
                  id="owner-username"
                  dir="ltr"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={FIELD_LTR_CLASS}
                />
              </div>
            </div>
            <div className="mt-2.5">
              <label htmlFor="owner-password" className={LABEL_CLASS}>
                رمز عبور
              </label>
              <div className="mt-2">
                <input
                  id="owner-password"
                  type="password"
                  dir="ltr"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") doLogin();
                  }}
                  className={FIELD_LTR_CLASS}
                />
              </div>
            </div>
            {loginError ? (
              <p className="mt-3 rounded-3xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--danger)]">
                {loginError}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3.5">
              <button
                type="button"
                onClick={doLogin}
                className={BTN_PRIMARY_CLASS}
                style={BTN_PRIMARY_STYLE}
              >
                ورود
              </button>
            </div>
          </GlassSection>
        ) : shop.isPending ? (
          <div className="py-10 text-center" aria-live="polite">
            <p className="text-sm text-[var(--dim)]">در حال دریافت اطلاعات فروشگاه…</p>
          </div>
        ) : shop.isError || !shopData ? (
          <div className="py-10 text-center">
            <p className="text-sm text-[var(--danger)]">دریافت اطلاعات فروشگاه ناموفق بود. اتصال اینترنت را بررسی کن و دوباره تلاش کن.</p>
            <button
              type="button"
              aria-label="تلاش دوباره برای دریافت اطلاعات فروشگاه"
              onClick={() => shop.refetch()}
              className={`mt-4 ${BTN_PRIMARY_CLASS}`}
              style={BTN_PRIMARY_STYLE}
            >
              تلاش دوباره
            </button>
          </div>
        ) : (
          <>
            {/* Tab bar — sticky glass pill; each section lives in its tab. */}
            <div
              role="tablist"
              aria-label="بخش‌های پنل کنترل"
              className="glass-deep sticky top-3 z-20 mt-3 grid grid-cols-3 gap-1 rounded-full p-1"
            >
              {TABS.map((t) => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`tab-${t.id}`}
                    aria-selected={active}
                    aria-controls={`panel-${t.id}`}
                    aria-label={t.label}
                    onClick={() => setTab(t.id)}
                    className={`flex min-h-11 items-center justify-center gap-1.5 rounded-full px-2 py-2.5 text-sm font-bold transition active:scale-[0.98] ${
                      active ? "text-white shadow" : "text-[var(--dim)]"
                    }`}
                    style={active ? BTN_PRIMARY_STYLE : undefined}
                  >
                    <TabIcon name={t.id} />
                    {t.label}
                  </button>
                );
              })}
            </div>

            <div
              role="tabpanel"
              id="panel-stats"
              aria-labelledby="tab-stats"
              hidden={tab !== "stats"}
              className="mt-3.5"
            >
              <StatsPanel shop={shopData} onPatch={(id, patch) => patchOrder.mutate({ id, patch })} onDelete={(id) => deleteOrder.mutate(id)} busy={busy} />
            </div>
            <div
              role="tabpanel"
              id="panel-orders"
              aria-labelledby="tab-orders"
              hidden={tab !== "orders"}
              className="mt-3.5"
            >
              <OrdersPanel shop={shopData} onPatch={(id, patch) => patchOrder.mutate({ id, patch })} onDelete={(id) => deleteOrder.mutate(id)} onRefresh={invalidate} busy={busy} />
            </div>
            <div
              role="tabpanel"
              id="panel-products"
              aria-labelledby="tab-products"
              hidden={tab !== "products"}
              className="mt-3.5"
            >
              <ProductsPanel
                shop={shopData}
                onSaveProduct={(id, patch) => saveProduct.mutate({ id, patch })}
                onSaveCard={(card) => saveCard.mutate(card)}
                onLogout={doLogout}
                busy={busy}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
