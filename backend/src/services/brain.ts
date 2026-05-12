/**
 * MoveEasy AI Orchestrator — Core Brain
 * Central intelligence engine aggregating telemetry from all 5 products
 * Powered by Claude Sonnet via Anthropic SDK
 *
 * Products served:
 *   - EasyTransect (super-wallet / mobile money aggregator)
 *   - EasyFuel + FuelFlex (geo-locked fuel vouchers + BNPL)
 *   - SafeBet (deposit facilitator + USDC savings)
 *   - GreenWallet (eco micro-savings)
 *   - MMP.ai (Africa-China B2B trade)
 *
 * Payment Rails:
 *   - Nedbank: Visa, MC, Amex SafeKey, POS, PocketPOS, BNPL, EBPP
 *   - Softy Comp: Ozow EFT, Debit Orders, PayFast, VALR USDC
 */

import Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────
export type ProductName =
  | "easytransect"
  | "easyfuel"
  | "fuelflex"
  | "safebet"
  | "greenwallet"
  | "mmpai";

export type PaymentMethod =
  | "visa"
  | "mastercard"
  | "amex"
  | "ozow_eft"
  | "debit_order"
  | "payfast"
  | "qr_scan"
  | "pocketpos"
  | "payflex_bnpl"
  | "floatpay_bnpl";

export type PaymentRail = "nedbank" | "softycomp" | "valr" | "payfast_shared";

export type TelemetryEvent = {
  event_id: string;
  timestamp: string;
  product: ProductName;
  user_id: string;
  event_type:
    | "transaction"
    | "kyc_verified"
    | "wallet_update"
    | "fraud_flag"
    | "voucher_used"
    | "deposit"
    | "withdrawal"
    | "login"
    | "onboard";
  amount_zar?: number;
  payment_method?: PaymentMethod;
  rail?: PaymentRail;
  merchant_id?: string;
  geo?: { lat: number; lng: number; city?: string };
  metadata?: Record<string, unknown>;
};

export type UserFinancialProfile = {
  user_id: string;
  kyc_status: "pending" | "verified" | "rejected";
  kyc_provider: "smile_id";
  products_enrolled: ProductName[];
  wallet_balance_zar: number;
  green_wallet_balance_zar: number;
  safebet_locked_zar: number;
  safebet_usdc_balance: number;
  fuelflex_active: boolean;
  fuelflex_deposit_zar: number;
  fuelflex_vouchers_remaining: number;
  monthly_tx_count: number;
  monthly_tx_volume_zar: number;
  risk_score: number; // 0–100
  last_active: string;
};

export type OrchestratorAction = {
  action_id: string;
  action_type:
    | "upsell_offer"
    | "fraud_alert"
    | "green_clip"
    | "safebet_trigger"
    | "notification_sms"
    | "compliance_flag"
    | "fuelflex_offer"
    | "mmpai_lead";
  product_target: ProductName;
  user_id: string;
  payload: Record<string, unknown>;
  priority: "low" | "medium" | "high" | "critical";
  timestamp: string;
};

export type BrainAnalysis = {
  user_id: string;
  analysis_timestamp: string;
  risk_assessment: string;
  cross_product_insights: string[];
  recommended_actions: OrchestratorAction[];
  financial_health_score: number;
  narrative: string;
};

// ─────────────────────────────────────────────
// MOVEEASY AI BRAIN
// ─────────────────────────────────────────────
export class MoveEasyBrain {
  private client: Anthropic;
  private conversationHistory: Anthropic.MessageParam[] = [];

  constructor() {
    this.client = new Anthropic();
  }

  /**
   * Analyse a batch of telemetry events for a single user and produce
   * orchestrator actions + financial health narrative.
   */
  async analyseUserTelemetry(
    userProfile: UserFinancialProfile,
    recentEvents: TelemetryEvent[]
  ): Promise<BrainAnalysis> {
    const systemPrompt = `You are the MoveEasy AI Brain — the central intelligence orchestrator for a South African fintech platform.

You have visibility across 5 products:
1. EasyTransect — super-wallet (FNB eWallet, MTN MoMo, Absa CashSend) via Nedbank rails
2. EasyFuel + FuelFlex — geo-locked fuel vouchers + BNPL (once-off deposit = full tank, 3 vouchers, each unlocked at 1/3 value)
3. SafeBet — deposit facilitator clipping 7-10% to locked savings, converted to USDC via VALR; 3-month principal unlock, 12-month gains unlock
4. GreenWallet — clips micro-amounts (0.1%) from transactions into eco-investment fund
5. MMP.ai — Africa-to-China B2B trade sourcing AI

Payment rails available:
- Nedbank: Visa, Mastercard, Amex SafeKey, POS terminals, PocketPOS, QR Scan-to-Pay, Payflex/Floatpay BNPL, EBPP invoicing
- Softy Comp (Purple Owl): Ozow instant EFT, debit orders, PayFast shared merchant account, VALR USDC conversion

Regulatory constraints (always enforce):
- FICA: KYC mandatory via Smile ID before any transaction
- POPIA: no PII exposure in recommendations
- AML: flag suspicious patterns
- SARB: payment system compliance
- PCI-DSS: no card data storage on platform
- FSCA: fair treatment, no predatory upselling

Your job: analyse the user's profile and recent events, then return a JSON object with this exact structure:
{
  "risk_assessment": "brief risk narrative",
  "cross_product_insights": ["insight1", "insight2", ...],
  "recommended_actions": [
    {
      "action_type": "upsell_offer|fraud_alert|green_clip|safebet_trigger|notification_sms|compliance_flag|fuelflex_offer|mmpai_lead",
      "product_target": "easytransect|easyfuel|fuelflex|safebet|greenwallet|mmpai",
      "payload": {},
      "priority": "low|medium|high|critical"
    }
  ],
  "financial_health_score": 0-100,
  "narrative": "plain-language financial health summary for this user"
}

RESPOND ONLY WITH VALID JSON. No preamble. No markdown fences.`;

    const userMessage = `Analyse this MoveEasy user:

USER PROFILE:
${JSON.stringify(userProfile, null, 2)}

RECENT TELEMETRY (last 24h):
${JSON.stringify(recentEvents, null, 2)}

Generate orchestrator analysis and recommended actions.`;

    // Multi-turn: maintain context across calls in session
    this.conversationHistory.push({
      role: "user",
      content: userMessage,
    });

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: systemPrompt,
      messages: this.conversationHistory,
    });

    const rawText =
      response.content[0].type === "text" ? response.content[0].text : "{}";

    // Store assistant response in history
    this.conversationHistory.push({
      role: "assistant",
      content: rawText,
    });

    let parsed: Partial<BrainAnalysis>;
    try {
      const clean = rawText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error("[Brain] JSON parse error:", rawText);
      parsed = {
        risk_assessment: "Parse error — manual review required",
        cross_product_insights: [],
        recommended_actions: [],
        financial_health_score: 50,
        narrative: rawText,
      };
    }

    // Enrich actions with IDs and timestamps
    const enrichedActions: OrchestratorAction[] = (
      parsed.recommended_actions || []
    ).map((a, i) => ({
      action_id: `ACT_${Date.now()}_${i}`,
      timestamp: new Date().toISOString(),
      user_id: userProfile.user_id,
      ...a,
    }));

    return {
      user_id: userProfile.user_id,
      analysis_timestamp: new Date().toISOString(),
      risk_assessment: parsed.risk_assessment || "",
      cross_product_insights: parsed.cross_product_insights || [],
      recommended_actions: enrichedActions,
      financial_health_score: parsed.financial_health_score || 50,
      narrative: parsed.narrative || "",
    };
  }

  /**
   * Multi-turn conversation with the Brain for operator queries
   * e.g. "Show me all high-risk users this week"
   */
  async operatorQuery(message: string): Promise<string> {
    this.conversationHistory.push({ role: "user", content: message });

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `You are the MoveEasy Brain operator console. Answer questions about system status, user analytics, compliance flags, and product performance. Be concise and data-focused. Format numbers in ZAR.`,
      messages: this.conversationHistory,
    });

    const text =
      response.content[0].type === "text"
        ? response.content[0].text
        : "No response";

    this.conversationHistory.push({ role: "assistant", content: text });
    return text;
  }

  /**
   * Auto-trigger GreenWallet clip for a transaction
   */
  computeGreenClip(
    transactionAmountZar: number,
    clipRate = 0.001
  ): { clip_zar: number; message: string } {
    const clip = Math.round(transactionAmountZar * clipRate * 100) / 100;
    return {
      clip_zar: clip,
      message: `R${clip.toFixed(2)} clipped to GreenWallet (${(clipRate * 100).toFixed(1)}% of R${transactionAmountZar})`,
    };
  }

  /**
   * FuelFlex BNPL logic
   * User deposits R(full_tank_price). Receives 3 vouchers.
   * Each voucher: user pays 1/3, EasyFuel subsidises 2/3.
   * Cycle renews at current fuel price after settlement.
   */
  computeFuelFlex(fuelPricePerLitreCents: number, tankLitres: number): {
    deposit_required_zar: number;
    per_voucher_user_pays_zar: number;
    per_voucher_easyfuel_subsidy_zar: number;
    vouchers: 3;
    summary: string;
  } {
    const full_tank_zar =
      Math.round(((fuelPricePerLitreCents * tankLitres) / 100) * 100) / 100;
    const per_voucher_value = Math.round((full_tank_zar / 3) * 100) / 100;
    const user_pays = Math.round(per_voucher_value * (1 / 3) * 100) / 100;
    const subsidy = Math.round((per_voucher_value - user_pays) * 100) / 100;

    return {
      deposit_required_zar: full_tank_zar,
      per_voucher_user_pays_zar: user_pays,
      per_voucher_easyfuel_subsidy_zar: subsidy,
      vouchers: 3,
      summary: `Deposit R${full_tank_zar} → get 3 fuel vouchers. Each unlock costs you R${user_pays} (EasyFuel covers R${subsidy}).`,
    };
  }

  /**
   * SafeBet savings clip calculator
   * Clips 7-10% of every deposit into locked savings pot
   */
  computeSafeBetClip(
    depositZar: number,
    clipPercent: 7 | 8 | 9 | 10 = 10
  ): {
    savings_clip_zar: number;
    gambling_wallet_zar: number;
    usdc_estimate: number;
    unlock_dates: { principal: string; gains: string };
    summary: string;
  } {
    const clip = Math.round(depositZar * (clipPercent / 100) * 100) / 100;
    const gambling = depositZar - clip;
    const usdcEstimate = Math.round((clip / 18.5) * 100) / 100; // approx ZAR/USD rate

    const now = new Date();
    const principal_date = new Date(now);
    principal_date.setMonth(principal_date.getMonth() + 3);
    const gains_date = new Date(now);
    gains_date.setFullYear(gains_date.getFullYear() + 1);

    return {
      savings_clip_zar: clip,
      gambling_wallet_zar: gambling,
      usdc_estimate: usdcEstimate,
      unlock_dates: {
        principal: principal_date.toISOString().split("T")[0],
        gains: gains_date.toISOString().split("T")[0],
      },
      summary: `R${clip} (${clipPercent}%) locked → ~${usdcEstimate} USDC via VALR. Unlock principal: ${principal_date.toDateString()}. Unlock gains: ${gains_date.toDateString()}.`,
    };
  }

  /**
   * Reset conversation history (new session)
   */
  resetSession(): void {
    this.conversationHistory = [];
  }
}

// ─────────────────────────────────────────────
// DEMO RUNNER
// ─────────────────────────────────────────────
async function runDemo() {
  console.log("🧠 MoveEasy AI Brain — Starting...\n");
  const brain = new MoveEasyBrain();

  // Sample user profile
  const sampleUser: UserFinancialProfile = {
    user_id: "USR_28471",
    kyc_status: "verified",
    kyc_provider: "smile_id",
    products_enrolled: ["easyfuel", "easytransect"],
    wallet_balance_zar: 1250.0,
    green_wallet_balance_zar: 4.85,
    safebet_locked_zar: 0,
    safebet_usdc_balance: 0,
    fuelflex_active: false,
    fuelflex_deposit_zar: 0,
    fuelflex_vouchers_remaining: 0,
    monthly_tx_count: 18,
    monthly_tx_volume_zar: 4200,
    risk_score: 12,
    last_active: new Date().toISOString(),
  };

  // Sample telemetry
  const events: TelemetryEvent[] = [
    {
      event_id: "EVT_001",
      timestamp: new Date().toISOString(),
      product: "easyfuel",
      user_id: "USR_28471",
      event_type: "transaction",
      amount_zar: 350,
      payment_method: "visa",
      rail: "nedbank",
      geo: { lat: -25.7461, lng: 28.1881, city: "Pretoria North" },
      metadata: { station_id: "STN_024", litres: 20.3 },
    },
    {
      event_id: "EVT_002",
      timestamp: new Date().toISOString(),
      product: "easytransect",
      user_id: "USR_28471",
      event_type: "transaction",
      amount_zar: 500,
      payment_method: "ozow_eft",
      rail: "softycomp",
      metadata: { recipient: "MTN_MOMO", reference: "family transfer" },
    },
  ];

  console.log("📊 Analysing user telemetry...\n");
  try {
    const analysis = await brain.analyseUserTelemetry(sampleUser, events);

    console.log("═══════════════════════════════════════");
    console.log("BRAIN ANALYSIS RESULT");
    console.log("═══════════════════════════════════════");
    console.log(`User: ${analysis.user_id}`);
    console.log(`Health Score: ${analysis.financial_health_score}/100`);
    console.log(`\nRisk Assessment:\n${analysis.risk_assessment}`);
    console.log("\nCross-Product Insights:");
    analysis.cross_product_insights.forEach((i) => console.log(`  • ${i}`));
    console.log(
      `\nRecommended Actions (${analysis.recommended_actions.length}):`
    );
    analysis.recommended_actions.forEach((a) => {
      console.log(`  [${a.priority.toUpperCase()}] ${a.action_type} → ${a.product_target}`);
    });
    console.log(`\nNarrative:\n${analysis.narrative}`);

    // Multi-turn operator query
    console.log("\n═══════════════════════════════════════");
    console.log("OPERATOR QUERY (Multi-turn)");
    console.log("═══════════════════════════════════════");
    const operatorResponse = await brain.operatorQuery(
      "Based on the user just analysed, what would be the best Nedbank payment rail to process their next likely transaction?"
    );
    console.log("Operator Q: Best Nedbank rail for next tx?");
    console.log(`Brain: ${operatorResponse}`);

    // FuelFlex demo
    console.log("\n═══════════════════════════════════════");
    console.log("FUELFLEX BNPL CALCULATOR");
    console.log("═══════════════════════════════════════");
    const ff = brain.computeFuelFlex(2380, 50); // R23.80/L, 50L tank
    console.log(ff.summary);

    // SafeBet demo
    console.log("\n═══════════════════════════════════════");
    console.log("SAFEBET CLIP CALCULATOR");
    console.log("═══════════════════════════════════════");
    const sb = brain.computeSafeBetClip(200, 10);
    console.log(sb.summary);
  } catch (error) {
    console.error("Brain error:", error);
  }
}

runDemo();
