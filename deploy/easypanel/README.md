# Bluehost VPS deployment with EasyPanel

Use an EasyPanel **App** service for the Node.js application and a separate native **Postgres** service. This keeps PostgreSQL private and lets EasyPanel manage database backup schedules. Both services still share one VPS, so this is a single-server deployment without high availability.

## 1. Provision the VPS

- Select the 2 vCPU, 4 GB RAM, 100 GB NVMe plan and the Bluehost EasyPanel software image.
- Allow inbound TCP 80 and 443 for web traffic and restrict SSH (TCP 22) to trusted addresses where possible. Do not expose PostgreSQL's port.
- Point the intended subdomain's DNS A record to the VPS public IP and wait for DNS to resolve.
- Open EasyPanel and create a project for the support portal.

## 2. Create PostgreSQL

In the project, select **New Service > Postgres**. Use PostgreSQL 17 (the project is configured for PostgreSQL 17 or compatible), set a database name and user, and generate a strong unique password. Keep the service private; do not enable public port exposure. Wait until it is healthy, then copy its **internal connection URL** from the EasyPanel Credentials page.

## 3. Create the app

Select **New Service > App**, choose this Git repository and deployment branch, then choose the Dockerfile builder and set the Dockerfile path to `/Dockerfile` (or the repository-relative path shown by EasyPanel). The app listens on port `3001` and exposes `/api/health` as its health endpoint.

Add these environment variables to the App service:

```dotenv
NODE_ENV=production
PORT=3001
DATABASE_URL=PASTE_THE_PRIVATE_POSTGRES_CONNECTION_URL
ATTACHMENTS_PATH=/app/data/attachments
JWT_SECRET=GENERATE_A_LONG_RANDOM_SECRET
APP_BASE_URL=https://support.example.com
SEED_CONSULTANT_USERNAME=superadmin
SEED_CONSULTANT_PASSWORD=SET_A_UNIQUE_PASSWORD_OF_AT_LEAST_12_CHARACTERS
SEED_CONSULTANT_NAME=Jishnu Infotech Super Admin
# Optional contact fields:
SEED_CONSULTANT_EMAIL=
SEED_CONSULTANT_CONTACT_NUMBER=
```

Generate `JWT_SECRET` with `openssl rand -hex 32` on a trusted machine. Never commit or share it. Use the exact public HTTPS domain for `APP_BASE_URL`; production startup rejects HTTP URLs. The bootstrap Super Admin password must be at least 12 characters. The PostgreSQL URL should be copied from the private service credentials; do not construct it manually because generated passwords may contain URL-special characters.

SMTP and IMAP variables are optional. The Super Admin signs in with the configured username and password. Company and Consultant accounts can be created directly with usernames and initial passwords, and administrators can reset passwords without email. Configure SMTP only for optional outbound ticket email, legacy invitations, and self-service email recovery. Configure IMAP only if inbound mailbox-to-ticket processing is needed.

In the App service's **Storage** settings, add a persistent **Volume** mounted at `/app/data/attachments`. Ticket attachments and User Manual audio/video uploads and guide documents are stored on this same volume; User Manual files use its `user-manuals` subfolder. Keep the app at one replica because attachment storage and IMAP polling are not coordinated across multiple replicas.

Deploy the app and review its logs. On the first startup with an empty database, it creates the Super Admin account. After confirming that account can sign in, remove the `SEED_CONSULTANT_*` variables and redeploy; they are bootstrap-only settings.

## 4. Attach the domain and verify

In the App service's **Domains** settings, add the subdomain and route it to container port `3001` with HTTPS enabled. EasyPanel's proxy handles public routing and the certificate. Do not attach a domain to the Postgres service.

Before inviting real clients:

- Open `https://support.example.com/api/health` and confirm it returns `{"status":"ok"}`.
- Sign in as the Super Admin; create a company and client user; verify ticket creation, replies, and attachment upload/download.
- Configure remote PostgreSQL backups in the Postgres service's **Backups** tab. Run a manual backup and test restoration into a non-production database.
- Configure a separate remote volume backup for the App service's attachment volume. Volume backup is a mirror, not a versioned snapshot; enable versioning/retention at the storage provider if available.
- Store backups outside the VPS so a server or disk failure does not destroy the backup too.
- Configure SMTP only if you plan to use outbound ticket email, legacy invitations, or email password recovery.
- Schedule Linux/EasyPanel updates and monitor memory and disk usage.

Keep database credentials and all application secrets in EasyPanel's environment settings, not in the repository. Back up the database and attachments before changing service names, volume mounts, or database versions.
