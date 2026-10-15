# Jishnu Infotech Support Portal — Platform Guide

This guide describes the support portal as implemented in this repository. It is for client users, company administrators, Consultants, Super Admins, and the people who maintain the deployment.

## Contents

1. [Platform overview](#platform-overview)
2. [Roles and access](#roles-and-access)
3. [Signing in](#signing-in)
4. [Client portal](#client-portal)
5. [Consultant workspace](#consultant-workspace)
6. [Company administration](#company-administration)
7. [Super Admin administration](#super-admin-administration)
8. [Ticket lifecycle and service targets](#ticket-lifecycle-and-service-targets)
9. [Reports](#reports)
10. [Security and data handling](#security-and-data-handling)
11. [Deployment and maintenance](#deployment-and-maintenance)
12. [Troubleshooting](#troubleshooting)

## Platform overview

The portal provides one support workspace for Jishnu Infotech Consultants and isolated workspaces for client companies. Users sign in with a username and password. Client accounts belong to one or more companies; tickets and client data are restricted to the appropriate company scope. Consultants work the shared support queue and Super Admins manage the Jishnu workspace.

The application consists of a React/Vite web interface and an Express API served by the same Node.js process in production. PostgreSQL stores accounts, companies, tickets, conversation messages, notifications, reports data, and configuration. Ticket attachment files are stored on the configured filesystem volume.

The portal includes ticket creation and replies, status and priority controls, Consultant assignment and routing, customer and company administration, Consultant-only notes, notifications, reports, resolved-ticket knowledge browsing, attachments, and mobile-responsive screens. Email addresses are optional contact details for account creation; the primary sign-in method is username and password.

## Roles and access

| Role | Main access |
| --- | --- |
| Client user | Company inbox, own tickets, ticket conversations, new ticket form, attachments, ticket rating after closure. |
| Company Admin | Client user access plus all tickets for their company, company-user management, and company-scoped reports. |
| Consultant | Shared Inbox, Assigned to me, customer directory, notifications, Knowledge Base, ticket response and workflow controls. |
| Super Admin | Consultant access plus workspace-wide reports, company and Company Admin management, Consultant team, routing order, and service-level target settings. |

Access checks are enforced by the API as well as the interface. A client cannot use a modified URL or request to read another company's ticket. Company reports are restricted to that company; only a Super Admin has workspace-wide reports.

## Signing in

1. Open the support portal in a browser and select the Client Portal or Consultant Portal tab on the sign-in screen.
2. Enter the account username and password. Usernames and passwords are case-sensitive.
3. If a client account has memberships in more than one company, select the company workspace after sign-in. The account can switch companies from the header.
4. Use the profile/sign-out control in the left navigation to end the session.

New accounts are usually provisioned by an administrator with a username and initial password. Email is optional for manually created accounts, and account creation/reset by an administrator does not depend on SMTP. Share initial passwords through a private, secure channel and ask users to change them where a password-change workflow is available.

## Client portal

### Company inbox and My tickets

- **Company inbox** shows company tickets the signed-in client is permitted to access. Company Admins can review the company's tickets; regular client users see their own tickets.
- **My tickets** filters to tickets opened by the signed-in client.
- Ticket lists can be filtered by status and priority. The header search is available on Inbox and My tickets and searches ticket subject, client name, and latest message.
- Select a ticket to read its history, check status/priority, view its Consultant assignment, and reply.
- The list's **Refresh** action requests the latest ticket data immediately. Ticket data also refreshes periodically while the session is open.

### Creating a ticket

1. Select **New ticket**.
2. Choose a category (Functional or Technical), enter a concise subject and description, and choose a priority.
3. Add up to five supported attachments if needed: PDF, JPEG, PNG, or WebP, up to 10 MB per file.
4. Submit the request. Assignment can be automatic or follow the available Consultant choice where shown.

The new ticket appears in the appropriate inbox. The assigned Consultant receives a notification; Consultants can also receive a focused new-ticket alert in their workspace.

### Ticket conversation and rating

Client replies appear in the same ticket conversation as Consultant replies. Internal notes are never shown to clients. After a ticket is closed, the ticket owner can provide a one-time 1–5 star rating and optional comment.

## Consultant workspace

### Inbox

The Inbox is the shared queue. It provides status tabs for All tickets, Open, In progress, Waiting, and Closed; a customer filter; priority information; and ticket totals. The header search is shown here and on **Assigned to me** only. Use the refresh control at the bottom of the list to fetch current tickets and notifications.

Select a ticket to open its conversation and ticket details. Consultants can:

- Reply to the client or add a Consultant-only internal note.
- Change ticket status and priority.
- Assign or reassign a ticket when permitted. The current assignee can manage their ticket; Super Admins can manage assignments across the workspace.
- View customer/company details, attachments, SLA targets, and assignment history.
- Open a customer record from the Customers directory and review the client's support history.

### Assigned to me

This view contains tickets assigned to the signed-in Consultant. It has the same status and priority filters, ticket details, and conversation actions as the Inbox. The count beside the navigation item excludes closed tickets.

### Notifications and new-ticket alerts

Notifications include ticket replies and SLA alerts assigned to the Consultant. Selecting a notification opens the related ticket. Newly assigned ticket notices are specific to the Consultant and include the ticket details; they do not broadcast client content to unrelated accounts.

### Knowledge Base

The Knowledge Base lists resolved/closed tickets and their recorded solutions for Consultants. Search across resolved tickets and filter by customer. Open a record to review its conversation and any authorized attachments. This is a reference view of resolved work, not a separate article authoring system.

## Company administration

Company Admins use **Company users** to manage accounts within their own company:

- Create a client login with full name, username, mobile number, and initial password. Email is optional.
- Edit an existing client account's name, mobile number, and optional email from the company members list. A Super Admin can edit the same details for any company.
- Enable/disable users and reset passwords.
- Promote an eligible user to Company Admin or remove Company Admin access.
- Review and approve or decline pending registration requests where public registration is enabled.
- Generate a company invitation code. Codes are company-specific, expire after 30 days, and can be revoked.
- Review all company tickets and company-scoped reports.

Client usernames are unique within a company, so separate companies may use the same username. A single client account can also be linked to multiple companies and select a workspace after login. Consultant usernames are unique within the Consultant team.

## Super Admin administration

### Companies

From **Companies**, a Super Admin can create an isolated company workspace and its first Company Admin. Required fields include company name, administrator name, username, initial password, mobile number, and support-valid-until date. Administrator email is optional; SMTP is not required to create this account. Select a company to manage its users, support date, invitations, and access.

The Super Admin can link an existing client account to an additional company. The client then selects the desired company after signing in.

### Consultant team and routing

From **Settings**, create Consultant accounts with a name, username, mobile number, specialty, and initial password. Work email is optional. Super Admins can edit a Consultant's name, username, mobile number, and optional email, change their specialty, reset passwords, and enable or disable accounts. Specialty can be Functional, Technical, or Both.

Automatic assignment follows Consultant routing priority (Primary before Secondary and later priorities), then uses unresolved workload to break ties. Consultants who do not support the ticket category are not eligible for that assignment. Use the routing controls in Settings to change order.

### Service-level targets

Settings provides configurable elapsed-hour targets for first response and resolution. Targets count nights and weekends; business calendars and holiday schedules are not implemented. Overdue alerts appear in the assigned Consultant's notifications and ticket details.

## Ticket lifecycle and service targets

Tickets use these statuses:

| Status | Meaning |
| --- | --- |
| Open | New or not yet being actively worked. |
| In progress | A Consultant is actively working on the request. |
| Waiting | Work is waiting on a client or another dependency. |
| Closed (stored as `resolved`) | The support request is resolved. The ticket owner may submit a rating. |

Priority options are Low, Normal, High, and Urgent. Category and optional tags help organize work. Consultants can add up to 10 custom name/value fields to capture ticket-specific information. Assignment history records automatic assignment and later changes.

The configured SLA values are elapsed hours from ticket creation. They are not a guarantee of service and do not pause outside working hours. The portal displays first-response and resolution due times while a ticket is active and flags missed targets.

## Reports

Super Admins see workspace-wide reports; Company Admins see only their company's data. Reports allow 7-, 30-, or 90-day periods and include ticket activity, current backlog, status/priority/channel mix, Consultant workload and outcomes, client-user ticket activity, SLA performance, and company volume where authorized. CSV export follows the same access scope as the displayed report. Regular Consultants and client users do not have Reports access.

## Security and data handling

- Passwords are stored as bcrypt hashes, not plaintext. Never put passwords, `DATABASE_URL`, or `JWT_SECRET` into source control, screenshots, or support messages.
- Authentication uses an HTTP-only session cookie. Production requires HTTPS and a configured JWT secret; the production cookie is secure.
- Ticket and attachment routes check authorization. Attachments are stored outside the public web root, signature-checked, and limited by type and size.
- Internal notes are Consultant-only and must not be used for information intended for clients.
- Use unique, strong passwords and restrict database/network access. Configure database and attachment backups before entering production records.
- Account creation and reset do not require SMTP when done by an administrator. Optional email-based invitations, password recovery, outbound mail, and inbound mailbox processing require the relevant mail configuration and provider permissions.

## Deployment and maintenance

### Local development

Requirements: a supported Node.js version listed in `package.json` and PostgreSQL 17 or compatible.

```powershell
npm install
Copy-Item .env.example .env
```

Create a local database, set `DATABASE_URL` in `.env`, and set a bootstrap Super Admin username and password with `SEED_CONSULTANT_USERNAME` and `SEED_CONSULTANT_PASSWORD`. Then start the API and frontend:

```powershell
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). Build the production frontend with `npm run build`; run the production server with `npm start`.

### Production deployment

For the current EasyPanel deployment, create a private PostgreSQL service and an App service built from the repository `Dockerfile`. Configure the app's port as `3001`, route the public HTTPS hostname to it, and mount persistent storage at `/app/data/attachments`. Required environment variables and the step-by-step setup are in [deploy/easypanel/README.md](../deploy/easypanel/README.md).

At minimum, production needs `NODE_ENV=production`, `PORT`, `DATABASE_URL`, `ATTACHMENTS_PATH`, `JWT_SECRET`, and `APP_BASE_URL`. Set the `SEED_CONSULTANT_USERNAME` and `SEED_CONSULTANT_PASSWORD` values only for first-time provisioning or the documented one-active-Super-Admin synchronization behavior. After confirming the initial sign-in, remove bootstrap credentials from the hosting environment. Never copy example secrets into a public deployment.

Keep one app replica while filesystem attachment storage and built-in IMAP polling are in use. Multiple replicas require shared object storage and coordinated background processing. Configure off-server database and attachment backups and periodically verify restore procedures.

### Database and destructive maintenance

Schema migrations run during startup. Back up production before a deployment that changes the schema. The local reset command only accepts a localhost database:

```powershell
npm run db:reset-local -- --confirm
```

The production reset command is intentionally destructive: it removes all companies, users, tickets, messages, settings, and stored attachments. It requires an explicit confirmation environment variable and should only be run after pausing the app, taking backups, and following the repository README's production-reset procedure. Do not use it to troubleshoot a login or deployment problem.

### Desktop and Android launchers

The Windows installer creates a Desktop shortcut that opens the portal URL in the default browser. It does not install a browser extension or store credentials. The Android launcher opens the portal in the phone's default browser and does not handle sign-in itself. See [desktop-shortcut-installer/README.md](../desktop-shortcut-installer/README.md) and [android-launcher/README.md](../android-launcher/README.md) for install/build details.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| “Invalid username or password” | Confirm the correct portal tab, exact username/password capitalization, account status, and company membership. Ask an administrator to reset the account password if needed. |
| Company cannot be created because SMTP is missing | Direct company and first-admin creation should not require SMTP. Confirm the deployed build contains the current repository changes and inspect server logs for the API error. Legacy email invitations do require mail configuration. |
| Company/client user cannot sign in | Confirm the account was created/approved, is enabled, belongs to the selected company, and uses the exact case-sensitive username. An administrator can reset the password. |
| “Failed to fetch” or an API 500 | Check `/api/health`, app logs, database health/connection URL, latest migration errors, and that the browser is using the HTTPS domain matching the certificate. A UI refresh cannot repair a server or database error. |
| Portal shows a hosting “Service is not reachable” page | In the hosting panel, check whether the app process is running, inspect startup logs, verify required environment variables, and confirm the app binds to the configured port. |
| Attachments disappear after deployment | Confirm the persistent volume is mounted at the same `ATTACHMENTS_PATH`; container-local files can be lost on redeploy. |
| Email-related capability is unavailable | SMTP and IMAP are optional integrations. Verify their server-side environment variables and provider permissions; do not place mailbox credentials in the frontend. |
| Changes do not appear on the live portal | Confirm the intended branch/repository is connected to the hosting service, the commit reached that branch, auto-deploy is enabled or a deploy was started, and the newest deployment completed successfully. Hard-refresh the browser after deployment. |

## Related references

- [Repository README](../README.md) — current feature and API overview.
- [EasyPanel deployment guide](../deploy/easypanel/README.md) — host configuration and go-live checks.
- [Windows shortcut installer guide](../desktop-shortcut-installer/README.md).
- [Android launcher guide](../android-launcher/README.md).

