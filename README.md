# PingFederate LAB

One shelf with a card for each PingFederate feature behind AI agents. Every card shows each request and response raw, on a built-in mock PingFederate (offline) or on your own PingFederate.

Tier: Demo
Repo: https://github.com/curtismu7/pingfederate-LAB
Catalog: A28 (accepted by the owner, 2026-10-31; set in `docs/shelf-entry.json` and `content-pack.json`).

ID-JAG is not in this lab. It lives in id-jag-standalone-LAB (https://github.com/curtismu7/id-jag-standalone-LAB); the Playground says so too.

## What is simulated

- **Mock mode** (the default when no PingFederate is configured): an in-process mock PingFederate answers every card, on `https://pingfederate.mock.invalid`. Nothing leaves the machine. Every mock reply, trace step and token is labelled `mock`.
  The mock sign-in dialog shows its demo user. That user exists only in the mock.
- **Live mode** (owner-run): every card talks to the PingFederate you name in Settings, and only to that origin (https, no redirects, 10 second timeout, 256 KB body cap).
- Unsourced product claims are labelled `UNVERIFIED`. Not verified against a live PingFederate: pi.flow after PAR, and whether an existing PingFederate session completes a new flow at once.
- Tokens: mock-issued tokens are fake, so they are shown whole and labelled mock. Tokens from a real PingFederate are shown masked (first 6 and last 4 characters, with the header and claims decoded in full), because they are live credentials (owner decision, 2026-10-31, rule 4). Client secrets, codes and refresh tokens are never returned or logged.

## Run from a clone

Prerequisites: Node 26, git. Docker only for the Docker form.

```sh
git clone https://github.com/curtismu7/pingfederate-LAB.git
cd pingfederate-LAB
npm install
npm run build
npm start
```

Open http://127.0.0.1:5400. With no settings file, the lab starts in mock mode and every card works: sign in (the dialog shows the demo user), run the cards, open the Playground. Choose a workspace name in the header if more than one person shares the laptop.

Mock sign-in is on by itself in this plain start, because the lab is bound to 127.0.0.1 and no PingFederate is saved in Settings. Once you save a PingFederate, or if you start it any other way, mock sign-in is off and the flows stop at the sign-in step with the message to use; then start with the flag:

```sh
ALLOW_MOCK_SIGNIN=1 npm start
```

`npm run doctor` prints whether plain `npm start` allows mock sign-in on this machine.

The Playground opens each of its 11 flows with a short explainer (the specification, what the feature solves, why it matters for AI agents). Its Token tab shows the scopes, aud, sub and exp of the newest token a step returned, above the full token view.

For live mode, open Settings and fill in your PingFederate (below), then switch the header toggle to Live.

## Settings file

One file, mode 600: `~/.config/demo-kit/pingfederate-lab/pingfederate.json` (`PFLAB_SETTINGS_FILE` overrides the path). The shared `~/Development/.env` holds no PingFederate keys: its only keys are the PingOne environment id and region, and client secrets do not belong in it. The lab refuses to start if the settings file is a symbolic link or not valid JSON. Secrets are write-only: the page shows `set` or `not set`.

| Section | Keys |
| --- | --- |
| `pf` | `issuer` (https), `redirectUri` (optional) |
| `signin`, `pkce`, `par`, `dpop`, `rar`, `ciba` | `clientId`, `clientSecret` (optional for a public client), `scope` (optional) |
| `rarDpop` | `clientId`, `clientSecret` |
| `rar` | also `sourceAccount`, `destinationAccount` |
| `ciba` | also `approverSecret` (optional; lets the card approve on its own page) |
| `dcr` | `iatClientId`, `iatClientSecret`, `clientScope` (optional), `forbiddenScope` (optional) |
| `tokenExchange` | `agentExchange*`, `mcpExchange*`, `agentActor*`, `mcpActor*` client ids and secrets; `agentActorScope`, `mcpActorScope`, `intermediateAudience`, `finalAudience` (optional) |
| `links` | `cimdLabUrl`, `idJagUrl` (optional; link cards to the sibling apps) |
| `mode` | `mock` or `live`, saved by the header toggle |

Environment variables (all optional): `PORT`, `LAB_ALLOWED_HOSTS`, `LAB_TLS_CERT`, `LAB_TLS_KEY`, `ALLOW_MOCK_SIGNIN`, `PFLAB_SETTINGS_FILE`, `CUSTOMER_CONFIG`, and `HOST_PORT` (Docker form only: the port to publish).

**PingFederate-side setup is the owner's, and is not scripted yet.** For live mode your PingFederate needs the sign-in adapter, the PingOne data store that supplies user claims, an OpenID Connect policy and an access token manager for the lab's clients, and each code-flow client needs "Allow Authentication API OAuth initiation". `scripts/provision-pf.mjs` and `scripts/provision-pf-ciba-approver.mjs` (owner-run, dry run by default) create the lab's clients and the CIBA approver from template objects; they do not create those four objects.

## Ports, and what to do if the port is taken

Ports: pingfederate-lab listens on 5400 (set with PORT, default 5400).
Port range for this app: 5400-5449.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:5400 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=5401 npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.

## Mock and live modes

The **Mock / Live** toggle is in the header on every page, presenter mode included. The banner shows the same mode. Switching signs everyone out, because a token from one PingFederate means nothing to the other.

- If you never chose, the lab starts in live mode when an issuer is saved, otherwise in mock mode. Saving an issuer later does not switch modes; only the toggle does.
- Mock sign-in (rule 11) needs `ALLOW_MOCK_SIGNIN=1`. The Docker form sets it. A plain `npm start` sets it for you only when the lab is bound to 127.0.0.1, `LAB_PUBLISH` is unset and no PingFederate is saved in Settings; an explicit `ALLOW_MOCK_SIGNIN` (even `0`) always wins. It is refused behind a proxy (`Forwarded` or `X-Forwarded-*` headers), except the family launcher at `https://local.ping-devops.com:8443` reaching the lab by its `LAB_ALLOWED_HOSTS` name, and on a non-loopback bind, unless `LAB_PUBLISH=loopback` says the port is published on 127.0.0.1 only (the Docker form does). `NODE_ENV=production` is not a guard: the Docker image runs with it. While it is refused, `GET /api/mode` sends no mock user name or password.
- In mock mode, Clear (Playground) and Reset delete a client a half-finished DCR run left on the mock. On a real PingFederate the lab never deletes on its own: Reset only lists what is left.
- `GET /api/health` reports `runtime: offline` in mock mode and `live` in live mode.

Workspaces (rule 13): the header names the current workspace (default `default`). Each workspace has its own sign-in, runs, results, tokens and trace; saved settings are shared. A browser keeps one cookie for all of its workspaces.

## Health, doctor and reset

- `GET /api/health` returns `demo-health/1` (public, GET only, no detail).
- `npm run doctor` prints one line per check and exits 1 on failure: Node 26, settings readable, whether plain `npm start` allows mock sign-in, the mock-mode network guard, the health route, the port, and the 10 diagrams.
- `npm run reset [workspace]` clears the run state of one workspace on the running lab (default workspace `default`, or set `WORKSPACE`). Sign-ins and saved settings stay. It lists any DCR client left on PingFederate. The page's "Reset this card" clears one card.

## Docker (optional)

```sh
docker compose up --build -d      # mock mode, plain http, nothing to set up
```

Open http://127.0.0.1:5400. The port is published on 127.0.0.1 only (a test pins that), the container runs as a non-root user with a read-only filesystem, and the saved mode lives in a named volume.

**Another port:** `HOST_PORT=5401 docker compose up --build -d` (5400-5449). One number is used on both sides of the mapping and as the lab's `PORT`: the lab answers only the Host it is published as, so changing just the host side, or just `PORT`, gets `403 host_not_allowed`. If you edit `docker-compose.yml` by hand, change `PORT` and both sides of `ports:` together.

**Live mode over https** needs the second compose file and four values, all optional until you want it: `PFLAB_CA_FILE` (the root certificate that signed your PingFederate's certificate), `PFLAB_TLS_CERT_FILE` and `PFLAB_TLS_KEY_FILE` (the certificate the lab serves https with; it must cover 127.0.0.1, localhost and `LAB_ALLOWED_HOSTS`), and `PF_HOSTNAME` (the host name in your issuer, which has to point at the Mac from inside the container). Copy `.env.example` to `.env`, fill them in, and add the live file:

```sh
docker compose -f docker-compose.yml -f docker-compose.live.yml up --build -d
# or put COMPOSE_FILE=docker-compose.yml:docker-compose.live.yml in .env and run plain `docker compose up --build -d`
```

The live file mounts only the lab's settings folder and the three certificate files.

## Tests

```sh
npm test      # server: node --test test/*.test.js, and web: vitest; both run even if one fails
npm run e2e   # after npm run build: a real Chromium runs all 11 Playground flows in mock mode (needs: npx playwright install chromium)
```

On Node 26.8.2: server 123 passed, 0 failed; web 71 passed, 0 failed. `npm run doctor` is all ok. `npm run e2e` checks that every flow finishes, that the explainer and the Token tab render in light and dark at 1280 and 375 pixels wide, and that no request leaves localhost. CI runs the tests, the doctor, the conformance check (`server/test/demo-kit-conformance.mjs`, a copy of demo-kit-base's script, `--new`), a Docker build and start, and the e2e run.

## Troubleshooting

1. **A card says it needs a setting.** Open Settings from the card and fill in the named field, or stay in mock mode.
2. **"PingFederate no longer knows this sign-in (404)".** The flow expired or PingFederate restarted. Press Run again.
3. **Port in use.** See Ports above.
4. **Live mode cannot reach PingFederate from Docker.** Use the live compose file (see Docker above). Its certificate must be trusted by the container (`PFLAB_CA_FILE`) and `PF_HOSTNAME` must name the host in your issuer.
5. **Mock sign-in is refused.** Start with `ALLOW_MOCK_SIGNIN=1 npm start` on 127.0.0.1. It is also refused behind a proxy (other than the family launcher) and on a non-loopback bind, and plain `npm start` does not set it once a PingFederate is saved in Settings.

## Ownership

Owner: the Ping demo family owner. Licence: internal Ping demo use. Report problems to the owner, or on the repository's issues (https://github.com/curtismu7/pingfederate-LAB/issues).
