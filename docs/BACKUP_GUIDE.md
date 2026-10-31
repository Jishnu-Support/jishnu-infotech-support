# Production Server Backup & Restore Guide
**Project:** Jishnu Infotech Support System (`jit_support`)  
**Server Host:** Bluehost VPS (`129.121.128.205`)  
**Management Panel:** Easypanel (`http://129.121.128.205:3000`)  

---

## Table of Contents
1. [Overview & Server Details](#overview--server-details)
2. [Step-by-Step: Backing Up the PostgreSQL Database](#step-by-step-backing-up-the-postgresql-database)
3. [Step-by-Step: Backing Up Uploaded Attachments & Manuals](#step-by-step-backing-up-uploaded-attachments--manuals)
4. [How to Restore the Database (Disaster Recovery)](#how-to-restore-the-database-disaster-recovery)
5. [Quick Troubleshooting](#quick-troubleshooting)

---

## 1. Overview & Server Details

| Item | Details |
|------|---------|
| **Easypanel URL** | `http://129.121.128.205:3000` |
| **Project Name** | `jit_support` |
| **PostgreSQL Service** | `jit` |
| **Node.js App Service** | `github` |
| **Database Environment Variables** | `$POSTGRES_USER`, `$POSTGRES_DB` (pre-configured inside container) |
| **Attachments Path** | `/app/data/attachments` (in `github` service) |

---

## 2. Step-by-Step: Backing Up the PostgreSQL Database

Follow these exact steps whenever you want to take a fresh database backup:

### Step 1: Open the Database Terminal
1. Open your web browser and log into Easypanel: `http://129.121.128.205:3000`
2. Go to **Projects** → **jit_support**
3. Click on the PostgreSQL service named **`jit`**
4. Click on **Console** (or **Terminal**) in the top menu and click **Bash**
5. You will see the shell prompt: `root@...:/#`

---

### Step 2: Create the Compressed Database Dump
Run this single command to dump and compress the database into `/tmp`:

```bash
pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > /tmp/db_backup.sql.gz && echo "Backup created successfully!"
```

---

### Step 3: Upload the Backup to Generate a Download Link
Run this command in the same terminal:

```bash
curl -F "file=@/tmp/db_backup.sql.gz" https://tmpfiles.org/api/v1/upload
```

You will see output like:
```json
{"status":"success","data":{"url":"https://tmpfiles.org/XXXXXX/db_backup.sql.gz"}}
```

---

### Step 4: Download to Your Windows Computer
1. Take the URL from Step 3 (e.g. `https://tmpfiles.org/XXXXXX/db_backup.sql.gz`).
2. Add **`/dl/`** right after `tmpfiles.org`:
   - **Original URL:** `https://tmpfiles.org/XXXXXX/db_backup.sql.gz`
   - **Download Link:** `https://tmpfiles.org/dl/XXXXXX/db_backup.sql.gz`
3. Paste the download link into Chrome / Edge to save `db_backup.sql.gz` into your **Downloads** folder.

*Alternatively, from Windows PowerShell, you can download it directly:*
```powershell
curl.exe -L -o "$HOME\Downloads\db_backup.sql.gz" "https://tmpfiles.org/dl/XXXXXX/db_backup.sql.gz"
```

---

### Step 5: Decompress the `.sql.gz` File (On Windows)
To extract the `.sql.gz` file into readable `.sql`:
- **Option A:** Use **7-Zip** (Right-click `db_backup.sql.gz` → 7-Zip → *Extract Here*).
- **Option B (PowerShell):**
```powershell
$inPath = "$HOME\Downloads\db_backup.sql.gz"
$outPath = "$HOME\Downloads\db_backup.sql"
$inFile = [System.IO.File]::OpenRead($inPath)
$outFile = [System.IO.File]::Create($outPath)
$gzip = New-Object System.IO.Compression.GZipStream($inFile, [System.IO.Compression.CompressionMode]::Decompress)
$gzip.CopyTo($outFile)
$gzip.Dispose(); $outFile.Dispose(); $inFile.Dispose()
Write-Host "Extracted to $outPath"
```

---

### Step 6: Clean Up the Server
Return to the Easypanel terminal and delete the temporary backup:

```bash
rm /tmp/db_backup.sql.gz
```

---

## 3. Step-by-Step: Backing Up Uploaded Attachments & Manuals

Ticket attachments and manuals are stored in the app service container (`github`).

### Step 1: Open the App Container Console
1. In Easypanel, go to **Projects** → **jit_support** → **`github`** (App service).
2. Click **Console** → **Bash**.

### Step 2: Archive the Attachments Folder
Run:
```bash
tar -czf /tmp/attachments_backup.tar.gz -C /app/data attachments && echo "Attachments archived!"
```

### Step 3: Upload and Download
```bash
curl -F "file=@/tmp/attachments_backup.tar.gz" https://tmpfiles.org/api/v1/upload
```
1. Add `/dl/` to the returned URL and download it in your browser.
2. Clean up server temporary archive:
```bash
rm /tmp/attachments_backup.tar.gz
```

---

## 4. How to Restore the Database (Disaster Recovery)

If you ever need to restore your database on a fresh server or rollback data:

1. Copy the `.sql` or `.sql.gz` file into the container (or upload it to `/tmp/db_backup.sql.gz` using curl).
2. Open the PostgreSQL (`jit`) service Bash console.
3. If restoring from `.sql.gz`:
   ```bash
   gunzip -c /tmp/db_backup.sql.gz | psql -U $POSTGRES_USER -d $POSTGRES_DB
   ```
4. If restoring from `.sql`:
   ```bash
   psql -U $POSTGRES_USER -d $POSTGRES_DB < /tmp/db_backup.sql
   ```
5. Check that tables and data are restored:
   ```bash
   psql -U $POSTGRES_USER -d $POSTGRES_DB -c "\dt"
   ```

---

## 5. Quick Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `bash: curl: command not found` | Curl not installed in container | Run: `apt-get update && apt-get install -y curl` |
| `bash: pg_dump: command not found` | You are in the app (`github`) container instead of DB | Switch to the **`jit`** PostgreSQL service console |
| `role "postgres" does not exist` | Hardcoding `postgres` user name | Always use `$POSTGRES_USER` environment variable |
| Download gives an HTML page | Missing direct download link format | Make sure to insert `/dl/` after `tmpfiles.org` in the URL |
