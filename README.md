# medico-appointments-mcp

Read-only MCP server for the medico-service `appointments` table in Postgres.
Runs over stdio (local, unrestricted) or Streamable HTTP (remote, medico-service JWT auth, scoped per outlet).
In HTTP mode it can also show a "Sign in to Medico" page, so users connect with their normal username and password
and never handle a token.
Every connection runs with `default_transaction_read_only=on`, so it cannot change data.

## Tools
- `list_appointments` – filter by `outlet_id`, `from`/`to` (ISO 8601, on `started_at`), `created_from`/`created_to` (on `created_date`), `status` (`OPENED|COMPLETED|CANCELED`), `doctor_id`, `patient_id`, `patient_name` (partial), `limit` (default 50, max 500), `order_by` (`started_at` default, or `created_date`). Newest first. Includes doctor, admin, outlet and creator names.
- `get_appointment` – one appointment by `id`.
- `count_appointments_by_day` – counts per day and status in a range (`timezone` defaults to `Asia/Jakarta`). `by=started_at` (default) buckets by appointment day; `by=created_date` buckets by the day the booking was made, i.e. bookings created per day.
- `list_outlets` – outlet ids and names.

Times are returned as ISO strings (UTC); the DB stores epoch milliseconds.
`created_date` is when the booking was made (set once by medico-service); `updated_date` changes on every edit.
Rows with no recorded creation time (stored as `0`) return `created_date: null`.

## Setup
```
npm install
```
Connection: `DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5432/medico`, matching docker-compose).

Claude Code:
```
claude mcp add medico -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/medico -- node /absolute/path/to/server.js
```

Claude Desktop (`claude_desktop_config.json`):
```json
{ "mcpServers": { "medico": {
  "command": "node", "args": ["/absolute/path/to/server.js"],
  "env": { "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/medico" } } } }
```

## HTTP mode (remote, e.g. a GCP VM)
Set `PORT` and the server listens on `http://$HOST:$PORT/mcp` (`HOST` defaults to `127.0.0.1`).

| Env | Meaning |
|-----|---------|
| `PORT` | Enables HTTP mode |
| `HOST` | Bind address, default `127.0.0.1`. Keep it local and put a TLS proxy in front |
| `JWT_SECRET` | Required. Same value as medico-service `token.jwt.token-secret` |
| `COOKIE_SECRET` | Optional. medico-service `SecurityCipher` key, so the encrypted `accessToken` cookie value is accepted as a token |
| `DATABASE_URL` | As above |
| `MEDICO_LOGIN_URL` | Enables the sign-in page, e.g. `https://medicosystem.com/api/login`. Needs `PUBLIC_URL` and `COOKIE_SECRET` |
| `PUBLIC_URL` | Public HTTPS origin of this server, e.g. `https://mcp.example.com` |

Auth mirrors medico-service: `Authorization: Bearer <token>`, where the token is either the raw JWT or the
`accessToken` cookie value (needs `COOKIE_SECRET`). The token must be a valid, unexpired HS512 JWT whose `sub`
is a user that is not deleted. The caller only sees outlets where that user has `APPOINTMENT_MONITORING` in
`user_authorities`, the same check the app does for `/api/appointments/**`.

### Sign-in page (OAuth)
With `MEDICO_LOGIN_URL` set, the server is a standard MCP OAuth server. A client that connects without a token is
sent to a sign-in page on this server. The username and password go to medico-service's own `/api/login`, so
passwords are checked by medico-service and never pass through Claude. The JWT it returns becomes the access token.
Users without `APPOINTMENT_MONITORING` on any outlet are refused at sign-in. Tokens last as long as medico-service
makes them (7 days); after that the client opens the sign-in page again. The sign-in form is rate limited to
20 attempts per 15 minutes per IP.

The read-only role also needs:
```sql
GRANT SELECT (id, name, mark_for_delete) ON users TO medico_mcp;
GRANT SELECT (user_id, outlet_id, authority) ON user_authorities TO medico_mcp;
```
If the role has column-level grants on `appointments` instead of table-wide `SELECT`, also run:
```sql
GRANT SELECT (created_date, created_by) ON appointments TO medico_mcp;
```

### VM setup
```
git clone https://github.com/andrewdudu/medico-appointments-mcp /opt/medico-mcp && cd /opt/medico-mcp && npm ci --omit=dev
```
`/etc/systemd/system/medico-mcp.service`:
```ini
[Unit]
Description=medico MCP
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/medico-mcp
ExecStart=/usr/bin/node server.js
EnvironmentFile=/etc/medico-mcp.env
Restart=always
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```
`/etc/medico-mcp.env` (`chmod 600`): `PORT=3000`, `JWT_SECRET=...`, `COOKIE_SECRET=...`, `DATABASE_URL=...`,
`MEDICO_LOGIN_URL=https://medicosystem.com/api/login`, `PUBLIC_URL=https://mcp.example.com`. Then
`sudo systemctl enable --now medico-mcp`.

TLS (bearer tokens must never travel over plain HTTP), e.g. Caddy with a DNS name pointing at the VM, and GCP
firewall open on 80/443 only:
```
sudo caddy reverse-proxy --from mcp.example.com --to 127.0.0.1:3000
```

Clients (with the sign-in page):
- Claude Desktop / claude.ai: Settings, Connectors, Add custom connector, URL `https://mcp.example.com/mcp`, then Connect.
- Claude Code: `claude mcp add --transport http medico https://mcp.example.com/mcp`, then `/mcp` in a session to sign in.

Without the sign-in page, pass a token yourself: `--header "Authorization: Bearer <token>"`.

## Test
Needs an empty throwaway Postgres DB (the test drops and recreates tables). Covers stdio and HTTP auth:
```
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/medico_test npm test
```
