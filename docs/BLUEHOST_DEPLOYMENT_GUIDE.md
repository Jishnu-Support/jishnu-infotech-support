# Complete Bluehost VPS Deployment Guide
**Project:** Jishnu Infotech Support System (`jit_support`)  
**Production Server:** Bluehost Linux VPS (`129.121.128.205`)  
**Management Dashboard:** Easypanel (`http://129.121.128.205:3000`)  
**Repository:** `https://github.com/Jishnu-Support/jishnu-infotech-support.git` (Branch: `main`)  

---

## 1. Architecture & Deployment Workflow

```mermaid
flowchart LR
    LocalDev[Local Windows / Git] -->|git push origin main| GitHub[GitHub Repo: Jishnu-Support]
    GitHub -->|Webhook / Re-deploy| Easypanel[Easypanel at 129.121.128.205:3000]
    subgraph Bluehost VPS Container Network
        Easypanel --> Traefik[Traefik / Nginx Reverse Proxy: SSL 443]
        Traefik --> AppContainer["App Container (github)<br>Node.js 24 + Express + Vite (Port 3001)"]
        AppContainer --> AttachmentVol[("Volume Mount<br>/app/data/attachments")]
        AppContainer --> PostgresContainer[("Postgres Container (jit)<br>Port 5432 (Private)")]
    end
```

---

## 2. Routine Deployment: Updating the App (Ongoing Updates)

Whenever you make code changes locally on your Windows PC and want them live on the Bluehost server:

### Step 1: Commit and Push to GitHub
In Windows PowerShell (inside `C:\Users\HP\.gemini\antigravity\scratch\jishnu-infotech-support`):

```powershell
git status
git add .
git commit -m "Update feature / bug fix description"
git push origin main
```

---

### Step 2: Trigger Deployment in Easypanel
1. Open your browser and navigate to Easypanel:  
   👉 **`http://129.121.128.205:3000`**
2. In the left menu, click **Projects** &rarr; select **`jit_support`**.
3. Click on the App service named **`github`**.
4. In the top-right corner, click the **Deploy** button (or **Rebuild**).

---

### Step 3: Monitor Build & Deployment Logs
1. Click the **Deployments** tab inside the `github` service.
2. Click on the latest deployment run to view the build logs.
3. You will see Docker execute the multi-stage build:
   - `npm ci` (Installs dependencies)
   - `npm run build` (Compiles TypeScript & Vite assets to `/dist`)
   - Container startup (`npm start` &rarr; `node server/index.js`)
4. Verify the deployment finishes with:
   ```text
   Application listening on port 3001
   Database schema verified / migrations applied
   Deployment successful
   ```

---

### Step 4: Health Check Verification
Open your browser and visit:
```text
http://129.121.128.205:3001/api/health
```
*(Or your custom domain e.g. `https://support.yourdomain.com/api/health`)*

Expected JSON response:
```json
{"status":"ok"}
```

---

## 3. Fresh Server Setup: Initial Deployment from Scratch

If you ever need to set up a brand new Bluehost VPS:

### Step 1: Provision the VPS
- **OS / Plan:** Ubuntu / Debian LTS (Minimum 2 vCPU, 4GB RAM, 50GB NVMe storage).
- **Firewall Ports:**
  - Allow Inbound TCP `80` (HTTP) and `443` (HTTPS).
  - Allow Inbound TCP `3000` (Easypanel Admin).
  - Restrict Inbound TCP `22` (SSH) to your trusted IP.
  - **DO NOT** expose TCP `5432` (PostgreSQL must stay private).

---

### Step 2: Install Easypanel (If Not Pre-installed)
Connect via SSH and install Docker + Easypanel:
```bash
curl -sSL https://get.easypanel.io | sh
```
Open `http://<YOUR_VPS_IP>:3000` and create the initial admin account.

---

### Step 3: Create the PostgreSQL Database Service
1. In Easypanel &rarr; **Projects** &rarr; **Create Project** &rarr; name it `jit_support`.
2. Click **New Service** &rarr; select **PostgreSQL**.
3. Name the service: `jit`.
4. Leave it internal (Do not enable public port exposure).
5. Once healthy, navigate to the **Credentials** page and copy the internal `DATABASE_URL` (format: `postgres://user:password@jit:5432/jit_support`).

---

### Step 4: Create the Application Service
1. In the `jit_support` project &rarr; **New Service** &rarr; select **App**.
2. Service name: `github`.
3. Set **Source** to **Git Repository**:
   - Repository: `https://github.com/Jishnu-Support/jishnu-infotech-support.git`
   - Branch: `main`
   - Build Method: **Dockerfile**
   - Dockerfile path: `/Dockerfile`

---

### Step 5: Configure Persistent Storage Volume
1. Inside the `github` App service &rarr; open the **Storage** tab.
2. Click **Add Volume**:
   - **Mount Path:** `/app/data/attachments`
   - **Volume Name:** `attachments`
   *(This ensures ticket attachments and uploaded user manuals are never lost when the container rebuilds).*

---

### Step 6: Set Production Environment Variables
In the `github` App service &rarr; open the **Environment** tab and enter:

```dotenv
NODE_ENV=production
PORT=3001
DATABASE_URL=postgres://jit:PASSWORD_FROM_CREDENTIALS@jit:5432/jit_support
ATTACHMENTS_PATH=/app/data/attachments
JWT_SECRET=GENERATE_64_CHAR_HEX_STRING_HERE
APP_BASE_URL=https://support.yourdomain.com

# Seed Initial Super Admin (Remove these after first successful login!):
SEED_CONSULTANT_USERNAME=superadmin
SEED_CONSULTANT_PASSWORD=SuperAdminPassword123!
SEED_CONSULTANT_NAME=Jishnu Infotech Super Admin

# Optional Email Services:
SMTP_HOST=smtp.yourmailserver.com
SMTP_PORT=587
SMTP_USER=support@yourdomain.com
SMTP_PASS=your_email_password
SMTP_FROM="Jishnu Support <support@yourdomain.com>"
```

---

### Step 7: Configure Custom Domain & Automatic SSL
1. Inside the `github` App service &rarr; open the **Domains** tab.
2. Click **Add Domain**:
   - Host: `support.yourdomain.com`
   - Port: `3001`
   - Enable HTTPS: **Checked** (Traefik automatically issues free Let's Encrypt SSL).
3. In your DNS provider (Cloudflare / Bluehost / GoDaddy), add an **A Record**:
   - **Name:** `support`
   - **Target / Value:** `129.121.128.205`

---

## 4. Rollback & Emergency Recovery

If a deployment introduces a bug:
1. Open Easypanel &rarr; **Projects** &rarr; **`jit_support`** &rarr; **`github`**.
2. Click the **Deployments** tab.
3. Find the previous stable build and click **Rollback**.
4. If database corruption occurred, use the backup file created earlier:
   ```bash
   gunzip -c /tmp/db_backup.sql.gz | psql -U $POSTGRES_USER -d $POSTGRES_DB
   ```

---

## 5. Deployment Troubleshooting Matrix

| Issue | Cause | Fix |
|---|---|---|
| **Build fails at `npm run build`** | TypeScript error or missing asset | Run `npm run build` locally on Windows first to catch errors before pushing. |
| **App crashes on startup with `DATABASE_URL` error** | Invalid DB connection string or Postgres container starting up | Check that `jit` Postgres service is in status "Running" and `DATABASE_URL` has correct credentials. |
| **Uploaded files disappear after deployment** | Missing volume mount | Verify `/app/data/attachments` is mapped to a named Docker volume in the **Storage** tab. |
| **502 Bad Gateway error on domain** | Node.js process failed to bind port `3001` | Check App service logs in Easypanel; ensure `PORT=3001` is defined in Environment settings. |
| **Database changes not reflected** | Migrations pending | The server runs `db.js` migrations automatically on startup; check the startup log for migration errors. |
