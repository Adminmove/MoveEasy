# MoveEasy — The Central Nervous System for African Fintech

**Version:** 2026.1.0  
**Reg No:** 2025/104466/07  
**Stack:** Node.js · PostgreSQL · AWS af-south-1 · PayFast · Nedbank · Purple Owl Payments  
**Compliance:** SARB · FICA · POPIA · AML · PCI-DSS

---

## Ecosystem Overview

```
MoveEasy Core Brain (AI Orchestrator)
    ├── EasyFuel        — Geo-locked fuel pre-purchase & FuelFlex BNPL
    ├── EasyTransect    — Mobile money liquidity bridge (SA banks)
    ├── SafeBet         — ZAR→USDC yield savings for bettors
    ├── GreenWallet     — ESG project marketplace & carbon credits
    └── MMP.ai          — Africa-to-China B2B sourcing agent (ARIA)
```

**Shared Infrastructure Backbone:**
- Single Sign-On (SSO) via Supabase Auth
- Unified Wallet (ecosystem_sync ledger)
- Once-only KYC via Smile ID
- Shared PayFast merchant account
- Purple Owl Payments (Softy Comp) for card processing
- Nedbank Nedlink for POS/e-commerce acquiring
- AWS af-south-1 (Cape Town — POPIA data residency)

---

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Set environment variables
cp .env.example .env
# Fill in all API keys

# 3. Initialize database
psql -U postgres -f database/schema.sql
psql -U postgres -f database/seed.sql

# 4. Start backend
cd backend && npm run dev

# 5. Open any frontend
# Open frontend/moveeasy-core/index.html in browser
# Or serve: npx serve frontend/moveeasy-core
```

---

## Directory Structure

```
moveeasy/
├── backend/                    # Node.js API server
│   └── src/
│       ├── config/             # DB, env, constants
│       ├── middleware/         # Auth, KYC, rate limiting
│       ├── routes/             # Per-product API routes
│       ├── services/           # Payment & AI integrations
│       ├── models/             # PostgreSQL query models
│       └── jobs/               # BullMQ async workers
├── database/
│   ├── schema.sql              # Full PostgreSQL schema
│   └── seed.sql                # Demo data
├── frontend/
│   ├── moveeasy-core/          # Admin / AI Brain dashboard
│   ├── easyfuel-app/           # Driver fuel app
│   ├── easytransect-app/       # Liquidity bridge
│   ├── safebet-app/            # Savings product
│   ├── greenwallet-app/        # ESG marketplace
│   └── mmpai-app/              # B2B sourcing
└── docs/
    ├── API.md                  # Full API reference
    ├── DEPLOYMENT.md           # AWS deployment guide
    └── ARCHITECTURE.md         # System architecture
```

---

## Payment Rails

| Product       | Primary Rail             | Secondary Rail     | Acquiring       |
|--------------|--------------------------|-------------------|-----------------|
| EasyFuel     | PayFast EFT              | Purple Owl Cards  | Nedbank Nedlink |
| EasyTransect | PayFast EFT Disbursement | Ozow Instant EFT  | Purple Owl      |
| SafeBet      | Ozow → Investec          | VALR (USDC)       | Nedbank         |
| GreenWallet  | PayFast Recurring        | Purple Owl Cards  | Nedbank Amex    |
| MMP.ai       | SWIFT / PayFast          | —                 | Nedbank         |

---

## Compliance Notes

- All KYC uses **Smile ID** (FICA-compliant biometric verification)
- Manual entry risk acknowledged per Nedbank letter (20 Aug 2025)
- Amex SafeKey 3D Secure enabled via Nedbank addendum
- Purple Owl PASA System Operator Reg: SO001024
- Data residency: AWS af-south-1 (Cape Town) — POPIA compliant
- TransUnion credit bureau integration for FuelFlex BNPL
