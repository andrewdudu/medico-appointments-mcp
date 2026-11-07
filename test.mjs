// Self-check: seeds a THROWAWAY database (drops tables!) then exercises every tool over stdio and HTTP.
// Usage: TEST_DATABASE_URL=postgresql://postgres@localhost:5432/medico_test node test.mjs
import pg from "pg";
import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
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
const NO_ACCESS_COOKIE = "FycxgaSUgHnBlzMqYn/qsBEm5YBcmX52/eYbm+daUHN4DFYJpWvLndUdD4uy+M5zadpm2lPPzKm0vNvj4fOIP23uxv3PSjlPgDhtqnYWsMVPv/kfLDUGfcDZN+ev/AqCbBzhu5LhPsigsGXHF5Axsxc+fboszSgiLeIz0mMX+840i87bn5GauJG4v1CgTXAKf68Lifzgw4jcd2M44eUwoHU+0U2JuYOEMJNDiR3VOkQ="; // sub=u1

// Stand-in for medico-service POST /api/login: body `true`, token in the accessToken cookie, 500 on bad login.
const users = { budi: ["pw", COOKIE], sari: ["pw", NO_ACCESS_COOKIE] };
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)).on("end", () => {
    const { username, password } = JSON.parse(b);
    const u = users[username];
    if (!u || u[0] !== password) return res.writeHead(500).end("{}");
    res.writeHead(200, { "set-cookie": `accessToken=${u[1]}; Path=/; Max-Age=604800; HttpOnly`, "content-type": "application/json" }).end("true");
  });
}).listen(38233, "127.0.0.1");

const PORT = 38231, BASE = `http://localhost:${PORT}`, MCP = `http://127.0.0.1:${PORT}/mcp`;
const srv = spawn("node", ["server.js"], {
  env: { ...env, PORT, JWT_SECRET: "tokensecret", COOKIE_SECRET: "secureKey", PUBLIC_URL: BASE, MEDICO_LOGIN_URL: "http://127.0.0.1:38233/api/login" },
  stdio: ["ignore", "ignore", "pipe"],
});
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

  // OAuth sign-in, the way Claude Code / claude.ai connectors do it
  const unauth = await fetch(MCP, { method: "POST" });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate"), /resource_metadata="http:\/\/localhost:38231\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  const meta = await (await fetch(`${prm.authorization_servers[0].replace(/\/$/, "")}/.well-known/oauth-authorization-server`)).json();
  const redirect_uri = "http://localhost:9999/callback";
  const reg = await (await fetch(meta.registration_endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect_uri], token_endpoint_auth_method: "none", client_name: "test" }),
  })).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = async (client_id) => fetch(`${meta.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: challenge, code_challenge_method: "S256", state: "st8" })}`, { redirect: "manual" });
  assert.notEqual((await authorize(reg.client_id.slice(0, -3) + "AAA")).status, 200); // forged client_id
  const page = await (await authorize(reg.client_id)).text();
  const id = /name="id" value="([^"]+)"/.exec(page)[1];
  const login = (username, password, pid = id) => fetch(`${BASE}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ id: pid, username, password }) });
  let lr = await login("budi", "wrong"); assert.equal(lr.status, 401); assert.match(await lr.text(), /Wrong username or password/);
  lr = await login("sari", "pw"); assert.equal(lr.status, 403);
  assert.equal((await login("budi", "pw", "bogus")).status, 400);
  lr = await login("budi", "pw"); assert.equal(lr.status, 302);
  const back = new URL(lr.headers.get("location"));
  assert.equal(back.origin + back.pathname, redirect_uri); assert.equal(back.searchParams.get("state"), "st8");
  assert.equal((await login("budi", "pw")).status, 400); // login page id is single-use
  const exchange = (code_verifier) => fetch(meta.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), client_id: reg.client_id, code_verifier, redirect_uri }) });
  assert.equal((await exchange("wrong-verifier-wrong-verifier-wrong-verifier-123")).status, 400); // PKCE
  const tok = await exchange(verifier); assert.equal(tok.status, 200);
  const { access_token, expires_in } = await tok.json();
  assert.equal(access_token, JWT); assert(expires_in > 0);
  assert.equal((await exchange(verifier)).status, 400); // code is single-use
  const o = new Client({ name: "t", version: "1" });
  await o.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${access_token}` } } }));
  [, d] = await tools(o)("list_appointments", {}); assert.deepEqual(d.map(x => x.id), ["a3", "a2", "a1"]);
  await o.close();

  await db.query("update users set mark_for_delete = true where id = 'd1'");
  assert.equal(await status(JWT), 401);
} finally {
  srv.kill();
  mock.close();
  await db.end();
}
console.log("ALL OK");
