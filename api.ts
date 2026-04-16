/**
 * MoveEasy Core API — Hono Framework
 * Runs on Cloudflare Workers (edge) + AWS EC2 af-south-1
 *
 * Routes:
 *   /auth         — SSO + Smile ID KYC
 *   /wallet       — Unified wallet operations
 *   /payments     — Nedbank + Softy Comp rails
 *   /easyfuel     — Fuel vouchers + FuelFlex
 *   /safebet      — Savings clips + USDC
 *   /greenwallet  — Eco micro-savings
 *   /brain        — AI orchestrator
 *   /mmpai        — Trade leads
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import { logger } from "hono/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────
// APP SETUP
// ─────────────────────────────────────────────

type Env = {
  JWT_SECRET: string;
  DATABASE_URL: string;
  SMILE_ID_API_KEY: string;
  NEDBANK_API_KEY: string;
  NEDBANK_MID: string;
  SOFTYCOMP_API_KEY: string;
  OZOW_SITE_CODE: string;
  OZOW_PRIVATE_KEY: string;
  PAYFAST_MERCHANT_ID: string;
  PAYFAST_MERCHANT_KEY: string;
  VALR_API_KEY: string;
  CLICKATELL_API_KEY: string;
  ANTHROPIC_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: [
      "https://moveeasy.co.za",
      "https://app.moveeasy.co.za",
      "http://localhost:3000",
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// JWT protection (skip /auth routes)
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  return jwt({ secret: c.env.JWT_SECRET })(c, next);
});

// ─────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────

app.get("/", (c) =>
  c.json({
    name: "MoveEasy Core API",
    version: "1.0.0",
    region: "af-south-1",
    products: [
      "easytransect",
      "easyfuel",
      "fuelflex",
      "safebet",
      "greenwallet",
      "mmpai",
    ],
    rails: ["nedbank", "softycomp", "valr", "payfast"],
    status: "operational",
    timestamp: new Date().toISOString(),
  })
);

app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

// ─────────────────────────────────────────────
// AUTH + KYC
// ─────────────────────────────────────────────

const registerSchema = z.object({
  phone: z.string().regex(/^\+[0-9]{10,15}$/, "E.164 format required"),
  email: z.string().email().optional(),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  id_number: z.string().min(8).max(20).optional(),
  date_of_birth: z.string().optional(),
});

app.post("/api/auth/register", zValidator("json", registerSchema), async (c) => {
  const body = c.req.valid("json");

  // In production: insert into users table, trigger Smile ID KYC
  const mockUser = {
    user_id: `USR_${Date.now()}`,
    phone: body.phone,
    email: body.email,
    kyc_status: "pending",
    kyc_provider: "smile_id",
    created_at: new Date().toISOString(),
  };

  // Trigger Smile ID job (async via BullMQ)
  console.log(
    `[KYC] Smile ID job queued for ${body.phone} — id_number: ${body.id_number}`
  );

  return c.json({
    success: true,
    user: mockUser,
    message:
      "Registration successful. KYC verification in progress — you will receive an SMS.",
  });
});

app.post("/api/auth/login", async (c) => {
  const { phone, otp } = await c.req.json();

  // In production: verify OTP via Clickatell, return JWT
  if (!phone || !otp) {
    return c.json({ error: "phone and otp required" }, 400);
  }

  const mockToken = `eyJhbGciOiJIUzI1NiJ9.mock_token_${phone}`;
  return c.json({
    success: true,
    token: mockToken,
    user_id: `USR_MOCK`,
    expires_in: 86400,
  });
});

app.post("/api/auth/kyc/webhook", async (c) => {
  // Smile ID webhook — update kyc_records
  const payload = await c.req.json();
  console.log("[KYC Webhook] Smile ID result:", JSON.stringify(payload));

  // In production: update kyc_records, propagate to all products, send Clickatell SMS
  return c.json({ received: true });
});

// ─────────────────────────────────────────────
// WALLETS
// ─────────────────────────────────────────────

app.get("/api/wallet/balances", async (c) => {
  const payload = c.get("jwtPayload");
  const userId = payload?.sub;

  // In production: query wallets table for all wallet types
  return c.json({
    user_id: userId,
    wallets: {
      main: { balance_zar: 1250.0, currency: "ZAR" },
      greenwallet: { balance_zar: 4.85, currency: "ZAR" },
      safebet_locked: {
        balance_zar: 0,
        currency: "ZAR",
        unlock_date: null,
        usdc_balance: 0,
      },
      fuelflex: {
        balance_zar: 0,
        vouchers_remaining: 0,
        active: false,
      },
    },
    total_zar: 1254.85,
    timestamp: new Date().toISOString(),
  });
});

const transferSchema = z.object({
  to_product: z.enum([
    "easytransect",
    "easyfuel",
    "safebet",
    "greenwallet",
    "external",
  ]),
  amount_zar: z.number().min(1).max(50000),
  description: z.string().optional(),
  payment_method_id: z.string().uuid().optional(),
});

app.post("/api/wallet/transfer", zValidator("json", transferSchema), async (c) => {
  const body = c.req.valid("json");
  const payload = c.get("jwtPayload");

  // KYC gate — enforce FICA compliance
  // In production: check kyc_records.status = 'verified'
  const kycVerified = true; // mock

  if (!kycVerified) {
    return c.json(
      { error: "KYC_REQUIRED", message: "Identity verification required before transactions" },
      403
    );
  }

  return c.json({
    success: true,
    tx_id: `TX_${Date.now()}`,
    amount_zar: body.amount_zar,
    to_product: body.to_product,
    green_clip_zar: Math.round(body.amount_zar * 0.001 * 100) / 100,
    status: "completed",
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// PAYMENTS — NEDBANK RAILS
// ─────────────────────────────────────────────

const paymentSchema = z.object({
  amount_zar: z.number().min(1),
  method: z.enum([
    "visa",
    "mastercard",
    "amex",
    "ozow_eft",
    "debit_order",
    "qr_scan",
    "pocketpos",
    "payflex_bnpl",
    "floatpay_bnpl",
  ]),
  product: z.enum([
    "easytransect",
    "easyfuel",
    "safebet",
    "greenwallet",
    "mmpai",
  ]),
  merchant_id: z.string().uuid().optional(),
  description: z.string().optional(),
  return_url: z.string().url().optional(),
});

app.post("/api/payments/initiate", zValidator("json", paymentSchema), async (c) => {
  const body = c.req.valid("json");
  const rail = ["visa", "mastercard", "amex", "qr_scan", "pocketpos", "payflex_bnpl", "floatpay_bnpl"].includes(body.method)
    ? "nedbank"
    : "softycomp";

  const txId = `TX_${Date.now()}`;

  // Route based on rail
  if (rail === "nedbank") {
    // Initiate Nedbank card payment (3DS for Amex)
    const response3DS =
      body.method === "amex"
        ? { required: true, redirect_url: `https://nedbank-3ds.example.com/${txId}` }
        : { required: false };

    return c.json({
      success: true,
      tx_id: txId,
      rail: "nedbank",
      method: body.method,
      amount_zar: body.amount_zar,
      three_ds: response3DS,
      status: "pending",
      gateway_redirect: `https://nedbank.moveeasy.co.za/pay/${txId}`,
      timestamp: new Date().toISOString(),
    });
  } else {
    // Ozow EFT / Debit order
    const ozowHash = `OZOW_HASH_${txId}`; // In production: HMAC-SHA512

    return c.json({
      success: true,
      tx_id: txId,
      rail: "softycomp",
      method: body.method,
      amount_zar: body.amount_zar,
      ozow_url: body.method === "ozow_eft"
        ? `https://pay.ozow.com/?SiteCode=${c.env.OZOW_SITE_CODE}&Amount=${body.amount_zar}&TransactionReference=${txId}`
        : null,
      debit_mandate_url: body.method === "debit_order"
        ? `https://moveeasy.co.za/mandate/${txId}`
        : null,
      status: "pending",
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/payments/webhook/nedbank", async (c) => {
  const payload = await c.req.json();
  console.log("[Webhook] Nedbank payment:", JSON.stringify(payload));
  // Update payment_transactions, trigger GreenWallet clip, fire Clickatell SMS
  return c.json({ received: true });
});

app.post("/api/payments/webhook/ozow", async (c) => {
  const payload = await c.req.json();
  console.log("[Webhook] Ozow EFT:", JSON.stringify(payload));
  return c.json({ received: true });
});

// ─────────────────────────────────────────────
// EASYFUEL + FUELFLEX
// ─────────────────────────────────────────────

app.get("/api/easyfuel/vouchers", async (c) => {
  const payload = c.get("jwtPayload");
  return c.json({
    user_id: payload?.sub,
    vouchers: [],
    fuelflex_active: false,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/easyfuel/create-voucher", async (c) => {
  const { amount_zar, station_id, fuel_type } = await c.req.json();

  return c.json({
    success: true,
    voucher: {
      voucher_id: `VCH_${Date.now()}`,
      voucher_code: Buffer.from(Math.random().toString()).toString("hex").slice(0, 24),
      qr_data: `MOVEEASY_FUEL:${Date.now()}`,
      amount_zar,
      station_id: station_id || null,
      fuel_type: fuel_type || "95_unleaded",
      status: "active",
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });
});

app.post("/api/easyfuel/fuelflex/activate", async (c) => {
  const { fuel_price_per_litre, tank_litres } = await c.req.json();

  const full_tank_zar = Math.round(fuel_price_per_litre * tank_litres * 100) / 100;
  const per_voucher = Math.round((full_tank_zar / 3) * 100) / 100;
  const user_pays = Math.round((per_voucher / 3) * 100) / 100;
  const easyfuel_covers = Math.round((per_voucher - user_pays) * 100) / 100;

  return c.json({
    success: true,
    fuelflex: {
      agreement_id: `FF_${Date.now()}`,
      deposit_required_zar: full_tank_zar,
      vouchers: 3,
      per_voucher_value_zar: per_voucher,
      user_pays_per_unlock_zar: user_pays,
      easyfuel_subsidy_per_unlock_zar: easyfuel_covers,
      fuel_price_at_agreement: fuel_price_per_litre,
      tank_litres,
      payment_rail: "nedbank", // or softycomp
      status: "awaiting_deposit",
    },
  });
});

// ─────────────────────────────────────────────
// SAFEBET
// ─────────────────────────────────────────────

app.post("/api/safebet/deposit", async (c) => {
  const { amount_zar, clip_percent = 10 } = await c.req.json();

  const clip_zar = Math.round(amount_zar * (clip_percent / 100) * 100) / 100;
  const gambling_zar = amount_zar - clip_zar;
  const usdc_estimate = Math.round((clip_zar / 18.5) * 10000) / 10000;

  const now = new Date();
  const unlock_principal = new Date(now);
  unlock_principal.setMonth(unlock_principal.getMonth() + 3);
  const unlock_gains = new Date(now);
  unlock_gains.setFullYear(unlock_gains.getFullYear() + 1);

  return c.json({
    success: true,
    deposit: {
      deposit_id: `SB_${Date.now()}`,
      gross_deposit_zar: amount_zar,
      clip_percent,
      savings_clip_zar: clip_zar,
      gambling_wallet_zar: gambling_zar,
      usdc_to_purchase: usdc_estimate,
      valr_swap: "queued",
      unlock_dates: {
        principal: unlock_principal.toISOString().split("T")[0],
        gains: unlock_gains.toISOString().split("T")[0],
      },
      payment_rail: "softycomp_ozow",
    },
  });
});

app.get("/api/safebet/account", async (c) => {
  const payload = c.get("jwtPayload");
  return c.json({
    user_id: payload?.sub,
    clip_percent: 10,
    total_clipped_zar: 0,
    usdc_balance: 0,
    locked_deposits: [],
    status: "active",
  });
});

// ─────────────────────────────────────────────
// GREENWALLET
// ─────────────────────────────────────────────

app.get("/api/greenwallet/balance", async (c) => {
  const payload = c.get("jwtPayload");
  return c.json({
    user_id: payload?.sub,
    balance_zar: 4.85,
    total_clipped_zar: 4.85,
    clip_rate: 0.001,
    clips_count: 14,
    active_project: {
      name: "Pretoria Urban Forest Initiative",
      category: "tree_planting",
      funded_percent: 23,
    },
  });
});

// ─────────────────────────────────────────────
// AI BRAIN ENDPOINT
// ─────────────────────────────────────────────

app.post("/api/brain/analyse", async (c) => {
  const { user_id, events } = await c.req.json();
  const anthropicKey = c.env.ANTHROPIC_API_KEY;

  const client = new Anthropic({ apiKey: anthropicKey });

  const prompt = `You are the MoveEasy AI Brain. Analyse these user events and provide actionable fintech intelligence.

User ID: ${user_id}
Events: ${JSON.stringify(events, null, 2)}

Return JSON:
{
  "financial_health_score": 0-100,
  "risk_level": "low|medium|high",
  "insights": ["..."],
  "recommended_actions": ["..."],
  "narrative": "..."
}`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const analysis = JSON.parse(clean);

    return c.json({ success: true, user_id, analysis });
  } catch (error) {
    console.error("[Brain] API error:", error);
    return c.json({ error: "Brain analysis failed" }, 500);
  }
});

app.post("/api/brain/query", async (c) => {
  const { message, conversation_history = [] } = await c.req.json();
  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });

  const messages = [
    ...conversation_history,
    { role: "user" as const, content: message },
  ];

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    system: "You are the MoveEasy operator assistant. Answer questions about the platform, users, transactions, and product performance. Be concise and data-focused.",
    messages,
  });

  const reply =
    response.content[0].type === "text" ? response.content[0].text : "";

  return c.json({
    reply,
    updated_history: [
      ...messages,
      { role: "assistant", content: reply },
    ],
  });
});

// ─────────────────────────────────────────────
// MMP.AI — TRADE LEADS
// ─────────────────────────────────────────────

app.post("/api/mmpai/lead", async (c) => {
  const lead = await c.req.json();
  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });

  const prompt = `You are MMP.ai, an Africa-to-China B2B trade matching AI.

Evaluate this trade lead and find potential Chinese buyers/processors:
${JSON.stringify(lead, null, 2)}

Respond with JSON:
{
  "match_score": 0-100,
  "narrative": "analysis of the lead quality",
  "recommended_markets": ["..."],
  "estimated_price_range_usd_per_kg": {"min": 0, "max": 0},
  "next_steps": ["..."]
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "{}";
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    const analysis = JSON.parse(clean);
    return c.json({
      success: true,
      lead_id: `LEAD_${Date.now()}`,
      ai_analysis: analysis,
      status: "open",
    });
  } catch {
    return c.json({ error: "Analysis failed" }, 500);
  }
});

// ─────────────────────────────────────────────
// EBPP — Electronic Bill Payment Presentment
// Nedbank agreement capability
// ─────────────────────────────────────────────

app.post("/api/ebpp/invoice", async (c) => {
  const { user_id, amount_zar, description, delivery } = await c.req.json();
  // delivery: 'sms' | 'email' | 'both'

  const invoice = {
    invoice_id: `INV_${Date.now()}`,
    user_id,
    amount_zar,
    description,
    payment_link: `https://pay.moveeasy.co.za/inv/${Date.now()}`,
    qr_code: `MOVEEASY_PAY:${Date.now()}`,
    delivery_channels: delivery,
    status: "sent",
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };

  // In production: dispatch via Clickatell SMS + email
  console.log(`[EBPP] Invoice ${invoice.invoice_id} dispatched via ${delivery}`);

  return c.json({ success: true, invoice });
});

export default app;
