-- ============================================================
-- MoveEasy Core — PostgreSQL Schema
-- AWS RDS PostgreSQL 15 · af-south-1
-- ============================================================
-- Products: EasyTransect, EasyFuel+FuelFlex, SafeBet,
--           GreenWallet, MMP.ai
-- Payment Rails: Nedbank (Visa/MC/Amex/POS/BNPL/EBPP)
--                Softy Comp (Ozow/Debit/PayFast/VALR)
-- ============================================================

-- Enable UUID + pgcrypto
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis"; -- for geo-locking (EasyFuel)

-- ─────────────────────────────────────────────
-- CORE: USERS & KYC
-- ─────────────────────────────────────────────

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone           VARCHAR(15) UNIQUE NOT NULL,  -- E.164 format
  email           VARCHAR(255) UNIQUE,
  first_name      VARCHAR(100),
  last_name       VARCHAR(100),
  id_number       VARCHAR(20) UNIQUE,            -- SA ID / Passport
  date_of_birth   DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  is_active       BOOLEAN DEFAULT TRUE,
  CONSTRAINT phone_format CHECK (phone ~ '^\+[0-9]{10,15}$')
);

CREATE TABLE kyc_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        VARCHAR(20) DEFAULT 'smile_id',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
                  -- pending | verified | rejected | manual_review
  smile_id_job_id VARCHAR(100),
  smile_id_result JSONB,                         -- full Smile ID response
  id_type         VARCHAR(50),                   -- national_id | passport | drivers
  liveness_passed BOOLEAN,
  selfie_match    BOOLEAN,
  verified_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT kyc_status_check CHECK (status IN ('pending','verified','rejected','manual_review')),
  UNIQUE (user_id, provider)
);

-- ─────────────────────────────────────────────
-- CORE: WALLETS (Unified)
-- ─────────────────────────────────────────────

CREATE TABLE wallets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_type     VARCHAR(30) NOT NULL,
                  -- main | greenwallet | safebet_locked | safebet_usdc | fuelflex
  balance_cents   BIGINT NOT NULL DEFAULT 0,    -- always in ZAR cents
  currency        VARCHAR(5) DEFAULT 'ZAR',
  is_locked       BOOLEAN DEFAULT FALSE,
  unlock_date     TIMESTAMPTZ,                  -- for SafeBet locks
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT positive_balance CHECK (balance_cents >= 0),
  UNIQUE (user_id, wallet_type)
);

CREATE TABLE wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id       UUID NOT NULL REFERENCES wallets(id),
  tx_type         VARCHAR(30) NOT NULL,
                  -- credit | debit | lock | unlock | clip | swap
  amount_cents    BIGINT NOT NULL,
  balance_after_cents BIGINT NOT NULL,
  product         VARCHAR(30),
                  -- easytransect | easyfuel | safebet | greenwallet | mmpai
  reference       VARCHAR(255),
  description     TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- PAYMENT RAILS
-- ─────────────────────────────────────────────

CREATE TABLE payment_methods (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  method_type     VARCHAR(30) NOT NULL,
                  -- visa | mastercard | amex | ozow | debit_order | payfast | qr
  rail            VARCHAR(20) NOT NULL,
                  -- nedbank | softycomp | valr | payfast_shared
  token           VARCHAR(255),                 -- tokenised by gateway — never raw card
  masked_number   VARCHAR(20),                  -- last 4 digits only (PCI-DSS)
  expiry_month    INTEGER,
  expiry_year     INTEGER,
  bank_name       VARCHAR(100),
  account_type    VARCHAR(20),                  -- cheque | savings | transmission
  is_default      BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  nedbank_mid     VARCHAR(50),                  -- Nedbank Merchant ID for this method
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE payment_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  product         VARCHAR(30) NOT NULL,
  payment_method_id UUID REFERENCES payment_methods(id),
  rail            VARCHAR(20) NOT NULL,
  method_type     VARCHAR(30) NOT NULL,
  amount_cents    BIGINT NOT NULL,
  currency        VARCHAR(5) DEFAULT 'ZAR',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
                  -- pending | processing | completed | failed | refunded | disputed
  gateway_ref     VARCHAR(255),                 -- Nedbank / Ozow / PayFast reference
  gateway_response JSONB,
  nedbank_3ds_status VARCHAR(20),               -- for Amex SafeKey / 3DS
  ozow_ref        VARCHAR(100),
  payfast_pf_payment_id VARCHAR(100),
  merchant_id     UUID REFERENCES merchants(id),
  description     TEXT,
  ip_address      INET,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  settled_at      TIMESTAMPTZ,
  CONSTRAINT status_check CHECK (status IN ('pending','processing','completed','failed','refunded','disputed'))
);

-- ─────────────────────────────────────────────
-- MERCHANTS
-- ─────────────────────────────────────────────

CREATE TABLE merchants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  category        VARCHAR(50),               -- fuel | retail | food | services | betting
  nedbank_mid     VARCHAR(50) UNIQUE,        -- Nedbank Merchant ID
  nedbank_tid     VARCHAR(50),               -- Terminal ID (POS)
  payfast_merchant_id VARCHAR(50),
  address         TEXT,
  geo_point       GEOMETRY(POINT, 4326),     -- PostGIS for EasyFuel geo-lock
  geo_radius_meters INTEGER DEFAULT 500,     -- allowed transaction radius
  accepts_qr      BOOLEAN DEFAULT FALSE,
  accepts_pocketpos BOOLEAN DEFAULT FALSE,
  accepts_visa    BOOLEAN DEFAULT TRUE,
  accepts_mc      BOOLEAN DEFAULT TRUE,
  accepts_amex    BOOLEAN DEFAULT FALSE,
  accepts_bnpl    BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- EASYFUEL + FUELFLEX
-- ─────────────────────────────────────────────

CREATE TABLE fuel_vouchers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  voucher_code    VARCHAR(50) UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
  barcode         VARCHAR(100) UNIQUE,
  qr_data         TEXT,
  station_id      UUID REFERENCES merchants(id),  -- NULL = any registered station
  geo_lock_point  GEOMETRY(POINT, 4326),           -- station geo
  amount_cents    BIGINT NOT NULL,
  fuel_type       VARCHAR(20) DEFAULT '95_unleaded',
  status          VARCHAR(20) DEFAULT 'active',
                  -- active | used | expired | revoked
  fuelflex_series UUID,                           -- links vouchers in a FuelFlex set
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '90 days',
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fuelflex_agreements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  deposit_cents   BIGINT NOT NULL,                -- = full tank value at deposit time
  per_voucher_value_cents BIGINT NOT NULL,        -- deposit / 3
  user_pays_per_voucher_cents BIGINT NOT NULL,    -- 1/3 of voucher value
  easyfuel_subsidy_per_voucher_cents BIGINT NOT NULL, -- 2/3 of voucher value
  fuel_price_cents_per_litre INTEGER NOT NULL,    -- price at agreement creation
  tank_litres     DECIMAL(6,2) NOT NULL,
  voucher_1_id    UUID REFERENCES fuel_vouchers(id),
  voucher_2_id    UUID REFERENCES fuel_vouchers(id),
  voucher_3_id    UUID REFERENCES fuel_vouchers(id),
  status          VARCHAR(20) DEFAULT 'active',
                  -- active | completed | defaulted
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- SAFEBET
-- ─────────────────────────────────────────────

CREATE TABLE safebet_accounts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) UNIQUE,
  clip_percent    DECIMAL(4,2) NOT NULL DEFAULT 10.00,   -- 7–10%
  total_clipped_cents BIGINT DEFAULT 0,
  usdc_balance    DECIMAL(18,8) DEFAULT 0,               -- USDC on VALR
  valr_account_id VARCHAR(100),
  ozow_mandate_ref VARCHAR(100),                         -- debit order mandate
  investec_account_id VARCHAR(100),                      -- for high-value holding
  status          VARCHAR(20) DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE safebet_deposits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  safebet_account_id UUID NOT NULL REFERENCES safebet_accounts(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  gross_deposit_cents BIGINT NOT NULL,
  clip_cents      BIGINT NOT NULL,
  gambling_wallet_cents BIGINT NOT NULL,
  clip_percent    DECIMAL(4,2) NOT NULL,
  usdc_purchased  DECIMAL(18,8),
  zar_usdc_rate   DECIMAL(10,4),                        -- rate at time of swap
  valr_order_id   VARCHAR(100),
  principal_unlock_date DATE NOT NULL,                   -- +3 months
  gains_unlock_date DATE NOT NULL,                       -- +12 months
  status          VARCHAR(20) DEFAULT 'locked',
                  -- locked | principal_unlocked | fully_unlocked
  payment_tx_id   UUID REFERENCES payment_transactions(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- GREENWALLET
-- ─────────────────────────────────────────────

CREATE TABLE greenwallet_clips (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  source_tx_id    UUID REFERENCES payment_transactions(id),
  source_product  VARCHAR(30),
  clip_cents      BIGINT NOT NULL,                       -- micro-amount in ZAR cents
  clip_rate       DECIMAL(6,4) DEFAULT 0.001,            -- 0.1%
  settled         BOOLEAN DEFAULT FALSE,
  settled_batch_id UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE green_projects (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  category        VARCHAR(50),                           -- solar | tree_planting | water | conservation
  target_cents    BIGINT NOT NULL,
  funded_cents    BIGINT DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- MMP.AI — AFRICA-CHINA TRADE
-- ─────────────────────────────────────────────

CREATE TABLE mmpai_trade_leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id),
  commodity       VARCHAR(100) NOT NULL,
  origin_country  VARCHAR(5) DEFAULT 'ZA',
  destination_country VARCHAR(5) DEFAULT 'CN',
  quantity_kg     DECIMAL(12,2),
  quality_grade   VARCHAR(20),
  desired_price_usd_per_kg DECIMAL(10,4),
  ai_match_score  DECIMAL(4,2),                         -- 0–100, from brain
  ai_narrative    TEXT,                                  -- brain explanation
  supplier_matches JSONB,                               -- array of potential matches
  status          VARCHAR(20) DEFAULT 'open',
                  -- open | matched | negotiating | closed | cancelled
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- AI BRAIN TELEMETRY + ACTIONS
-- ─────────────────────────────────────────────

CREATE TABLE brain_telemetry_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id),
  product         VARCHAR(30),
  event_type      VARCHAR(50),
  amount_cents    BIGINT,
  payment_method  VARCHAR(30),
  rail            VARCHAR(20),
  merchant_id     UUID REFERENCES merchants(id),
  geo_lat         DECIMAL(10,7),
  geo_lng         DECIMAL(10,7),
  geo_city        VARCHAR(100),
  raw_metadata    JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE brain_analyses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id),
  financial_health_score INTEGER,
  risk_score      INTEGER,
  narrative       TEXT,
  cross_product_insights JSONB,
  raw_analysis    JSONB,
  model_version   VARCHAR(50) DEFAULT 'claude-sonnet-4-20250514',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE brain_actions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  analysis_id     UUID REFERENCES brain_analyses(id),
  user_id         UUID REFERENCES users(id),
  action_type     VARCHAR(50),
  product_target  VARCHAR(30),
  priority        VARCHAR(10),
  payload         JSONB,
  executed        BOOLEAN DEFAULT FALSE,
  executed_at     TIMESTAMPTZ,
  outcome         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- COMPLIANCE (AML / FICA)
-- ─────────────────────────────────────────────

CREATE TABLE compliance_flags (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id),
  tx_id           UUID REFERENCES payment_transactions(id),
  flag_type       VARCHAR(50),
                  -- structuring | high_velocity | geo_mismatch | blacklist_match | pep_hit
  severity        VARCHAR(10),                          -- low | medium | high | critical
  description     TEXT,
  auto_flagged    BOOLEAN DEFAULT TRUE,                 -- TRUE = brain flagged
  reviewed        BOOLEAN DEFAULT FALSE,
  reviewer_id     UUID REFERENCES users(id),
  review_outcome  VARCHAR(20),                          -- cleared | escalated | reported
  sar_filed       BOOLEAN DEFAULT FALSE,                -- Suspicious Activity Report to FIC
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- NOTIFICATIONS (Clickatell SMS / Email)
-- ─────────────────────────────────────────────

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id),
  channel         VARCHAR(20),                          -- sms | email | push
  provider        VARCHAR(30) DEFAULT 'clickatell',
  template        VARCHAR(100),
  content         TEXT,
  status          VARCHAR(20) DEFAULT 'queued',
                  -- queued | sent | delivered | failed
  provider_ref    VARCHAR(100),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_kyc_user_status ON kyc_records(user_id, status);
CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_wallet_tx_wallet ON wallet_transactions(wallet_id, created_at DESC);
CREATE INDEX idx_payment_tx_user ON payment_transactions(user_id, created_at DESC);
CREATE INDEX idx_payment_tx_status ON payment_transactions(status, created_at DESC);
CREATE INDEX idx_fuel_voucher_code ON fuel_vouchers(voucher_code);
CREATE INDEX idx_fuel_voucher_user ON fuel_vouchers(user_id, status);
CREATE INDEX idx_safebet_user ON safebet_accounts(user_id);
CREATE INDEX idx_safebet_deposits_user ON safebet_deposits(user_id, created_at DESC);
CREATE INDEX idx_greenwallet_user ON greenwallet_clips(user_id, settled);
CREATE INDEX idx_brain_telemetry_user ON brain_telemetry_events(user_id, created_at DESC);
CREATE INDEX idx_brain_analyses_user ON brain_analyses(user_id, created_at DESC);
CREATE INDEX idx_brain_actions_pending ON brain_actions(executed, priority, created_at);
CREATE INDEX idx_compliance_flags_user ON compliance_flags(user_id, reviewed);
CREATE INDEX idx_merchants_geo ON merchants USING GIST(geo_point);
CREATE INDEX idx_fuel_vouchers_geo ON fuel_vouchers USING GIST(geo_lock_point);

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (Supabase RLS)
-- ─────────────────────────────────────────────

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE safebet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE greenwallet_clips ENABLE ROW LEVEL SECURITY;

-- Users can only see their own data
CREATE POLICY users_own_row ON users
  USING (id = auth.uid()::UUID);

CREATE POLICY wallets_own_row ON wallets
  USING (user_id = auth.uid()::UUID);

CREATE POLICY payment_tx_own_row ON payment_transactions
  USING (user_id = auth.uid()::UUID);

CREATE POLICY fuel_vouchers_own_row ON fuel_vouchers
  USING (user_id = auth.uid()::UUID);

CREATE POLICY safebet_own_row ON safebet_accounts
  USING (user_id = auth.uid()::UUID);

-- ─────────────────────────────────────────────
-- FUNCTIONS & TRIGGERS
-- ─────────────────────────────────────────────

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto GreenWallet clip on payment_transaction insert
CREATE OR REPLACE FUNCTION auto_green_clip()
RETURNS TRIGGER AS $$
DECLARE
  clip_rate DECIMAL := 0.001; -- 0.1%
  clip_amount BIGINT;
BEGIN
  IF NEW.status = 'completed' AND NEW.amount_cents > 0 THEN
    clip_amount := GREATEST(1, FLOOR(NEW.amount_cents * clip_rate));
    INSERT INTO greenwallet_clips
      (user_id, source_tx_id, source_product, clip_cents, clip_rate)
    VALUES
      (NEW.user_id, NEW.id, NEW.product, clip_amount, clip_rate);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_green_clip
  AFTER INSERT OR UPDATE ON payment_transactions
  FOR EACH ROW
  WHEN (NEW.status = 'completed')
  EXECUTE FUNCTION auto_green_clip();

-- SafeBet principal unlock (run via cron / pg_cron)
CREATE OR REPLACE FUNCTION unlock_safebet_principals()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE safebet_deposits
  SET status = 'principal_unlocked'
  WHERE status = 'locked'
    AND principal_unlock_date <= CURRENT_DATE;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- Wallet ledger integrity check
CREATE OR REPLACE FUNCTION verify_wallet_balance(p_wallet_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  computed_balance BIGINT;
  stored_balance BIGINT;
BEGIN
  SELECT COALESCE(SUM(
    CASE WHEN tx_type IN ('credit','unlock') THEN amount_cents
         WHEN tx_type IN ('debit','lock','clip') THEN -amount_cents
         ELSE 0
    END
  ), 0) INTO computed_balance
  FROM wallet_transactions
  WHERE wallet_id = p_wallet_id;

  SELECT balance_cents INTO stored_balance FROM wallets WHERE id = p_wallet_id;
  RETURN computed_balance = stored_balance;
END;
$$ LANGUAGE plpgsql;
