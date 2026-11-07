#!/usr/bin/env node
// Read-only MCP server over the medico-service Postgres `appointments` table.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const server = new McpServer({ name: "medico-appointments", version: "1.0.0" });

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
    if (a.outlet_id) add("a.outlet_id = ?", a.outlet_id);
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
    const { rows } = await pool.query(`${SELECT} WHERE a.id = $1`, [id]);
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
    const params = [toMillis(from), toMillis(to), timezone];
    if (outlet_id) params.push(outlet_id);
    const { rows } = await pool.query(
      `SELECT to_char(to_timestamp(started_at / 1000.0) AT TIME ZONE $3, 'YYYY-MM-DD') AS day, status, COUNT(*)::int AS count
       FROM appointments
       WHERE started_at BETWEEN $1 AND $2 ${outlet_id ? "AND outlet_id = $4" : ""}
       GROUP BY 1, 2 ORDER BY 1, 2`,
      params,
    );
    return json(rows);
  },
);

server.registerTool(
  "list_outlets",
  { description: "List outlets (clinics) so you can find an outlet_id.", inputSchema: {} },
  async () => {
    const { rows } = await pool.query("SELECT id, code, name, city FROM outlets WHERE NOT mark_for_delete ORDER BY name");
    return json(rows);
  },
);

await server.connect(new StdioServerTransport());
