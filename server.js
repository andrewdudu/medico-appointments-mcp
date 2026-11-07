#!/usr/bin/env node
// Read-only MCP server over the medico-service Postgres `appointments` table.
// stdio by default; set PORT to serve Streamable HTTP with medico-service JWT auth (plus OAuth sign-in with MEDICO_LOGIN_URL).
import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { z } from "zod";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/medico",
  // Every session is read-only, so no tool can modify data even by mistake.
  options: "-c default_transaction_read_only=on",
});

// started_at / ended_at / updated_date are stored as epoch milliseconds.
const toMillis = (s) => {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${s}`);
  return ms;
};
const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

const SELECT = `
  SELECT a.id, a.outlet_id, o.name AS outlet_name, a.patient_id, a.patient_name, a.phone_number,
         a.doctor_id, d.name AS doctor_name, a.admin_id, ad.name AS admin_name,
         a.status, a.started_at, a.ended_at, a.notes, a.updated_date, a.updated_by
  FROM appointments a
  LEFT JOIN users d ON d.id = a.doctor_id
  LEFT JOIN users ad ON ad.id = a.admin_id
  LEFT JOIN outlets o ON o.id = a.outlet_id`;

const shape = (r) => ({
  ...r,
  started_at: iso(r.started_at),
  ended_at: iso(r.ended_at),
  updated_date: iso(r.updated_date),
});

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

// allowedOutlets: null = unrestricted (local stdio), otherwise the outlet ids the caller may read.
function createServer(allowedOutlets) {
  // Returns the outlet ids to filter on, or null for no filter.
  const scope = (outletId) => {
    if (outletId && allowedOutlets && !allowedOutlets.includes(outletId)) {
      throw new Error(`No APPOINTMENT_MONITORING access to outlet ${outletId}`);
    }
    return outletId ? [outletId] : allowedOutlets;
  };

  const server = new McpServer({ name: "medico-appointments", version: "1.2.0" });

  server.registerTool(
    "list_appointments",
    {
      description:
        "List appointments, newest first. Filter by outlet, start-time range, status, doctor or patient. " +
        "Dates are ISO 8601; include a timezone offset (e.g. 2026-11-07T00:00:00+07:00) to avoid UTC interpretation.",
      inputSchema: {
        outlet_id: z.string().optional(),
        from: z.string().optional().describe("Appointments starting at or after this time"),
        to: z.string().optional().describe("Appointments starting at or before this time"),
        status: z.enum(["OPENED", "COMPLETED", "CANCELED"]).optional(),
        doctor_id: z.string().optional(),
        patient_id: z.string().optional(),
        patient_name: z.string().optional().describe("Case-insensitive partial match"),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async (a) => {
      const where = [];
      const params = [];
      const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
      const outlets = scope(a.outlet_id);
      if (outlets) add("a.outlet_id = ANY(?)", outlets);
      if (a.from) add("a.started_at >= ?", toMillis(a.from));
      if (a.to) add("a.started_at <= ?", toMillis(a.to));
      if (a.status) add("a.status = ?", a.status);
      if (a.doctor_id) add("a.doctor_id = ?", a.doctor_id);
      if (a.patient_id) add("a.patient_id = ?", a.patient_id);
      if (a.patient_name) add("a.patient_name ILIKE ?", `%${a.patient_name}%`);
      params.push(a.limit);
      const { rows } = await pool.query(
        `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.started_at DESC LIMIT $${params.length}`,
        params,
      );
      return json(rows.map(shape));
    },
  );

  server.registerTool(
    "get_appointment",
    { description: "Get one appointment by id.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const { rows } = await pool.query(`${SELECT} WHERE a.id = $1 AND ($2::text[] IS NULL OR a.outlet_id = ANY($2))`, [id, allowedOutlets]);
      return rows.length ? json(shape(rows[0])) : { content: [{ type: "text", text: `No appointment ${id}` }], isError: true };
    },
  );

  server.registerTool(
    "count_appointments_by_day",
    {
      description: "Count appointments per day (and per status) in a start-time range, optionally for one outlet.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        outlet_id: z.string().optional(),
        timezone: z.string().default("Asia/Jakarta").describe("IANA zone used to bucket days"),
      },
    },
    async ({ from, to, outlet_id, timezone }) => {
      const { rows } = await pool.query(
        `SELECT to_char(to_timestamp(started_at / 1000.0) AT TIME ZONE $3, 'YYYY-MM-DD') AS day, status, COUNT(*)::int AS count
         FROM appointments
         WHERE started_at BETWEEN $1 AND $2 AND ($4::text[] IS NULL OR outlet_id = ANY($4))
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [toMillis(from), toMillis(to), timezone, scope(outlet_id)],
      );
      return json(rows);
    },
  );

  server.registerTool(
    "list_outlets",
    { description: "List outlets (clinics) you can read, so you can find an outlet_id.", inputSchema: {} },
    async () => {
      const { rows } = await pool.query(
        "SELECT id, code, name, city FROM outlets WHERE NOT mark_for_delete AND ($1::text[] IS NULL OR id = ANY($1)) ORDER BY name",
        [allowedOutlets],
      );
      return json(rows);
    },
  );

  return server;
}

// --- medico-service auth (mirrors TokenHelper / SecurityCipher / ServerRequestHelper) ---

const { JWT_SECRET, COOKIE_SECRET, MEDICO_LOGIN_URL, PUBLIC_URL } = process.env;

// jjwt 0.9.0 base64-decodes the secret with DatatypeConverter, which ignores a trailing partial group
// ("tokensecret" -> 6 bytes); Node's decoder would keep it, so cut to whole 4-char groups first.
const jjwtKey = (secret) => {
  const clean = secret.replace(/[^A-Za-z0-9+/=]/g, "");
  return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
};

// Returns { sub, exp } if token is a valid, unexpired HS512 JWT, else null.
function verifyJwt(token, secret, now = Date.now()) {
  const [h, p, sig, extra] = token.split(".");
  if (!h || !p || !sig || extra !== undefined) return null;
  try {
    if (JSON.parse(Buffer.from(h, "base64url")).alg !== "HS512") return null;
    const expected = crypto.createHmac("sha512", jjwtKey(secret)).update(`${h}.${p}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    const claims = JSON.parse(Buffer.from(p, "base64url"));
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    return typeof claims.sub === "string" ? { sub: claims.sub, exp: claims.exp } : null;
  } catch {
    return null;
  }
}

// The browser `accessToken` cookie holds the JWT AES/ECB-encrypted with SHA-1(cookieSecret)[0..16].
function decryptCookie(value, cookieSecret) {
  try {
    const key = crypto.createHash("sha1").update(cookieSecret, "utf8").digest().subarray(0, 16);
    const d = crypto.createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([d.update(Buffer.from(value, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// Token may be the raw JWT or the `accessToken` cookie value. Returns { outlets, exp }, or null if unauthorized.
async function authenticate(token) {
  if (!token.includes(".") && COOKIE_SECRET) token = decryptCookie(token, COOKIE_SECRET) ?? "";
  const jwt = verifyJwt(token, JWT_SECRET);
  if (!jwt) return null;
  const { rows } = await pool.query(
    `SELECT DISTINCT ua.outlet_id FROM users u JOIN user_authorities ua ON ua.user_id = u.id
     WHERE u.id = $1 AND NOT u.mark_for_delete AND ua.authority = 'APPOINTMENT_MONITORING'`,
    [jwt.sub],
  );
  return rows.length ? { outlets: rows.map((r) => r.outlet_id), exp: jwt.exp } : null;
}

// Signs in through medico-service's own /api/login and returns the raw JWT, or null on bad credentials.
async function medicoLogin(username, password) {
  const r = await fetch(MEDICO_LOGIN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    redirect: "manual",
  });
  if (!r.ok) return null;
  const cookie = r.headers.getSetCookie().map((c) => /^accessToken=([^;]+)/.exec(c)?.[1]).find(Boolean);
  const jwt = cookie && decryptCookie(cookie, COOKIE_SECRET);
  return jwt && verifyJwt(jwt, JWT_SECRET) ? jwt : null;
}

// --- OAuth: lets MCP clients sign users in on a web page instead of pasting tokens ---

const randomId = () => crypto.randomBytes(32).toString("base64url");
const remember = (map, key, value, ms) => { map.set(key, value); setTimeout(() => map.delete(key), ms).unref(); };
const pending = new Map(); // login page id -> authorize params, 10 min
const codes = new Map(); // authorization code -> { clientId, codeChallenge, redirectUri, jwt }, 5 min

// Registered clients are stored inside a signed client_id, so registrations survive restarts with no database.
// The client_secret (confidential clients only) is derived from the client_id and never stored.
const clientKey = crypto.createHash("sha256").update(`oauth-clients:${JWT_SECRET}`).digest();
const mac = (s) => crypto.createHmac("sha256", clientKey).update(s).digest("base64url");
const withSecret = (info, clientId) =>
  info.token_endpoint_auth_method === "none" ? { ...info, client_id: clientId } : { ...info, client_id: clientId, client_secret: mac(`secret:${clientId}`) };
const clientsStore = {
  registerClient({ client_id, client_secret, ...info }) {
    const body = Buffer.from(JSON.stringify(info)).toString("base64url");
    return withSecret(info, `${body}.${mac(body)}`);
  },
  getClient(clientId) {
    const [body, sig] = clientId.split(".");
    if (!body || !sig || sig.length !== mac(body).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac(body)))) return undefined;
    return withSecret(JSON.parse(Buffer.from(body, "base64url")), clientId);
  },
};

const takeCode = (client, code) => {
  const c = codes.get(code);
  if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
  return c;
};

const provider = {
  clientsStore,
  async authorize(client, params, res) {
    const id = randomId();
    remember(pending, id, { clientId: client.client_id, ...params }, 10 * 60_000);
    loginPage(res, id);
  },
  async challengeForAuthorizationCode(client, code) {
    return takeCode(client, code).codeChallenge;
  },
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const c = takeCode(client, code);
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    codes.delete(code);
    const { exp } = verifyJwt(c.jwt, JWT_SECRET) ?? {};
    if (!exp) throw new InvalidGrantError("Sign-in expired, try again");
    return { access_token: c.jwt, token_type: "bearer", expires_in: Math.floor(exp - Date.now() / 1000) };
  },
  async exchangeRefreshToken() {
    throw new InvalidGrantError("Refresh tokens are not supported, sign in again");
  },
  async verifyAccessToken(token) {
    const a = await authenticate(token);
    if (!a) throw new InvalidTokenError("Invalid or expired token");
    return { token, clientId: "medico", scopes: [], expiresAt: a.exp, extra: { outlets: a.outlets } };
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function loginPage(res, id, error = "", status = 200) {
  res
    .status(status)
    .set({ "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", "cache-control": "no-store" })
    .type("html")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Medico</title><style>
body{font:16px system-ui,sans-serif;background:#f4f5f7;color:#1d2127;margin:0;display:grid;place-items:center;min-height:100vh}
form{background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 12px #0001;width:min(360px,calc(100vw - 32px));box-sizing:border-box}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 20px;color:#555}label{display:block;margin:12px 0 4px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:10px;font:inherit;border:1px solid #bbb;border-radius:8px}
button{margin-top:20px;width:100%;padding:12px;font:inherit;font-weight:600;border:0;border-radius:8px;background:#1663d6;color:#fff;cursor:pointer}
.err{color:#b00020;margin:0 0 12px}
@media (prefers-color-scheme:dark){body{background:#15171a;color:#eee}form{background:#22252a}p{color:#aaa}input{background:#15171a;color:#eee;border-color:#555}.err{color:#ff8a80}}
</style></head><body><form method="post" action="login">
<h1>Sign in to Medico</h1><p>Use your usual Medico username and password to let Claude read appointments.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<input type="hidden" name="id" value="${esc(id)}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form></body></html>`);
}

if (process.env.PORT) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is required in HTTP mode");
  const oauth = Boolean(MEDICO_LOGIN_URL);
  if (oauth && (!PUBLIC_URL || !COOKIE_SECRET)) throw new Error("MEDICO_LOGIN_URL needs PUBLIC_URL and COOKIE_SECRET");
  const host = process.env.HOST ?? "127.0.0.1";
  const app = express();
  app.set("trust proxy", "loopback"); // real client IP for rate limiting behind a local TLS proxy

  if (oauth) {
    const issuerUrl = new URL(PUBLIC_URL);
    app.use(mcpAuthRouter({ provider, issuerUrl, resourceServerUrl: new URL("/mcp", issuerUrl), resourceName: "Medico appointments" }));
    // Slows password guessing through this page; medico-service may have no limit of its own.
    app.post("/login", rateLimit({ windowMs: 15 * 60_000, limit: 20 }), express.urlencoded({ extended: false }), async (req, res) => {
      const { id = "", username = "", password = "" } = req.body ?? {};
      const p = pending.get(id);
      if (!p) return res.status(400).type("text").send("This sign-in link has expired. Go back to Claude and connect again.");
      try {
        const jwt = await medicoLogin(String(username).trim(), String(password));
        if (!jwt) return loginPage(res, id, "Wrong username or password.", 401);
        if (!(await authenticate(jwt))) return loginPage(res, id, "Your account does not have access to appointments.", 403);
        pending.delete(id);
        const code = randomId();
        remember(codes, code, { clientId: p.clientId, codeChallenge: p.codeChallenge, redirectUri: p.redirectUri, jwt }, 5 * 60_000);
        const back = new URL(p.redirectUri);
        back.searchParams.set("code", code);
        if (p.state) back.searchParams.set("state", p.state);
        res.redirect(302, back.href);
      } catch (e) {
        console.error(e);
        loginPage(res, id, "Medico could not be reached. Try again in a moment.", 502);
      }
    });
  }

  const bearer = requireBearerAuth({
    verifier: provider,
    ...(oauth && { resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL("/mcp", PUBLIC_URL)) }),
  });
  app.post("/mcp", bearer, async (req, res) => {
    try {
      const server = createServer(req.auth.extra.outlets);
      // Stateless mode: no sessions, a fresh server per request.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });
  app.all("/mcp", (req, res) => res.status(405).set("allow", "POST").json({ error: "method not allowed" }));

  app.listen(Number(process.env.PORT), host, () => console.error(`medico MCP listening on http://${host}:${process.env.PORT}/mcp`));
} else {
  await createServer(null).connect(new StdioServerTransport());
}
