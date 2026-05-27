# MetaTraffic LPR — Deployment Guide

## Server Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB |
| Disk | 20 GB | 40 GB+ (photos grow over time) |
| Node.js | v18+ | v20 LTS |
| MySQL | 8.0+ | 8.0 |
| Nginx | 1.18+ | latest |

---

## 1 — Server Setup

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install MySQL 8
sudo apt install -y mysql-server
sudo mysql_secure_installation

# Install Nginx
sudo apt install -y nginx

# Install PM2 (process manager)
sudo npm install -g pm2
```

---

## 2 — MySQL Database

```sql
-- Run as root
CREATE DATABASE metatraffic_lpr CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'lpr_user'@'localhost' IDENTIFIED BY 'your-strong-password';
GRANT ALL PRIVILEGES ON metatraffic_lpr.* TO 'lpr_user'@'localhost';
FLUSH PRIVILEGES;
```

Then create the schema:

```bash
mysql -u lpr_user -p metatraffic_lpr < schema.sql
```

### schema.sql

```sql
CREATE TABLE IF NOT EXISTS court (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  court_name  VARCHAR(64) NOT NULL,
  created_at  INT NOT NULL,
  updated_at  INT NOT NULL,
  deleted_at  INT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  location_code  VARCHAR(32) NOT NULL UNIQUE,
  address1       VARCHAR(64) DEFAULT NULL,
  address2       VARCHAR(64) DEFAULT NULL,
  city           VARCHAR(64) DEFAULT NULL,
  state          VARCHAR(32) DEFAULT NULL,
  zip            VARCHAR(10) DEFAULT NULL,
  court_id       BIGINT DEFAULT NULL,
  is_school_zone ENUM('Y','N') NOT NULL DEFAULT 'N',
  created_at     INT NOT NULL,
  updated_at     INT NOT NULL,
  deleted_at     INT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                    INT PRIMARY KEY AUTO_INCREMENT,
  email                 VARCHAR(255) NOT NULL UNIQUE,
  password_hash         VARCHAR(255) NOT NULL,
  first_name            VARCHAR(64) NOT NULL,
  last_name             VARCHAR(64) NOT NULL,
  role                  ENUM('admin','manager','basic') NOT NULL DEFAULT 'basic',
  two_fa_method         ENUM('none','totp','sms') NOT NULL DEFAULT 'none',
  totp_secret           VARCHAR(64) DEFAULT NULL,
  sms_code              VARCHAR(10) DEFAULT NULL,
  sms_code_expires      INT DEFAULT NULL,
  phone                 VARCHAR(20) DEFAULT NULL,
  notify_enabled        TINYINT(1) NOT NULL DEFAULT 0,
  notify_sms            TINYINT(1) NOT NULL DEFAULT 0,
  notify_email          TINYINT(1) NOT NULL DEFAULT 0,
  password_reset_token  VARCHAR(128) DEFAULT NULL,
  password_reset_expires INT DEFAULT NULL,
  last_login_at         INT DEFAULT NULL,
  created_at            INT NOT NULL,
  updated_at            INT NOT NULL,
  deleted_at            INT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS lpr_reads (
  id                   BIGINT PRIMARY KEY AUTO_INCREMENT,
  guid                 VARCHAR(36) NOT NULL UNIQUE,
  license_plate        VARCHAR(20) NOT NULL,
  license_plate_state  VARCHAR(5) NOT NULL,
  make                 VARCHAR(64) DEFAULT '',
  model                VARCHAR(64) DEFAULT '',
  color                VARCHAR(32) DEFAULT '',
  timestamp            VARCHAR(32) DEFAULT NULL,
  location             VARCHAR(64) DEFAULT '',
  location_id          BIGINT DEFAULT NULL,
  received_at          VARCHAR(32) DEFAULT NULL,
  photo_url            VARCHAR(512) DEFAULT NULL,
  INDEX idx_plate (license_plate),
  INDEX idx_received (received_at),
  INDEX idx_location (location_id)
);

CREATE TABLE IF NOT EXISTS mapping_user_location (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  user_id      INT NOT NULL,
  location_id  BIGINT NOT NULL,
  created_at   INT NOT NULL,
  updated_at   INT NOT NULL,
  deleted_at   INT DEFAULT NULL,
  INDEX idx_user (user_id),
  INDEX idx_location (location_id)
);

CREATE TABLE IF NOT EXISTS bolo (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  batch_id     VARCHAR(36) NOT NULL,
  state        VARCHAR(5) DEFAULT NULL,
  plate        VARCHAR(20) DEFAULT NULL,
  make         VARCHAR(64) DEFAULT NULL,
  model        VARCHAR(64) DEFAULT NULL,
  color        VARCHAR(32) DEFAULT NULL,
  uploaded_by  INT NOT NULL,
  created_at   INT NOT NULL,
  updated_at   INT DEFAULT NULL,
  deleted_at   INT DEFAULT NULL,
  INDEX idx_batch (batch_id),
  INDEX idx_deleted (deleted_at)
);

CREATE TABLE IF NOT EXISTS notification_audit (
  id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  read_guid           VARCHAR(36) NOT NULL,
  location_code       VARCHAR(32) DEFAULT NULL,
  license_plate       VARCHAR(20) DEFAULT NULL,
  license_plate_state VARCHAR(5)  DEFAULT NULL,
  make                VARCHAR(64) DEFAULT NULL,
  model               VARCHAR(64) DEFAULT NULL,
  color               VARCHAR(32) DEFAULT NULL,
  bolo_id             INT NOT NULL,
  match_type          VARCHAR(32) NOT NULL,
  notified_user_id    INT NOT NULL,
  channel             VARCHAR(8) NOT NULL,
  status              VARCHAR(16) NOT NULL,
  error_message       VARCHAR(512) DEFAULT NULL,
  sent_at             INT NOT NULL,
  INDEX idx_sent (sent_at),
  INDEX idx_user (notified_user_id)
);

CREATE TABLE IF NOT EXISTS authentication_audit_log (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id     INT DEFAULT NULL,
  email       VARCHAR(255) DEFAULT NULL,
  event_type  VARCHAR(64) NOT NULL,
  ip_address  VARCHAR(45) DEFAULT NULL,
  user_agent  VARCHAR(512) DEFAULT NULL,
  created_at  INT NOT NULL
);
```

---

## 3 — Application Deployment

```bash
# Create app user (don't run as root)
sudo useradd -m -s /bin/bash lprapp
sudo su - lprapp

# Clone the repository
git clone https://github.com/your-org/lpr-web.git /home/lprapp/lpr-web
cd /home/lprapp/lpr-web

# Install dependencies
npm install --omit=dev

# Create photos directory
mkdir -p photos

# Set up environment file
cp .env.example .env
nano .env    # fill in all values (see section 4)
```

---

## 4 — Environment Variables

Edit `/home/lprapp/lpr-web/.env`:

```env
MYSQL_HOST=localhost
MYSQL_USER=lpr_user
MYSQL_PASSWORD=your-db-password
MYSQL_DATABASE=metatraffic_lpr

SESSION_SECRET=<run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_SECRET=your-api-secret
TWILIO_FROM_NUMBER=+1xxxxxxxxxx

SES_SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SES_SMTP_USER=your-ses-iam-user
SES_SMTP_PASS=your-ses-smtp-password
SES_FROM_EMAIL=lpr@yourdomain.com

BASE_URL=https://yourdomain.com
PORT=3000
```

```bash
# Lock down the env file
chmod 600 .env
```

---

## 5 — PM2 Process Manager

```bash
# Start the app
pm2 start server.js --name lpr-web

# Save so it restarts on reboot
pm2 save
pm2 startup    # follow the printed command to enable on boot

# Useful commands
pm2 status          # view running processes
pm2 logs lpr-web    # tail logs
pm2 restart lpr-web # restart after a deploy
pm2 reload lpr-web  # zero-downtime reload
```

---

## 6 — Nginx Reverse Proxy

Create `/etc/nginx/sites-available/lpr-web`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Photos — served directly by Nginx (faster than Node)
    location /photos/ {
        alias /home/lprapp/lpr-web/photos/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # Increase upload limit for photo uploads (LPR devices)
    client_max_body_size 12M;

    # WebSocket support for Socket.IO
    location /socket.io/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # All other traffic → Node app
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/lpr-web /etc/nginx/sites-enabled/
sudo nginx -t          # verify config
sudo systemctl reload nginx
```

---

## 7 — SSL Certificate (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
# Certbot auto-renews — verify with:
sudo certbot renew --dry-run
```

---

## 8 — File Permissions

```bash
# Photos directory must be writable by the app user
sudo chown -R lprapp:lprapp /home/lprapp/lpr-web/photos
sudo chmod 755 /home/lprapp/lpr-web/photos

# If Nginx serves photos directly, nginx user needs read access
sudo usermod -aG lprapp www-data
```

---

## 9 — Deploying Updates

```bash
cd /home/lprapp/lpr-web
git pull origin main
npm install --omit=dev
pm2 reload lpr-web    # zero-downtime reload
```

---

## 10 — Sync Locations from External API

After first deploy (or whenever the location list needs refreshing):

```bash
# As admin — hit the sync endpoint
curl -X POST https://yourdomain.com/api/admin/sync-locations \
  -H "Cookie: lpr_session=<your-admin-session-cookie>"
```

Or trigger it from the browser while logged in as an admin user.

---

## 11 — LPR Device API Reference

Point your LPR devices at the following endpoints. No authentication required on ingest endpoints.

### Submit a read
```
POST https://yourdomain.com/api/reads
Content-Type: application/json

{
  "guid":                 "a1b2c3d4-e5f6-4789-ab01-0123456789ab",
  "license_plate":        "ABC1234",
  "license_plate_state":  "NH",
  "make":                 "Toyota",
  "model":                "Camry",
  "color":                "White",
  "timestamp":            "2026-01-15T14:30:00.000Z",
  "location":             "LOC-001"
}
```

### Upload vehicle photo
```
POST https://yourdomain.com/api/photo/<GUID>
Content-Type: multipart/form-data
Field: photo  (JPEG, max 10 MB)
```

---

## 12 — Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # ports 80 + 443
sudo ufw enable
sudo ufw status
# Port 3000 should NOT be publicly exposed — Nginx proxies it
```

---

## 13 — Monitoring & Logs

```bash
# App logs (stdout/stderr via PM2)
pm2 logs lpr-web --lines 100

# Nginx access + error logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# MySQL slow query log (optional)
# Add to /etc/mysql/mysql.conf.d/mysqld.cnf:
# slow_query_log = 1
# slow_query_log_file = /var/log/mysql/slow.log
# long_query_time = 2
```

---

## Quick-start Checklist

- [ ] Server provisioned (Ubuntu 22.04)
- [ ] Node.js 20, MySQL 8, Nginx, PM2 installed
- [ ] Database `metatraffic_lpr` created with dedicated user
- [ ] Schema imported via `schema.sql`
- [ ] Repo cloned, `npm install --omit=dev` run
- [ ] `.env` created from `.env.example` and filled in
- [ ] `photos/` directory created and writable
- [ ] PM2 started and saved for boot
- [ ] Nginx site config created and enabled
- [ ] SSL certificate issued
- [ ] Firewall configured (80, 443, SSH only)
- [ ] Logged in as admin, triggered location sync
- [ ] Changed default admin password
