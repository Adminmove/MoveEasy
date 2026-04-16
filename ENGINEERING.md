# MoveEasy — Full System Engineering Documentation

**Version**: 1.0.0  
**Region**: AWS af-south-1 (Cape Town)  
**Server**: 13.245.30.253 · api.moveeasy.co.za  
**Agreements**: Nedbank Card Acquiring + Softy Comp (Purple Owl)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Product Suite](#2-product-suite)
3. [Architecture](#3-architecture)
4. [AI Brain Orchestrator](#4-ai-brain-orchestrator)
5. [Payment Rails](#5-payment-rails)
6. [Database Schema](#6-database-schema)
7. [API Reference](#7-api-reference)
8. [Infrastructure & Deployment](#8-infrastructure--deployment)
9. [Compliance Framework](#9-compliance-framework)
10. [Environment Variables](#10-environment-variables)
11. [Runbook](#11-runbook)

---

## 1. System Overview

MoveEasy is a shared fintech infrastructure platform built for the South African market. It provides a single technical foundation — one SSO, one unified wallet, once-only KYC, shared PayFast merchant account, and a central AI brain — that powers five distinct consumer and B2B financial products.

### Core Principle: Shared Infrastructure, Distinct Products

```
┌─────────────────────────────────────────────────────────┐
│                   MoveEasy Core Brain                    │
│         (Single SSO · Unified KYC · Unified Wallet)      │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│Easy      │Easy      │Safe      │Green     │MMP.ai       │
│Transect  │Fuel +    │Bet       │Wallet    │(B2B Trade)  │
│          │FuelFlex  │          │          │             │
└──────────┴──────────┴──────────┴──────────┴─────────────┘
```

### Key Agreements Powering the Platform

| Agreement | Provider | Capabilities |
|-----------|----------|-------------|
| Nedbank Card Acquiring | Nedbank | Visa, Mastercard, Amex SafeKey, POS, PocketPOS, QR Pay, BNPL (Payflex/Floatpay), EBPP |
| Softy Comp (Purple Owl) | Purple Owl | Ozow EFT, Debit Orders, PayFast, VALR USDC |

---

## 2. Product Suite

### 2.1 EasyTransect — Super Wallet

**Purpose**: Aggregates SA mobile money products (FNB eWallet, MTN MoMo, Absa CashSend) into a single interface with PayFast EFT disbursement.

**Payment Rail**: Nedbank  
**Key Features**:
- Unified balance across all SA mobile money providers
- Instant EFT disbursement via PayFast
- QR code money transfers
- EBPP digital invoicing via Clickatell SMS

**API Endpoints**:
- `GET /api/wallet/balances` — fetch all wallet balances
- `POST /api/wallet/transfer` — initiate transfer
- `POST /api/payments/initiate` — start payment

---

### 2.2 EasyFuel + FuelFlex — Geo-Locked Fuel Vouchers

**Purpose**: Pre-purchase fuel vouchers with geo-lock enforcement at registered stations. FuelFlex is a BNPL sub-product.

**Payment Rail**: Nedbank  
**Geo-Lock**: PostGIS point + radius check on every voucher redemption

**FuelFlex Logic**:
```
1. User makes once-off deposit = full_tank_price
   (e.g. 50L × R23.80 = R1,190)

2. System issues 3 locked fuel vouchers
   Each voucher value = deposit / 3 = R396.67

3. To unlock each voucher:
   - User pays: 1/3 of voucher = R132.22
   - EasyFuel covers: 2/3 of voucher = R264.45

4. After all 3 vouchers used → cycle renews at current price
```

**API Endpoints**:
- `GET /api/easyfuel/vouchers` — list user vouchers
- `POST /api/easyfuel/create-voucher` — create standard voucher
- `POST /api/easyfuel/fuelflex/activate` — start FuelFlex agreement

---

### 2.3 SafeBet — Deposit Facilitator + USDC Savings

**Purpose**: Intercepts sports betting deposits, clips 7–10% into locked savings pot, converts to USDC via VALR for inflation protection.

**Payment Rail**: Softy Comp (Ozow EFT + Debit Orders)  
**Crypto Integration**: VALR + CCXT for USDC/ZAR swaps

**Savings Logic**:
```
Deposit: R200
├── Clip (10%): R20 → locked savings
│   └── USDC swap via VALR: ~1.08 USDC @ R18.50/USD
│       ├── Principal unlock: +3 months
│       └── Trading gains unlock: +12 months
└── Gambling wallet: R180 → user's betting account
```

**Unlock Schedule**:
- Month 3: Principal (ZAR equivalent of USDC purchased)
- Month 12: Trading gains (USDC appreciation + bot returns)

**API Endpoints**:
- `POST /api/safebet/deposit` — process deposit + clip
- `GET /api/safebet/account` — fetch account + locked balances

---

### 2.4 GreenWallet — Eco Micro-Savings

**Purpose**: Automatically clips 0.1% of every transaction across all products into an eco-investment fund for green projects.

**Payment Rail**: Both (triggered post-settlement)  
**Clip Rate**: 0.1% (0.001) — auto-triggered via PostgreSQL trigger on every completed payment_transaction

**Micro-clip Example**:
```
EasyFuel fill-up: R350
→ GreenWallet clip: R0.35 (0.1%)
→ Accumulated weekly clips → batch settled to green_projects
```

**API Endpoints**:
- `GET /api/greenwallet/balance` — balance + active project

---

### 2.5 MMP.ai — Africa-China B2B Trade

**Purpose**: AI-powered matching platform for African commodity exporters seeking Chinese buyers/processors.

**AI Model**: Claude Sonnet via Anthropic API  
**Features**:
- Commodity matching (minerals, agricultural products, timber)
- AI-generated price range estimates in USD/kg
- Supplier vetting narrative
- Deal flow status tracking

**API Endpoints**:
- `POST /api/mmpai/lead` — submit trade lead + get AI analysis

---

## 3. Architecture

### 3.1 Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Mobile Apps | React Native | iOS + Android apps for all 5 products |
| Web Dashboards | Next.js 14 | Operator + merchant dashboards |
| Edge API | Hono + Cloudflare Workers | Fast API routing, auth, rate limiting |
| Edge Data | Cloudflare D1 | Session state, telemetry cache |
| Core API | Hono on EC2 | Business logic, payment processing |
| Job Queues | BullMQ + Redis | Async processing (KYC, swaps, SMS) |
| Database | PostgreSQL 15 (RDS) | Financial records, ACID transactions |
| Real-time | Supabase | Live subscriptions, row-level security |
| Object Store | AWS S3 | KYC documents, voucher assets |
| Reverse Proxy | Nginx | SSL termination, rate limiting |
| Process Manager | PM2 | Multi-process Node.js management |
| AI Brain | Anthropic Claude Sonnet | Telemetry analysis, intelligence |

### 3.2 Network Flow

```
Client Apps
    │
    ▼ HTTPS/443
Cloudflare (edge CDN + DDoS)
    │
    ▼
Nginx (13.245.30.253)
├── /api/auth/*  → PM2 Process 1 (Port 3001) - rate: 10/min
├── /api/brain/* → PM2 Process 2 (Port 3002) - rate: 30/min, 90s timeout
├── /api/payments/webhook/* → PM2 Process 1 - Nedbank/Ozow IPs only
└── /api/*      → PM2 Process 1 - rate: 30/min
    │
    ├── PostgreSQL (RDS af-south-1)
    ├── Redis (localhost:6379) → BullMQ workers
    └── Supabase (real-time)
```

---

## 4. AI Brain Orchestrator

### 4.1 Overview

The MoveEasy Brain is a multi-turn Claude Sonnet powered intelligence engine that:

1. **Aggregates** telemetry from all 5 products in real-time
2. **Analyses** user financial behaviour across products
3. **Detects** fraud patterns, AML signals, unusual activity
4. **Recommends** cross-product upsell actions
5. **Clips** GreenWallet micro-amounts automatically
6. **Generates** plain-language financial health narratives

### 4.2 Action Types

| Action | Description | Priority |
|--------|-------------|----------|
| `upsell_offer` | Cross-product product offer | low/medium |
| `fraud_alert` | Suspicious activity detected | high/critical |
| `green_clip` | Initiate GreenWallet clip | low |
| `safebet_trigger` | User eligible for SafeBet | medium |
| `notification_sms` | Dispatch Clickatell SMS | varies |
| `compliance_flag` | AML/FICA flag for review | high/critical |
| `fuelflex_offer` | FuelFlex BNPL opportunity | medium |
| `mmpai_lead` | B2B trade opportunity detected | low |

### 4.3 Multi-turn Context

The Brain maintains conversation history within a session, enabling:
- Operator queries that reference previous analysis
- Follow-up questions about flagged users
- Comparative analysis across time periods

### 4.4 Financial Calculations

**GreenWallet Clip**:
```typescript
clip_zar = transaction_zar × 0.001  // 0.1%
```

**FuelFlex BNPL**:
```typescript
deposit_required = fuel_price_per_litre × tank_litres
per_voucher_value = deposit / 3
user_pays_per_unlock = per_voucher_value / 3     // 1/3
easyfuel_covers = per_voucher_value × (2/3)      // 2/3
```

**SafeBet Clip**:
```typescript
savings_clip = deposit × (clip_percent / 100)    // 7-10%
gambling_wallet = deposit - savings_clip
usdc_purchased = savings_clip / zar_usd_rate
principal_unlock = deposit_date + 3 months
gains_unlock = deposit_date + 12 months
```

---

## 5. Payment Rails

### 5.1 Nedbank Agreement Capabilities

| Feature | Method | Use Case |
|---------|--------|---------|
| Card Acquiring (online) | Visa, Mastercard | EasyTransect web payments |
| 3D Secure | Amex SafeKey | Online Amex payments |
| Physical POS | Nedbank terminal | Merchant card acceptance |
| Mobile POS | PocketPOS | Street vendor card acceptance |
| QR Scan-to-Pay | Nedbank QR | Contactless merchant payments |
| BNPL | Payflex / Floatpay | EasyFuel + EasyTransect checkout |
| EBPP | Digital invoicing | EasyTransect bill presentment (email/SMS) |

### 5.2 Softy Comp (Purple Owl) Capabilities

| Feature | Provider | Use Case |
|---------|----------|---------|
| Instant EFT | Ozow | SafeBet deposits, EasyTransect |
| Debit Orders | Purple Owl | SafeBet recurring savings clips |
| Shared Merchant Account | PayFast | All products payment collection |
| USDC Conversion | VALR + CCXT | SafeBet savings pot conversion |
| Investec Holding | Investec API | High-value SafeBet accounts |

### 5.3 Payment Flow (Nedbank Card)

```
User taps Pay
    │
    ▼
POST /api/payments/initiate
    │
    ├─ Visa/MC → Nedbank gateway URL redirect → 3DS (if required)
    ├─ Amex → Nedbank AmexSafeKey 3DS mandatory
    └─ QR → Generate QR payload → await scan
    │
    ▼
Nedbank gateway processes
    │
    ▼
POST /api/payments/webhook/nedbank
    │
    ├─ Update payment_transactions status
    ├─ Trigger GreenWallet clip (PostgreSQL trigger)
    ├─ Queue Clickatell SMS confirmation
    └─ Trigger Brain analysis (BullMQ)
```

### 5.4 Ozow EFT Flow

```
POST /api/payments/initiate (method: ozow_eft)
    │
    ▼
Generate Ozow payment URL with SHA-512 hash
    │
    ▼
User redirected to Ozow bank selection
    │
    ▼
User authenticates with their bank
    │
    ▼
POST /api/payments/webhook/ozow
    │
    └─ Same post-payment processing as above
```

---

## 6. Database Schema

### Key Tables

| Table | Purpose |
|-------|---------|
| `users` | Master user registry (phone-first) |
| `kyc_records` | Smile ID KYC results + status |
| `wallets` | Multi-type wallet balances per user |
| `wallet_transactions` | Immutable ledger of all balance changes |
| `payment_transactions` | All payment gateway transactions |
| `payment_methods` | Tokenised payment methods (PCI-DSS: no raw card data) |
| `merchants` | Registered merchants with geo-lock coordinates |
| `fuel_vouchers` | EasyFuel vouchers with QR + barcode |
| `fuelflex_agreements` | FuelFlex BNPL agreements |
| `safebet_accounts` | SafeBet account config |
| `safebet_deposits` | Locked savings records |
| `greenwallet_clips` | Micro-clip queue |
| `brain_telemetry_events` | Raw event stream |
| `brain_analyses` | Brain analysis outputs |
| `brain_actions` | Recommended + executed actions |
| `compliance_flags` | AML/FICA flags |
| `notifications` | SMS/email dispatch log |

### PostgreSQL Triggers

| Trigger | Table | Action |
|---------|-------|--------|
| `trigger_green_clip` | `payment_transactions` | Auto-insert `greenwallet_clips` on completed tx |
| `users_updated_at` | `users` | Auto-update `updated_at` timestamp |
| `wallets_updated_at` | `wallets` | Auto-update `updated_at` timestamp |

---

## 7. API Reference

### Base URL
```
https://api.moveeasy.co.za
```

### Authentication
All `/api/*` endpoints (except `/api/auth/*`) require:
```
Authorization: Bearer <JWT_TOKEN>
```

### Core Endpoints

#### Auth
```
POST /api/auth/register     — New user + trigger Smile ID KYC
POST /api/auth/login        — OTP login → JWT
POST /api/auth/kyc/webhook  — Smile ID result webhook (internal)
```

#### Wallet
```
GET  /api/wallet/balances   — All wallet types + totals
POST /api/wallet/transfer   — Move funds between products
```

#### Payments (Nedbank + Softy Comp)
```
POST /api/payments/initiate          — Initiate payment (any rail/method)
POST /api/payments/webhook/nedbank   — Nedbank settlement webhook
POST /api/payments/webhook/ozow      — Ozow EFT webhook
```

#### EasyFuel
```
GET  /api/easyfuel/vouchers           — List active vouchers
POST /api/easyfuel/create-voucher     — Create fuel voucher
POST /api/easyfuel/fuelflex/activate  — Start FuelFlex BNPL
```

#### SafeBet
```
POST /api/safebet/deposit  — Process deposit + clip + USDC queue
GET  /api/safebet/account  — Account status + locked balances
```

#### GreenWallet
```
GET /api/greenwallet/balance  — Balance + active project
```

#### AI Brain
```
POST /api/brain/analyse  — Trigger AI analysis for user
POST /api/brain/query    — Multi-turn operator question
```

#### MMP.ai
```
POST /api/mmpai/lead  — Submit trade lead + AI matching
```

#### EBPP
```
POST /api/ebpp/invoice  — Generate + dispatch digital invoice
```

---

## 8. Infrastructure & Deployment

### Server Details
- **Provider**: AWS EC2
- **Region**: af-south-1 (Cape Town)
- **IP**: 13.245.30.253
- **OS**: Ubuntu 22.04 LTS
- **Instance type**: Recommended: t3.medium (2 vCPU, 4GB RAM)

### Deployment Steps

```bash
# 1. Upload code to EC2
scp -r ./moveeasy ubuntu@13.245.30.253:/home/ubuntu/

# 2. Run setup script
ssh ubuntu@13.245.30.253
sudo bash /home/ubuntu/moveeasy/infra/aws/setup.sh

# 3. Update .env with real credentials
sudo nano /opt/moveeasy/.env

# 4. Ensure DNS: api.moveeasy.co.za → 13.245.30.253

# 5. Issue SSL cert (after DNS propagation ~5-15min)
sudo certbot --nginx -d api.moveeasy.co.za --non-interactive \
  --agree-tos -m devops@moveeasy.co.za

# 6. Apply database schema
psql $DATABASE_URL < /opt/moveeasy/infra/postgres/schema.sql

# 7. Restart services
sudo pm2 restart all
sudo systemctl restart nginx
```

### PM2 Process Management
```bash
pm2 status              # View all processes
pm2 logs moveeasy-api   # Tail API logs
pm2 logs moveeasy-brain # Tail Brain logs
pm2 restart all         # Restart everything
pm2 monit               # Real-time dashboard
```

---

## 9. Compliance Framework

### FICA (KYC)
- **Provider**: Smile ID — biometric + document verification
- **Gate**: All transactions blocked until `kyc_records.status = 'verified'`
- **Once-only**: Single KYC propagates to all 5 products via `kyc_records` table

### POPIA (Data Protection)
- All data stored in af-south-1 (SA data residency)
- Row-Level Security (RLS) in Supabase — users see only their own data
- PII redacted from Brain analysis prompts

### AML (Anti-Money Laundering)
- Brain automatically flags:
  - Structuring (multiple transactions just below reporting thresholds)
  - High velocity (unusual spike in transaction count)
  - Geo mismatch (EasyFuel voucher used far from registered station)
  - Blacklist match
- Flags stored in `compliance_flags` table
- SAR filing to FIC tracked with `sar_filed` boolean

### PCI-DSS (Card Data)
- **No raw card numbers stored** — Nedbank gateway handles all card data
- Only tokenised references and last 4 digits stored in `payment_methods`
- 3DS enforced for Amex (Nedbank SafeKey)

### SARB (Payment Systems)
- All payment processing via licensed PSPs (Nedbank, Ozow)
- No direct card scheme membership required
- EFT via NPS (National Payment System) compliant rails

---

## 10. Environment Variables

See `/opt/moveeasy/.env` — all variables listed with `CHANGE_ME` placeholders:

| Variable | Source | Notes |
|----------|--------|-------|
| `JWT_SECRET` | Generate | 256-bit random — `openssl rand -hex 32` |
| `DATABASE_URL` | AWS RDS | PostgreSQL connection string |
| `SMILE_ID_API_KEY` | Smile ID portal | KYC provider |
| `NEDBANK_API_KEY` | Nedbank agreement | Card acquiring |
| `NEDBANK_MID` | Nedbank agreement | Merchant ID |
| `OZOW_SITE_CODE` | Ozow dashboard | EFT site code |
| `OZOW_PRIVATE_KEY` | Ozow dashboard | HMAC-SHA512 signing |
| `PAYFAST_MERCHANT_ID` | PayFast dashboard | Shared merchant account |
| `VALR_API_KEY` | VALR exchange | USDC swaps for SafeBet |
| `CLICKATELL_API_KEY` | Clickatell platform | SMS notifications |
| `ANTHROPIC_API_KEY` | Anthropic console | AI Brain |

---

## 11. Runbook

### Check System Status
```bash
# API health
curl https://api.moveeasy.co.za/health

# PM2 processes
pm2 status

# Nginx
systemctl status nginx

# Redis
redis-cli ping

# Database connection
psql $DATABASE_URL -c "SELECT COUNT(*) FROM users;"
```

### Common Issues

**SSL cert expired**:
```bash
certbot renew --nginx
```

**PM2 process crashed**:
```bash
pm2 restart moveeasy-api
pm2 logs moveeasy-api --lines 100
```

**BullMQ jobs stuck**:
```bash
# Check Redis
redis-cli llen bull:payment-jobs:waiting
# Clear stuck jobs (caution!)
redis-cli del bull:payment-jobs:waiting
```

**Database connection exhausted**:
```bash
# Check connection count
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity;"
# Terminate idle connections
psql $DATABASE_URL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND query_start < NOW() - INTERVAL '5 minutes';"
```

---

*MoveEasy Core Brain v1.0 — Built for South Africa*  
*Nedbank + Softy Comp (Purple Owl) Agreements · AWS af-south-1*
