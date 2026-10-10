# Jishnu Infotech Support Portal

Jishnu Infotech Support Portal is a support desk with two entry points: a **Client Portal** for creating an account, opening and tracking service requests, and replying to support; and a **Consultant Portal** for working the shared queue, assigning tickets, updating priorities/statuses, reviewing client profiles, and replying to clients. Tickets persist in PostgreSQL. The portal displays the final `resolved` ticket status as **Closed**.

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

Open the Vite URL printed in the terminal (normally `http://localhost:5173`) and choose the Client Portal or Consultant Portal on the sign-in screen.

On an empty database, the app creates only the Super Admin specified by `SEED_CONSULTANT_EMAIL`, `SEED_CONSULTANT_PASSWORD`, and `SEED_CONSULTANT_CONTACT_NUMBER`. Set these values in `.env` before the first start. No companies, clients, or sample tickets are created. The Super Admin can create client companies after signing in.

To clear a local development database, run `npm run db:reset-local -- --confirm`. The command only accepts a localhost PostgreSQL connection, clears application records and uploaded attachment files, and preserves schema migrations. Configure a Super Admin bootstrap account in `.env` before signing in again.

## Production configuration

Set `NODE_ENV=production`, `DATABASE_URL` to your PostgreSQL connection string, a unique random `JWT_SECRET` of at least 32 bytes, and the three Super Admin bootstrap values from `.env.example` before first startup. Set `APP_BASE_URL` to the public HTTPS URL. The first start of an empty database creates only this Super Admin. Build the frontend with `npm run build`, then run `npm start`; the Node server serves the built UI and API together.

The bootstrap values are only used when the PostgreSQL database has no users. The Super Admin password must be at least 12 characters. After confirming the Super Admin can sign in, remove the `SEED_*` values from the hosting environment. Do not expose an unconfigured instance to the public internet.

Run `npm test` to execute the local unit tests. The app records applied PostgreSQL schema versions in `schema_migrations`; the initial schema baseline is applied before the server starts. Back up production data before deploying a schema upgrade and confirm the hosting provider's backup and restore process.

### Importing the existing SQLite data

Set `DATABASE_URL` to a new, empty PostgreSQL database, then run `npm run db:import-sqlite`. The importer opens `data/ticketing.sqlite` read-only, preserves record IDs, and refuses to import if the PostgreSQL database already contains users. You can pass another SQLite file path as the command argument. Keep the original SQLite database and `data/attachments` files until you have verified the imported records and copied any attachments you need.

### Multiple client companies

Jishnu Infotech Consultants work across client companies. Client accounts and tickets are scoped to a company: regular client users see their own tickets, company administrators can review their company's tickets and manage company users, and the Super Admin can manage all companies and the Consultant team.

Jishnu workspace administrators create a company and invite its first company administrator from **Companies**. Each client company supports all three onboarding paths:

- Individual user invitations sent by a company administrator.
- A reusable company invitation code, valid for 30 days and revocable by a company administrator.
- Public registration with company selection. These accounts stay pending until approved by a company administrator.

Company email domains are optional and configured by a Jishnu administrator. They route inbound email for previously unknown senders; only enter a domain after verifying that the company controls it.

### Ticket routing and attachments

When a client opens a ticket, they can choose a preferred Jishnu Infotech Consultant or leave assignment on automatic routing. The Super Admin sets Primary/Secondary Consultant order in **Settings**. Automatic ticket assignments follow that priority first and use the lowest unresolved workload to break ties. Inbound email uses the same routing. The ticket's assignment history records automatic assignment and subsequent Consultant changes. Tickets assigned to a Consultant appear in **Assigned to me**. Clients can attach up to five PDF, JPEG, PNG, or WebP files (10 MB each). Uploads are signature-checked, stored outside the public web root, and only downloadable by users authorized to access that ticket.

### Email setup

Set these values in the server's private `.env` file (never commit mailbox credentials):

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, and, when required, `SMTP_USER` / `SMTP_PASSWORD` enable outbound ticket replies, password recovery, and Consultant invitations.
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_MAILBOX`, `IMAP_USER`, and `IMAP_PASSWORD` enable inbound mail polling. Gmail/Google Workspace can use `imap.gmail.com` with IMAP enabled; some organizations require a mailbox app password. OAuth is not implemented.
- `APP_BASE_URL` must be the externally reachable portal URL so emailed invitation and reset links point to the correct deployment. `IMAP_POLL_INTERVAL_MS` defaults to 30 seconds.

Outbound Consultant replies are recorded in a retrying outbox (up to five delivery attempts); the Super Admin can see pending, sent, and failed totals in **Settings**. Inbound messages use IMAP UID cursors, Message-ID deduplication, and mail reply headers to attach responses to the corresponding ticket. Previously unknown senders are auto-associated only when an active company has a matching configured email domain; other messages are logged and left out of client tickets until an administrator configures the domain. Auto-provisioned clients can use **Forgot password?** to set their own password. SMTP and IMAP are optional for local development but must be configured for production invitations and password recovery.

### Team and service targets

The Super Admin can invite Consultants, enable/disable Consultant accounts, and configure response/resolution targets under **Settings**. Invitations and password-reset links are single-use and expire after 48 hours and 30 minutes respectively. In local development, invitation/reset links are shown in the UI when SMTP is not configured; production requires SMTP for those workflows.

Default SLAs are **4 elapsed hours** for first response and **48 elapsed hours** for resolution. They count nights and weekends; business calendars, holidays, and time-zone-aware schedules are not implemented. Overdue alerts appear in the assigned Consultant's **Notifications**. The first existing Consultant is promoted to Super Admin on startup if the workspace has no Super Admin.

### Reports and analytics

The Super Admin can view workspace-wide reports and compare ticket and Consultant activity across companies. Company Admins see reports scoped only to their own company; regular Consultants do not have access to reports. Reports cover a selectable 7-, 30-, or 90-day period and include ticket activity, current backlog, status and priority mix, channels, Consultant workload/assignments/resolutions, client-user tickets raised and progressed, company volume (Super Admin only), and SLA performance. CSV exports include the same authorized scope as the dashboard. Company Admins never receive other companies' customer metrics.

### Ticket collaboration and customer feedback

Tickets include a category, optional comma-separated tags, and up to 10 custom name/value fields. Consultants can update those details. Consultants can add internal notes alongside customer-visible replies; private notes never enter client ticket details, ticket previews, or outbound email. The selected ticket refreshes every 10 seconds in the Consultant inbox so teammates can see new notes and replies. The ticket owner can submit one 1–5 star rating and optional comment after a ticket is closed. The portal navigation and ticket conversation adapt to narrow mobile screens.

## Scope and deployment notes

- **Available:** company-scoped client accounts and tickets, Company Admins, email invitations, join codes, approval-gated self-registration, client-selected Consultant routing, Super Admin-configurable Primary/Secondary Consultant order, assignment history, private ticket attachments, ticket categories/tags/custom fields, Consultant-only internal notes, post-resolution customer ratings, responsive mobile portal, Consultant inbox/status/priority/assignment controls, client directory, ticket search/filters, periodic inbox refresh, Consultant invitation and team access controls, one-time client password recovery, SMTP outbox, IMAP email intake/threading, configurable elapsed-hour SLAs, Consultant notifications, and role-scoped workload reports with CSV export.
- **Storage:** PostgreSQL is the application database. Configure automated backups, TLS, least-privilege credentials, connection limits, and a managed PostgreSQL service for production. Ticket attachments remain on the configured filesystem path and need persistent shared storage in multi-instance deployments.
- **Process model:** run one app replica while inbound IMAP polling and filesystem attachment storage are enabled. Multiple replicas require shared object storage and coordinated background processing.
- **Email:** live delivery and inbox synchronization cannot be verified until valid SMTP/IMAP credentials and provider permissions are configured.
- **Not included:** company SSO, business-hours SLA calendars, and knowledge base.

### Deploying on Bluehost with EasyPanel

In EasyPanel, create a native Postgres service and an App service from this repository using the root `Dockerfile`. Keep PostgreSQL private, copy its internal connection URL into the app's `DATABASE_URL`, and route the public HTTPS domain to the app on port `3001`. Configure a persistent App volume at `/app/data/attachments` and the environment variables listed in `deploy/easypanel/README.md`, including the initial Super Admin's email, password, and contact number. Set `APP_BASE_URL` to the same HTTPS domain. Configure remote database and attachment backups before using the portal with clients.

## API overview

- `POST /api/auth/login`, `POST /api/auth/register` (client-only), `POST /api/auth/password-reset`, `POST /api/auth/password-reset/complete`
- `GET /api/auth/agent-invitations/validate`, `POST /api/auth/agent-invitations/accept`, `POST /api/agent-invitations` (administrator)
- `GET /api/companies/available`, `POST /api/auth/client-invitations/accept`, `POST /api/company/invitations`
- `GET/POST /api/admin/companies`, `GET/PATCH /api/company/users`, `POST/DELETE /api/company/join-codes`
- `GET /api/admin/agents`, `PATCH /api/agents/:id`, `GET/PUT /api/admin/sla-settings`, `GET /api/admin/email-status`, `GET /api/reports?days=7|30|90`
- `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/notifications`, `POST /api/notifications/read`
- `GET /api/tickets`, `POST /api/tickets`, `GET /api/tickets/:id`
- `GET /api/tickets/:id/attachments/:attachmentId`
- `POST /api/tickets/:id/messages` (set `internal: true` for Consultant-only notes), `POST /api/tickets/:id/rating`, `PATCH /api/tickets/:id`
- `GET /api/customers`, `GET /api/agents` (agents only)
- `GET /api/health`

The API uses an HTTP-only, same-site session cookie. The production cookie is marked secure and production startup requires `JWT_SECRET`.
