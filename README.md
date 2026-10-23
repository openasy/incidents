# incidents

[![CI](https://github.com/openasy/incidents/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/incidents/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Incidents product: **run an incident** from the first report to the postmortem
(ADR 0041). One place for what happened, who leads, what is left to do, where the evidence lives and what was learned.

```
people ─┐
        ├─▶ incidents ──▶ timeline (append-only) · tasks · evidence links · postmortem · mean time to resolve
products ┘ (API token, editor role)
```

## What it keeps

- **An incident:** an `INC-n` number, title, severity (critical, high, medium, low), status (open, investigating,
  mitigated, resolved), a commander, a summary and the products involved.
- **A timeline** that only grows. A change of status or severity writes itself to it, with who made it; notes and
  links are added by hand. Nothing is edited or deleted, so the timeline can be trusted afterwards.
- **Tasks** with an owner and a due date. Finishing one writes it to the timeline, once.
- **Evidence** as links to where it lives, such as a saved search in Logs. No files are kept here.
- **A postmortem** in Markdown, draft or published, written once the incident is resolved. Resolved incidents without
  a published one are counted on the overview.
- **The clock:** resolving stops it, opening the incident again starts it. The overview shows the mean time to
  resolve over the last 90 days.

## Other products open incidents

Create an API token with the editor role under API tokens, and send it to the API (ADR 0023). A product sets
`external` so one problem is one incident, however often it reports: the same `source` and `reference` adds a note
to the first incident's timeline and answers 200 instead of opening a second.

```bash
curl -sf -X POST -H "Authorization: Bearer $INCIDENTS_API_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Brute force on vpn","severity":"high","products":["siem","vpn"],"external":{"source":"siem","reference":"sig-42"}}' \
  https://incidents.example.com/api/v1/incidents
```

Anywhere an incident id is accepted, its key (`INC-12`) is too.

## Run

```bash
openssl rand -hex 32 > openasy-kek
docker compose up -d
docker compose logs incidents | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

`openasy-kek` encrypts sign-in secrets in the database (ADR 0021). Keep it apart from the volume and with your
backups.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `INCIDENTS_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `INCIDENTS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `INCIDENTS_DB` | `/data/incidents.db` | SQLite file (WAL), on the `/data` volume |
| `INCIDENTS_RETENTION_DAYS` | `1095` | Resolved incidents older than this are deleted |
| `INCIDENTS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `INCIDENTS_HEADLESS` | `false` | `true` serves only the API |
| `INCIDENTS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)). Owners can also add identity providers under Settings, Sign-in |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

Incidents hold what people write about them, which can include personal data and details of a breach. Anyone with the
viewer role reads all of it. Deleting an incident deletes its timeline, tasks, evidence links and postmortem.

## Roles

Viewers read everything; editors also open and change incidents, write to the timeline, and manage tasks, evidence
and the postmortem; admins also delete incidents, and manage members and API tokens (ADR 0003).

## Develop

```bash
npm install
npm test        # the lifecycle of an incident, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
