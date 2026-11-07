# medico-appointments-mcp

Read-only MCP server (stdio) for the medico-service `appointments` table in Postgres.
Every connection runs with `default_transaction_read_only=on`, so it cannot change data.

## Tools
- `list_appointments` – filter by `outlet_id`, `from`/`to` (ISO 8601, on `started_at`), `status` (`OPENED|COMPLETED|CANCELED`), `doctor_id`, `patient_id`, `patient_name` (partial), `limit` (default 50, max 500). Newest first. Includes doctor, admin and outlet names.
- `get_appointment` – one appointment by `id`.
- `count_appointments_by_day` – counts per day and status in a range (`timezone` defaults to `Asia/Jakarta`).
- `list_outlets` – outlet ids and names.

Times are returned as ISO strings (UTC); the DB stores epoch milliseconds.

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

## Test
Needs an empty throwaway Postgres DB (the test drops and recreates tables):
```
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/medico_test npm test
```
