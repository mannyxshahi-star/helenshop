# HelenShop site

Static GitHub Pages front end plus Supabase live data and owner control.

Files:

- `index.html` — public RTL Persian shop. This is a literal copy of the `mannyshop` Space UI (HTML/CSS/JS copied as-is, product photos embedded); only backend wiring was added: live price/stock/availability from Supabase, backend order creation with MS code + QR on the receipt, and order tracking.
- `control.html` — owner control (username + password login). The UI is copied from the `site-stats` Space (same layout, glass sections, gradient tiles, chart, breakdowns and tab bar; source kept in `control-src/`, compiled bundle in `assets/control.js` + `assets/site-stats.css`), wired to HelenShop orders/products.
- `assets/config.js` — public Supabase URL and anon key.
- `assets/data.js` — data layer for Supabase REST/RPC and local demo tests.
- `assets/qrcodegen.js` — local QR generator (Project Nayuki, MIT). QR codes are generated in the browser; tokens are not sent to a QR service.
- `assets/jsQR.js` and `assets/jsQR.LICENSE.txt` — local QR scanner fallback (jsQR 1.4.0, Apache-2.0).
- `supabase/schema.sql` — tables, seed products, RPCs, and RLS policies.
- `supabase/migration-numeric-quantities.sql` — run once in the Supabase SQL editor so half-kilo quantities from the shop UI are accepted (stock/quantity columns become numeric).
- `supabase/functions/username-login/index.ts` — server-side username login function.

## Shop rules built in

- Only six products are seeded: کشک، قارا، روغن حیوانی (white goat oil), ماست، کره‌ی محلی (goat/white), عسل.
- Prices start as `null`, so the shop shows no price until the owner sets one in control.
- Pickup only: «تحویل درب محل».
- Order flow: customer orders → `MS-######` code + QR → owner approves and gives card number → customer pays → owner confirms → customer sees «پرداخت تایید شد».
- The invoice shows one of Manny's three slogans at random.

## Secure order tracking and QR

The visible code is `MS-######`, generated server-side with cryptographic randomness and collision checks. It is not a sequential ID.

At order creation the server also creates a 32-byte random order token. Only the SHA-256 hash of that token is stored in `orders.token_hash`. The raw token is returned once to the customer browser and encoded in the invoice QR/link.

Status lookup is deliberately narrow:

- QR/link lookup: `?code=MS-123456&token=...` works only when the token hash matches.
- Manual lookup: code + the phone number used on the order.
- Wrong code, wrong token, wrong phone, and rate-limited attempts all return the same generic “not found” result.
- Failed lookups are recorded per code; after 10 failures in 15 minutes, further lookups for that code return nothing until the window passes.

The control scanner is inside the logged-in owner panel only. It uses `BarcodeDetector` when available, falls back to bundled `jsQR`, and also accepts a pasted tracking link/token. A scanned token is validated server-side by `owner_get_order_by_token`, which checks the stored hash and owner RLS. A tampered or foreign QR returns a generic invalid result.

## Supabase setup

1. Create a Supabase project for HelenShop.
2. Open SQL Editor and run `supabase/schema.sql`.
3. In Authentication → Providers → Email, keep email/password enabled.
4. In Authentication settings, disable public sign-ups. The shop must not allow strangers to create accounts.
5. Create the owner user manually in Authentication → Users with an email and a strong password. Supabase Auth stores and hashes the password; this repo never stores it.
6. Insert the owner profile row so the username maps to that Auth user and RLS recognizes the owner:

```sql
insert into public.profiles (id, username, email, is_owner)
select id, 'YOUR_USERNAME', email, true
from auth.users
where email = 'YOUR_OWNER_EMAIL'
on conflict (id) do update
set username = excluded.username, email = excluded.email, is_owner = true;
```

7. Deploy the username login function:

```bash
supabase functions deploy username-login
```

The function uses Supabase-provided server environment values (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) inside Supabase only. Do not copy the service role key into this repo or into `assets/config.js`.

8. Copy the project URL and anon/public key from Project Settings → API into `assets/config.js`:

```js
window.HELENSHOP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",
  DEMO_MODE: false
};
```

9. Enable MFA/TOTP for the owner if your Supabase plan/project exposes it: Authentication → MFA / factors for the owner user, enroll an authenticator app, and keep recovery codes offline. If MFA is not available in the dashboard for the project, use a long unique password and keep sign-ups disabled.

## Changing username or password

- Password: change it for the owner user in Supabase Authentication → Users, or use Supabase Auth password recovery for that owner email. Do not put the password in GitHub, README, or front-end code.
- Username: update the owner row in `public.profiles`:

```sql
update public.profiles
set username = 'NEW_USERNAME'
where email = 'YOUR_OWNER_EMAIL' and is_owner = true;
```

- If the owner email changes in Auth, update `public.profiles.email` to match.

## GitHub Pages publish

Publish this folder as the site root or under a `/helenshop/` subpath. All asset paths are relative, so both work.

Typical GitHub Pages path:

1. Put these files in the repository/folder that GitHub Pages serves.
2. In GitHub → Settings → Pages, choose the branch/folder that contains `index.html`.
3. Open the published `index.html` and `control.html` on a phone.
4. Confirm `assets/config.js` contains the real Supabase URL and anon key before publishing.

## Security model

Treat the GitHub repository and every front-end file as public.

Allowed in front-end code:

- Supabase project URL.
- Supabase anon/public key.

Never commit:

- Owner password.
- Supabase service role key.
- Private tokens, `.env` files, recovery codes, or card-number secrets beyond what the owner intentionally saves in Supabase settings.

Enforcement is in Supabase, not in the page:

- RLS is enabled on all tables.
- Public anon users can select products.
- Public order creation and status lookup go through security-definer RPCs with validation, token hashing, and rate limiting.
- Direct order table reads/writes are not granted to anon users.
- Product writes, order admin reads/writes, settings writes, and profile writes require an authenticated user with `profiles.is_owner = true`.
- The control page hides the panel until login, but that is only UI. A forged browser state still fails at RLS/RPC checks.
- Username → email resolution happens only in the `username-login` Edge Function using server-side credentials. Public code contains no username/email map. Login errors are generic.

If a secret is ever committed by mistake: rotate it immediately. For Supabase, rotate the service role/JWT secret from project API settings as applicable, change the owner password, revoke sessions, update `assets/config.js` with the new anon key if it changed, and remove the secret from Git history. Removing the file in a later commit is not enough.

## Demo mode

Demo mode is for local verification only. Open `index.html?demo=1` or `control.html?demo=1` to use browser-local sample storage. Demo mode is clearly labeled in the UI, does not contact Supabase, and must not be treated as production security or live data.

Without Supabase keys and without `?demo=1`, the site shows a setup-required notice and the control login stays inactive.

## Local verification

Serve the folder locally, then open:

- `index.html?demo=1`
- `control.html?demo=1`

Check on a phone-width dark viewport: products render, cart/order creation returns an `MS-######` code and QR, wrong token/code+phone lookups fail generically, control edits change price/stock/availability in demo storage, and the scanner section is hidden before login.
