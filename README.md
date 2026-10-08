# Jishnu Infotech Support Portal

Jishnu Infotech Support Portal is an early support-desk MVP with two distinct entry points: a **Client Portal** for creating an account, opening and tracking service requests, and replying to support; and an **Agent Portal** for working the shared queue, assigning tickets, updating priorities/statuses, reviewing client profiles, and replying to clients. Tickets persist in PostgreSQL. The portal displays the final `resolved` ticket status as **Closed**.

The portal branding uses the logo and favicon published on [Jishnu Infotech's official website](https://jishnuinfotech.com/).

## Run locally

Requirements: Node.js 20.19.x, 22.12.x or newer within Node 22, or Node 24.x; and PostgreSQL 17 or compatible.

```powershell
npm install
Copy-Item .env.example .env
# Create the jishnu_support database in PostgreSQL before starting the app.
# Set DATABASE_URL in .env to the local PostgreSQL connection string.
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`) and choose the Client Portal or Agent Portal on the sign-in screen.

### Demo accounts

- Agent Portal: `alex@relaysupport.test` / `Support123!`
- Client Portal: `sam@northstar.test` / `Customer123!`

Demo credentials are for local development only. The initial sample records are created when the configured PostgreSQL database is empty. To reset local demo data, use a separate empty development database; the application does not delete or reset database records automatically.

## Production configuration

Set `NODE_ENV=production`, `DATABASE_URL` to your PostgreSQL connection string, a unique random `JWT_SECRET` of at least 32 bytes, and the four seed email/password values from `.env.example` before first startup. Set `APP_BASE_URL` to the public HTTPS URL for deployments outside Render; Render supplies its public URL automatically. Optionally set the initial agent/client names and client company name. Production startup creates those two administrator accounts but does not add demo tickets; local development still seeds sample tickets. Build the frontend with `npm run build`, then run `npm start`; the Node server serves the built UI and API together.

The seed values are only used when the PostgreSQL database is empty. Production seed passwords must each be at least 12 characters. The first seeded agent becomes the workspace administrator, and the seeded client becomes the initial company administrator. Do not use demo credentials or expose an unconfigured instance to the public internet.

### Importing the existing SQLite data

Set `DATABASE_URL` to a new, empty PostgreSQL database, then run `npm run db:import-sqlite`. The importer opens `data/ticketing.sqlite` read-only, preserves record IDs, and refuses to import if the PostgreSQL database already contains users. You can pass another SQLite file path as the command argument. Keep the original SQLite database and `data/attachments` files until you have verified the imported records and copied any attachments you need.

### Multiple client companies

Jishnu Infotech agents work across client companies. Client accounts and tickets are scoped to a company: regular client users see their own tickets, company administrators can review their company's tickets and manage company users, and Jishnu workspace administrators can manage all companies and the shared support team.

Jishnu workspace administrators create a company and invite its first company administrator from **Companies**. Each client company supports all three onboarding paths:

- Individual user invitations sent by a company administrator.
- A reusable company invitation code, valid for 30 days and revocable by a company administrator.
- Public registration with company selection. These accounts stay pending until approved by a company administrator.

Company email domains are optional and configured by a Jishnu administrator. They route inbound email for previously unknown senders; only enter a domain after verifying that the company controls it.

### Ticket routing and attachments

When a client opens a ticket, they can choose a preferred Jishnu support agent or leave assignment on automatic routing. Workspace administrators set Primary/Secondary agent order in **Settings**. Automatic ticket assignments follow that priority first and use the lowest unresolved workload to break ties. Inbound email uses the same routing. The ticket's assignment history records automatic assignment and subsequent agent changes. Tickets assigned to an agent appear in **Assigned to me**. Clients can attach up to five PDF, JPEG, PNG, or WebP files (10 MB each). Uploads are signature-checked, stored outside the public web root, and only downloadable by users authorized to access that ticket.

### Email setup

Set these values in the server's private `.env` file (never commit mailbox credentials):

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, and, when required, `SMTP_USER` / `SMTP_PASSWORD` enable outbound ticket replies, password recovery, and agent invitations.
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_MAILBOX`, `IMAP_USER`, and `IMAP_PASSWORD` enable inbound mail polling. Gmail/Google Workspace can use `imap.gmail.com` with IMAP enabled; some organizations require a mailbox app password. OAuth is not implemented.
- `APP_BASE_URL` must be the externally reachable portal URL so emailed invitation and reset links point to the correct deployment. `IMAP_POLL_INTERVAL_MS` defaults to 30 seconds.

Outbound agent replies are recorded in a retrying outbox (up to five delivery attempts); administrators can see pending, sent, and failed totals in **Settings**. Inbound messages use IMAP UID cursors, Message-ID deduplication, and mail reply headers to attach responses to the corresponding ticket. Previously unknown senders are auto-associated only when an active company has a matching configured email domain; other messages are logged and left out of client tickets until an administrator configures the domain. Auto-provisioned clients can use **Forgot password?** to set their own password. SMTP and IMAP are optional for local development but must be configured for production invitations and password recovery.

### Team and service targets

Workspace administrators can invite agents, enable/disable agents, and configure response/resolution targets under **Settings**. Invitations and password-reset links are single-use and expire after 48 hours and 30 minutes respectively. In local development, invitation/reset links are shown in the UI when SMTP is not configured; production requires SMTP for those workflows.

Default SLAs are **4 elapsed hours** for first response and **48 elapsed hours** for resolution. They count nights and weekends; business calendars, holidays, and time-zone-aware schedules are not implemented. Overdue alerts appear in the assigned agent's **Notifications**. The first existing agent is promoted to administrator on startup if the workspace has no administrator.

### Reports and analytics

Support agents can view workspace-wide reports; client company administrators see reports scoped to their own company. Reports cover a selectable 7-, 30-, or 90-day period and include ticket activity, current backlog, status and priority mix, channels, per-agent current workload/assignments/resolutions, client-user tickets raised and progressed, company volume (support team only), and SLA performance. CSV exports include the same authorized scope as the dashboard. Company administrators never receive other companies' customer metrics; workspace administrators can compare ticket and agent activity across companies.

### Ticket collaboration and customer feedback

Tickets include a category, optional comma-separated tags, and up to 10 custom name/value fields. Support agents can update those details. Agents can add internal notes alongside customer-visible replies; private notes never enter client ticket details, ticket previews, or outbound email. The selected ticket refreshes every 10 seconds in the agent inbox so teammates can see new notes and replies. The ticket owner can submit one 1–5 star rating and optional comment after a ticket is closed. The portal navigation and ticket conversation adapt to narrow mobile screens.

## Scope and deployment notes

- **Available:** company-scoped client accounts and tickets, company administrators, email invitations, join codes, approval-gated self-registration, client-selected agent routing, admin-configurable Primary/Secondary assignment order, assignment history, private ticket attachments, ticket categories/tags/custom fields, agent-only internal notes, post-resolution customer ratings, responsive mobile portal, agent inbox/status/priority/assignment controls, client directory, ticket search/filters, periodic inbox refresh, agent invitation and team access controls, one-time client password recovery, SMTP outbox, IMAP email intake/threading, configurable elapsed-hour SLAs, agent notifications, and role-scoped workload reports with CSV export.
- **Storage:** PostgreSQL is the application database. Configure automated backups, TLS, least-privilege credentials, connection limits, and a managed PostgreSQL service for production. Ticket attachments remain on the configured filesystem path and need persistent shared storage in multi-instance deployments.
- **Email:** live delivery and inbox synchronization cannot be verified until valid SMTP/IMAP credentials and provider permissions are configured.
- **Not included:** company SSO, business-hours SLA calendars, and knowledge base.

### Deploying on Render

The root `render.yaml` Blueprint configures a single Render web service and persistent disk for private ticket attachments. Configure `DATABASE_URL` in Render with a PostgreSQL connection string from your database provider, along with the initial agent and company-administrator email/passwords and names. Keep the generated `JWT_SECRET` private. The attachment disk is local to one service instance; configure shared object storage before scaling to multiple instances.

The app automatically uses Render's external HTTPS URL for invitation and password-reset links unless `APP_BASE_URL` is explicitly set. Configure SMTP in the Render service environment before inviting users or relying on email replies and password recovery. Configure IMAP credentials only if the support inbox should create and update tickets automatically. The health check verifies PostgreSQL connectivity. Verify the deployed `/api/health` endpoint and complete an agent login, client login, ticket/reply, attachment, and email-delivery check before sharing the portal with customers.

## API overview

- `POST /api/auth/login`, `POST /api/auth/register` (client-only), `POST /api/auth/password-reset`, `POST /api/auth/password-reset/complete`
- `GET /api/auth/agent-invitations/validate`, `POST /api/auth/agent-invitations/accept`, `POST /api/agent-invitations` (administrator)
- `GET /api/companies/available`, `POST /api/auth/client-invitations/accept`, `POST /api/company/invitations`
- `GET/POST /api/admin/companies`, `GET/PATCH /api/company/users`, `POST/DELETE /api/company/join-codes`
- `GET /api/admin/agents`, `PATCH /api/agents/:id`, `GET/PUT /api/admin/sla-settings`, `GET /api/admin/email-status`, `GET /api/reports?days=7|30|90`
- `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/notifications`, `POST /api/notifications/read`
- `GET /api/tickets`, `POST /api/tickets`, `GET /api/tickets/:id`
- `GET /api/tickets/:id/attachments/:attachmentId`
- `POST /api/tickets/:id/messages` (set `internal: true` for agent-only notes), `POST /api/tickets/:id/rating`, `PATCH /api/tickets/:id`
- `GET /api/customers`, `GET /api/agents` (agents only)
- `GET /api/health`

The API uses an HTTP-only, same-site session cookie. The production cookie is marked secure and production startup requires `JWT_SECRET`.
