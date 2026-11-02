# pingfederate-lab

Tier: Demo. Every PingFederate AI-agent feature on one shelf, on a built-in mock PingFederate or a real one.
Rules: STANDALONE-RULES-FOR-AGENTS.md and STANDALONE-CSS-STANDARD.md in ~/Development (use the standalone-demo skill). Ports 5400-5449 (default 5400).

## Mock and live

Mock / Live toggle on every page (owner, 2026-10-31). Mock = `server/src/mockpf.js` reached through
`server/src/netguard.js` (no socket, real fetch never called); live = only the configured issuer origin, through
`server/src/outbound.js`. No other module may call fetch. Mock sign-in needs `ALLOW_MOCK_SIGNIN=1`, and is refused behind a proxy
and on a non-loopback bind unless `LAB_PUBLISH=loopback` (rule 11); `NODE_ENV=production` is not a guard (the Docker image sets it).
Plain `npm start` (index.js passes `hostRun`) sets it itself only on a loopback bind with `ALLOW_MOCK_SIGNIN` and `LAB_PUBLISH` unset and no issuer saved (`hostRunAllowsMockSignIn`, read per request); never widen that.
`GET /api/mode` sends the mock user and password only while mock sign-in is allowed.
Mock demo user: alice / correct-horse-battery (mock only). Tests use the same mock via `server/test/fakepf.js`.

## Run and test

- `npm run doctor` (one line per check, exit 1 on failure); `npm run reset [workspace]` clears one workspace's runs on the running lab.
- Workspaces (rule 13): `X-Lab-Workspace` header (default `default`); sessions are keyed by cookie id + workspace (`server/src/session.js`); the page keeps the choice in localStorage `pflab-workspace`.

- Docker: `docker compose up --build -d` -> http://127.0.0.1:5400 (mock, nothing to set up). Other port: `HOST_PORT=5401 docker compose up -d` (one number on both sides of the mapping and as `PORT`; the Host check answers only the published port). Live over https adds `docker-compose.live.yml` (`COMPOSE_FILE=docker-compose.yml:docker-compose.live.yml` in a local `.env`) -> https://127.0.0.1:5400 and the `LAB_ALLOWED_HOSTS` names.
- `npm install`, `npm run build`, `npm start` (127.0.0.1:5400), `npm test` (server: `node --test test/*.test.js`, a glob, never a directory; web: vitest; both workspaces run even if one fails), `npm run e2e` (Playwright, all 11 Playground flows in mock, light/dark at 1280 and 375, zero off-localhost requests; needs `npm run build`).
- `server/test/demo-kit-conformance.mjs` is a copy of demo-kit-base's `scripts/conformance.mjs` (cac827a) so hosted CI can run the gate (`--new`). It sits under `test/` because the gate scans every other source file, including itself (its rule text says "mermaid"). Refresh it from demo-kit-base; do not edit it here.
- Node 26 only (owner, 2026-10-31): Dockerfile, CI and `engines` say 26.

## Rules that bite

- Mock DCR: `dcr.discard` (the Playground's Clear on DCR, `/api/reset`, `npm run reset`) deletes a leftover client from the in-process mock only; on a real PingFederate the lab never deletes on its own.
- Rule 4: live tokens are shown masked with decoded claims; mock tokens are fake and shown whole, labelled mock (`withTokenMode` in `server/src/trace.js`, set per request from the mode). A test proves a live token never appears whole.
- The web UI only calls the lab's own `/api` (CSP `default-src 'self'`); never navigate to PingFederate (pi.flow only).
- Static diagrams are diagram-studio/1 JSON in `web/src/diagrams/`; the live sequence is built from the trace in
  the same format (`traceToDiagram`). Shared stylesheet first (`web/src/standalone-ui.css`, never edit; `scripts/check-ui-standard.sh`); `app.css` adds no colours, no prefers-color-scheme, no !important, no italics, breakpoints 600/900 only (`check-css.sh`).
- Settings live in `~/.config/demo-kit/pingfederate-lab/pingfederate.json` (mode 600; `PFLAB_SETTINGS_FILE` for tests). Secrets are
  write-only: never returned (`set: true/false`), never logged. Agents never read the real file.
- Sign-in is pi.flow only (no redirect login). Tokens stay in the server-side session.
- Every PingFederate call is a trace step: secrets redacted (codes, verifiers, client secrets, refresh tokens,
  registration access tokens, DPoP proofs, auth_req_id, passwords, cookies, flow ids), live tokens masked + claims (mock tokens whole),
  W3C traceparent on every hop. New secret fields go into `SECRET_KEYS` in `server/src/trace.js`.
- Loopback bind (0.0.0.0 only inside Docker, published on 127.0.0.1), Host check (loopback plus `LAB_ALLOWED_HOSTS`), same-origin JSON-only writes; https and a `Secure` cookie when `LAB_TLS_CERT`/`LAB_TLS_KEY` are set. Only index.js may import node:https, and only for createServer.
- No identifiers from other projects; tests use only `*.example` / `*.invalid` hosts. History scan must print 0.
- EC keys via createECDH + createPrivateKey, never generateKeyPairSync('ec').
- Agents never call a real PingFederate; the owner does live verification.
