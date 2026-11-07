// Self-check: seeds a THROWAWAY database (drops tables!) then exercises every tool over stdio and HTTP.
// Usage: TEST_DATABASE_URL=postgresql://postgres@localhost:5432/medico_test node test.mjs
import pg from "pg";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to an empty test database");
const db = new pg.Client(url); await db.connect();
await db.query(`
drop table if exists appointments, user_authorities, users, outlets;
create table users (id varchar primary key, name varchar, mark_for_delete boolean default false);
create table user_authorities (id serial, outlet_id varchar, authority varchar, user_id varchar);
create table outlets (id varchar primary key, code varchar, name varchar, city varchar, mark_for_delete boolean default false);
create table appointments (id varchar primary key, outlet_id varchar, patient_id varchar, patient_name varchar, doctor_id varchar, admin_id varchar, status varchar, started_at bigint, ended_at bigint, phone_number varchar, notes varchar, updated_date bigint, updated_by varchar, version int);
insert into users values ('d1','Dr. Budi'),('u1','Admin Sari');
insert into user_authorities (outlet_id, authority, user_id) values ('o1','APPOINTMENT_MONITORING','d1'),('o2','QUEUE_MONITORING','d1');
insert into outlets values ('o1','JKT','Klinik Jakarta','Jakarta',false),('o2','SBY','Klinik Surabaya','Surabaya',false);
insert into appointments values
 ('a1','o1','p1','Andi','d1','u1','OPENED',1794186000000,1794189600000,'0812','first',1794186000000,'u1',0),
 ('a2','o1','p2','Rina','d1','u1','COMPLETED',1794272400000,1794276000000,'0813',null,1794272400000,'u1',0),
 ('a3','o1','p1','Andi',null,'u1','CANCELED',1794272500000,1794276100000,'0812',null,1794272500000,'u1',0),
 ('a4','o2','p3','Joko','d1','u1','OPENED',1794100000000,1794103600000,'0814',null,1794100000000,'u1',0);`);

const env = { ...process.env, DATABASE_URL: url };
const tools = (c) => async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  return [r, r.isError ? r.content[0].text : JSON.parse(r.content[0].text)];
};

// stdio: local and unrestricted
const c = new Client({ name: "t", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.js"], env }));
let call = tools(c);
const names = (await c.listTools()).tools.map(t => t.name); assert.equal(names.length, 4);
let [, d] = await call("list_appointments", {}); assert.equal(d.length, 4); assert.equal(d[0].id, "a3");
[, d] = await call("list_appointments", { outlet_id: "o1", status: "OPENED" }); assert.deepEqual(d.map(x => x.id), ["a1"]);
[, d] = await call("list_appointments", { from: "2026-11-10T00:00:00+07:00", patient_name: "and" }); assert.deepEqual(d.map(x => x.id), ["a3"]);
[, d] = await call("get_appointment", { id: "a2" }); assert.equal(d.doctor_name, "Dr. Budi");
let [r] = await call("get_appointment", { id: "zzz" }); assert(r.isError);
[, d] = await call("count_appointments_by_day", { from: "2026-11-01", to: "2026-11-30", outlet_id: "o1" }); assert.equal(d.length, 3);
[, d] = await call("list_outlets", {}); assert.equal(d.length, 2);
[r] = await call("list_appointments", { from: "garbage" }); assert(r.isError);
await c.close();

// HTTP: tokens below were made by Java 8 the way medico-service does it
// (jjwt 0.9.0 HS512 with token-secret "tokensecret", cookie AES key "secureKey"), sub=d1.
const JWT = "eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJkMSIsImlhdCI6NDEwMjQ0NDcwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.aUHmvDFyYFxBNzmZ_O5LGht0bqNnIkIzEyIeMy_azJQM3q7s5uI41Ty8ycJ2PqplGW9hiuDTvtE91VwR6tDLyg";
const COOKIE = "FycxgaSUgHnBlzMqYn/qsBEm5YBcmX52/eYbm+daUHP41KZ9Yr8/yrvlsBg7MJXHadpm2lPPzKm0vNvj4fOIP23uxv3PSjlPgDhtqnYWsMVrU6+QcFVJU+K2ZVhSuHrMY4ExRi0YAtXgq9NPCqxsBMCEo2pUTeB3DG/b5Hyi/TatTGJ4cg62uU/8UU5Qv3xRnQwFBSZnrowwUnrJFH8Il93opd0FQNU8EWmu+0SsI9c=";
const EXPIRED = "eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJkMSIsImlhdCI6OTk5OTk5OTAwLCJleHAiOjEwMDAwMDAwMDB9.FH8Zku13TmYyMAehzKuBgGZYBAP72wfujIFiN8PaKnYZWSbHmnqWdesl8yuCCXoUAHd1nPahqH2Gu1fl5B-6Ng";
const PORT = 38231, MCP = `http://127.0.0.1:${PORT}/mcp`;
const srv = spawn("node", ["server.js"], { env: { ...env, PORT, JWT_SECRET: "tokensecret", COOKIE_SECRET: "secureKey" }, stdio: ["ignore", "ignore", "pipe"] });
await new Promise((ok) => srv.stderr.on("data", (b) => b.includes("listening") && ok()));
try {
  const status = async (token) => (await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })).status;
  assert.equal(await status(), 401);
  assert.equal(await status(EXPIRED), 401);
  assert.equal(await status(JWT.slice(0, -2) + "AA"), 401);
  assert.equal(await status("eyJhbGciOiJub25lIn0.eyJzdWIiOiJkMSIsImV4cCI6NDEwMjQ0NDgwMH0."), 401); // alg none
  assert.equal(await status(JWT), 200);

  for (const token of [JWT, COOKIE]) {
    const h = new Client({ name: "t", version: "1" });
    await h.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    call = tools(h);
    [, d] = await call("list_appointments", {}); assert.deepEqual(d.map(x => x.id), ["a3", "a2", "a1"]); // o2 hidden
    [r] = await call("list_appointments", { outlet_id: "o2" }); assert(r.isError);
    [r] = await call("get_appointment", { id: "a4" }); assert(r.isError);
    [, d] = await call("count_appointments_by_day", { from: "2026-11-01", to: "2026-11-30" }); assert.equal(d.reduce((s, x) => s + x.count, 0), 3);
    [, d] = await call("list_outlets", {}); assert.deepEqual(d.map(x => x.id), ["o1"]);
    await h.close();
  }

  await db.query("update users set mark_for_delete = true where id = 'd1'");
  assert.equal(await status(JWT), 401);
} finally {
  srv.kill();
  await db.end();
}
console.log("ALL OK");
