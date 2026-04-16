#!/bin/bash
# ============================================================
# MoveEasy Infrastructure Setup
# AWS EC2 af-south-1 · Ubuntu 22.04 LTS
# IP: 13.245.30.253
# ============================================================

set -euo pipefail

DOMAIN="api.moveeasy.co.za"
APP_DIR="/opt/moveeasy"
APP_USER="moveeasy"
NODE_VERSION="20"

echo "============================================================"
echo " MoveEasy Infrastructure Setup — af-south-1"
echo "============================================================"

# ─────────────────────────────────────────────
# 1. SYSTEM UPDATES
# ─────────────────────────────────────────────
echo "[1/10] Updating system packages..."
apt-get update -y && apt-get upgrade -y
apt-get install -y curl wget git unzip build-essential

# ─────────────────────────────────────────────
# 2. NODE.JS 20
# ─────────────────────────────────────────────
echo "[2/10] Installing Node.js ${NODE_VERSION}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs
npm install -g pm2 typescript tsx

echo "Node version: $(node --version)"
echo "NPM version:  $(npm --version)"

# ─────────────────────────────────────────────
# 3. NGINX
# ─────────────────────────────────────────────
echo "[3/10] Installing Nginx..."
apt-get install -y nginx
systemctl enable nginx

# Copy config
cp /home/ubuntu/moveeasy/infra/nginx/api.moveeasy.co.za.conf \
   /etc/nginx/sites-available/${DOMAIN}
ln -sf /etc/nginx/sites-available/${DOMAIN} \
       /etc/nginx/sites-enabled/${DOMAIN}
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# ─────────────────────────────────────────────
# 4. CERTBOT SSL
# ─────────────────────────────────────────────
echo "[4/10] Installing Certbot..."
apt-get install -y certbot python3-certbot-nginx
mkdir -p /var/www/certbot

echo "INFO: Ensure DNS A record for ${DOMAIN} → 13.245.30.253 before running:"
echo "  certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m devops@moveeasy.co.za"

# ─────────────────────────────────────────────
# 5. POSTGRESQL CLIENT
# ─────────────────────────────────────────────
echo "[5/10] Installing PostgreSQL client..."
apt-get install -y postgresql-client-14

# ─────────────────────────────────────────────
# 6. APP USER + DIRECTORY
# ─────────────────────────────────────────────
echo "[6/10] Creating app user..."
id -u ${APP_USER} &>/dev/null || useradd -m -s /bin/bash ${APP_USER}
mkdir -p ${APP_DIR}
chown -R ${APP_USER}:${APP_USER} ${APP_DIR}

# ─────────────────────────────────────────────
# 7. APP DEPLOYMENT
# ─────────────────────────────────────────────
echo "[7/10] Deploying application..."
cp -r /home/ubuntu/moveeasy/* ${APP_DIR}/
chown -R ${APP_USER}:${APP_USER} ${APP_DIR}

cd ${APP_DIR}
sudo -u ${APP_USER} npm install

# ─────────────────────────────────────────────
# 8. ENVIRONMENT FILE
# ─────────────────────────────────────────────
echo "[8/10] Setting up environment..."
cat > ${APP_DIR}/.env << 'EOF'
# MoveEasy Environment — FILL IN BEFORE DEPLOYMENT
NODE_ENV=production
PORT_API=3001
PORT_BRAIN=3002

# JWT
JWT_SECRET=CHANGE_ME_STRONG_RANDOM_SECRET_256BIT

# Database (AWS RDS PostgreSQL)
DATABASE_URL=postgresql://moveeasy_user:CHANGE_ME@your-rds-endpoint.af-south-1.rds.amazonaws.com:5432/moveeasy

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=CHANGE_ME

# Smile ID (KYC)
SMILE_ID_API_KEY=CHANGE_ME
SMILE_ID_PARTNER_ID=CHANGE_ME
SMILE_ID_CALLBACK_URL=https://api.moveeasy.co.za/api/auth/kyc/webhook

# Nedbank Payment Gateway
NEDBANK_API_KEY=CHANGE_ME
NEDBANK_MID=CHANGE_ME
NEDBANK_TID=CHANGE_ME
NEDBANK_WEBHOOK_SECRET=CHANGE_ME

# Softy Comp / Ozow
OZOW_SITE_CODE=CHANGE_ME
OZOW_PRIVATE_KEY=CHANGE_ME
OZOW_API_KEY=CHANGE_ME

# PayFast (shared merchant account)
PAYFAST_MERCHANT_ID=CHANGE_ME
PAYFAST_MERCHANT_KEY=CHANGE_ME
PAYFAST_PASSPHRASE=CHANGE_ME

# VALR (crypto / USDC for SafeBet)
VALR_API_KEY=CHANGE_ME
VALR_API_SECRET=CHANGE_ME

# Investec API
INVESTEC_CLIENT_ID=CHANGE_ME
INVESTEC_CLIENT_SECRET=CHANGE_ME

# Clickatell SMS
CLICKATELL_API_KEY=CHANGE_ME

# Anthropic (AI Brain)
ANTHROPIC_API_KEY=CHANGE_ME

# AWS
AWS_REGION=af-south-1
AWS_S3_BUCKET=moveeasy-documents

# Redis (BullMQ job queues)
REDIS_URL=redis://127.0.0.1:6379
EOF

chmod 600 ${APP_DIR}/.env
chown ${APP_USER}:${APP_USER} ${APP_DIR}/.env

# ─────────────────────────────────────────────
# 9. PM2 PROCESS MANAGER
# ─────────────────────────────────────────────
echo "[9/10] Configuring PM2..."
cat > ${APP_DIR}/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'moveeasy-api',
      script: 'tsx',
      args: 'core/api.ts',
      cwd: '/opt/moveeasy',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '500M',
      error_file: '/var/log/pm2/moveeasy-api-error.log',
      out_file: '/var/log/pm2/moveeasy-api-out.log',
      merge_logs: true,
    },
    {
      name: 'moveeasy-brain',
      script: 'tsx',
      args: 'ai-orchestrator/brain-server.ts',
      cwd: '/opt/moveeasy',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      instances: 1,
      max_memory_restart: '300M',
      error_file: '/var/log/pm2/moveeasy-brain-error.log',
      out_file: '/var/log/pm2/moveeasy-brain-out.log',
    },
    {
      name: 'moveeasy-workers',
      script: 'tsx',
      args: 'core/workers.ts',
      cwd: '/opt/moveeasy',
      env_production: {
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '300M',
    }
  ]
};
EOF

mkdir -p /var/log/pm2
sudo -u ${APP_USER} pm2 start ${APP_DIR}/ecosystem.config.js --env production
sudo -u ${APP_USER} pm2 save
pm2 startup systemd -u ${APP_USER} --hp /home/${APP_USER}

# ─────────────────────────────────────────────
# 10. REDIS (BullMQ job queues)
# ─────────────────────────────────────────────
echo "[10/10] Installing Redis..."
apt-get install -y redis-server
systemctl enable redis-server
systemctl start redis-server

# ─────────────────────────────────────────────
# FIREWALL
# ─────────────────────────────────────────────
echo "Configuring UFW firewall..."
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (redirect)
ufw allow 443/tcp   # HTTPS
ufw --force enable

# ─────────────────────────────────────────────
# DATABASE SCHEMA
# ─────────────────────────────────────────────
echo ""
echo "============================================================"
echo " NEXT STEPS:"
echo "============================================================"
echo "1. Update ${APP_DIR}/.env with real credentials"
echo "2. Set DNS: ${DOMAIN} → 13.245.30.253"
echo "3. Run SSL: certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m devops@moveeasy.co.za"
echo "4. Apply schema: psql \$DATABASE_URL < ${APP_DIR}/infra/postgres/schema.sql"
echo "5. Check PM2: pm2 status"
echo "6. Check Nginx: nginx -t && systemctl status nginx"
echo ""
echo " MoveEasy API will be live at: https://${DOMAIN}"
echo "============================================================"
