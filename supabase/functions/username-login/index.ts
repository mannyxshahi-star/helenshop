// HelenShop username login Edge Function.
// Deploy this function in Supabase. It resolves username -> owner email on the
// server only, then asks Supabase Auth to verify the password. The browser
// never receives the username/email map and never sees a service role key.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function invalid(): Response {
  // Generic on purpose: do not reveal whether the username exists.
  return json({ error: "invalid_credentials" }, 401);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return invalid();

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "server_not_configured" }, 500);

  let username = "";
  let password = "";
  try {
    const body = await req.json();
    username = String(body.username || "").trim();
    password = String(body.password || "");
  } catch {
    return invalid();
  }
  if (!username || !password) return invalid();

  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&select=email,is_owner&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!profileRes.ok) return invalid();
  const profiles = await profileRes.json().catch(() => []);
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profile || profile.is_owner !== true || !profile.email) return invalid();

  const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: profile.email, password }),
  });
  if (!authRes.ok) return invalid();

  const session = await authRes.json().catch(() => null);
  if (!session || !session.access_token) return invalid();

  return json({
    access_token: session.access_token,
    refresh_token: session.refresh_token || null,
    expires_at: session.expires_at || null,
    user: session.user ? { id: session.user.id, email: session.user.email } : { username },
  });
});
