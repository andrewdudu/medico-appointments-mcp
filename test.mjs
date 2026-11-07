// Self-check: seeds a THROWAWAY database (drops tables!) then exercises every tool over stdio.
// Usage: TEST_DATABASE_URL=postgresql://postgres@localhost:5432/medico_test node test.mjs
import pg from "pg";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to an empty test database");
const db = new pg.Client(url); await db.connect();
await db.query(`
drop table if exists appointments, users, outlets;
create table users (id varchar primary key, name varchar);
create table outlets (id varchar primary key, code varchar, name varchar, city varchar, mark_for_delete boolean default false);
create table appointments (id varchar primary key, outlet_id varchar, patient_id varchar, patient_name varchar, doctor_id varchar, admin_id varchar, status varchar, started_at bigint, ended_at bigint, phone_number varchar, notes varchar, updated_date bigint, updated_by varchar, version int);
insert into users values ('d1','Dr. Budi'),('u1','Admin Sari');
insert into outlets values ('o1','JKT','Klinik Jakarta','Jakarta',false);
insert into appointments values
 ('a1','o1','p1','Andi','d1','u1','OPENED',1794186000000,1794189600000,'0812','first',1794186000000,'u1',0),
 ('a2','o1','p2','Rina','d1','u1','COMPLETED',1794272400000,1794276000000,'0813',null,1794272400000,'u1',0),
 ('a3','o1','p1','Andi',null,'u1','CANCELED',1794272500000,1794276100000,'0812',null,1794272500000,'u1',0);`);
await db.end();
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "t", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.js"], env: { ...process.env, DATABASE_URL: url } }));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return [r, r.isError ? r.content[0].text : JSON.parse(r.content[0].text)]; };
const names = (await c.listTools()).tools.map(t => t.name); assert.equal(names.length, 4);
let [, d] = await call("list_appointments", {}); assert.equal(d.length, 3); assert.equal(d[0].id, "a3");
[, d] = await call("list_appointments", { outlet_id: "o1", status: "OPENED" }); assert.deepEqual(d.map(x => x.id), ["a1"]);
[, d] = await call("list_appointments", { from: "2026-11-10T00:00:00+07:00", patient_name: "and" }); assert.deepEqual(d.map(x => x.id), ["a3"]);
[, d] = await call("get_appointment", { id: "a2" }); assert.equal(d.doctor_name, "Dr. Budi");
let [r] = await call("get_appointment", { id: "zzz" }); assert(r.isError);
[, d] = await call("count_appointments_by_day", { from: "2026-11-01", to: "2026-11-30", outlet_id: "o1" }); assert.equal(d.length, 3);
[, d] = await call("list_outlets", {}); assert.equal(d[0].name, "Klinik Jakarta");
[r] = await call("list_appointments", { from: "garbage" }); assert(r.isError);
console.log("ALL OK"); await c.close();
