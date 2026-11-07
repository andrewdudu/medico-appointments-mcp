#!/usr/bin/env node
// Read-only MCP server over the medico-service Postgres `appointments` table.
// stdio by default; set PORT to serve Streamable HTTP with medico-service JWT auth.
import http from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

  const server = new McpServer({ name: "medico-appointments", version: "1.1.0" });

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

// jjwt 0.9.0 base64-decodes the secret with DatatypeConverter, which ignores a trailing partial group
// ("tokensecret" -> 6 bytes); Node's decoder would keep it, so cut to whole 4-char groups first.
const jjwtKey = (secret) => {
  const clean = secret.replace(/[^A-Za-z0-9+/=]/g, "");
  return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
};

// Returns the token subject (user id) if it is a valid, unexpired HS512 JWT, else null.
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
    return typeof claims.sub === "string" ? claims.sub : null;
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

// Bearer value may be the raw JWT or the `accessToken` cookie value. Returns allowed outlet ids, or null if unauthorized.
async function authenticate(authorization) {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m) return null;
  let token = m[1];
  if (!token.includes(".") && process.env.COOKIE_SECRET) token = decryptCookie(token, process.env.COOKIE_SECRET) ?? "";
  const userId = verifyJwt(token, process.env.JWT_SECRET);
  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT DISTINCT ua.outlet_id FROM users u JOIN user_authorities ua ON ua.user_id = u.id
     WHERE u.id = $1 AND NOT u.mark_for_delete AND ua.authority = 'APPOINTMENT_MONITORING'`,
    [userId],
  );
  return rows.length ? rows.map((r) => r.outlet_id) : null;
}

const send = (res, status, body, headers = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

if (process.env.PORT) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required in HTTP mode");
  const host = process.env.HOST ?? "127.0.0.1";
  http
    .createServer(async (req, res) => {
      if (new URL(req.url, "http://x").pathname !== "/mcp") return send(res, 404, { error: "not found" });
      // Stateless mode: no sessions, so only POST is meaningful.
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST" });
      try {
        const outlets = await authenticate(req.headers.authorization);
        if (!outlets) return send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        const server = createServer(outlets);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        console.error(e);
        if (!res.headersSent) send(res, 500, { error: "internal error" });
      }
    })
    .listen(Number(process.env.PORT), host, () => console.error(`medico MCP listening on http://${host}:${process.env.PORT}/mcp`));
} else {
  await createServer(null).connect(new StdioServerTransport());
}
