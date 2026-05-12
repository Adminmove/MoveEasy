/**
 * MoveEasy BullMQ Workers
 * Async job processing for all products
 *
 * Queues:
 *   kyc-jobs          — Smile ID verification
 *   payment-jobs      — Nedbank + Ozow processing
 *   safebet-jobs      — USDC swaps via VALR
 *   greenwallet-jobs  — Micro-clip settlement batches
 *   notification-jobs — Clickatell SMS + email dispatch
 *   brain-jobs        — AI orchestrator analysis
 */

import { Worker, Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});

// ─────────────────────────────────────────────
// QUEUE DEFINITIONS
// ─────────────────────────────────────────────

export const kycQueue = new Queue("kyc-jobs", { connection });
export const paymentQueue = new Queue("payment-jobs", { connection });
export const safeBetQueue = new Queue("safebet-jobs", { connection });
export const greenWalletQueue = new Queue("greenwallet-jobs", { connection });
export const notificationQueue = new Queue("notification-jobs", { connection });
export const brainQueue = new Queue("brain-jobs", { connection });

// ─────────────────────────────────────────────
// KYC WORKER — Smile ID
// ─────────────────────────────────────────────

const kycWorker = new Worker(
  "kyc-jobs",
  async (job) => {
    const { user_id, phone, id_number, id_type, selfie_base64 } = job.data;
    console.log(`[KYC] Processing job ${job.id} for user ${user_id}`);

    // In production: call Smile ID API
    const smilePayload = {
      source_sdk: "moveeasy",
      source_sdk_version: "1.0.0",
      partner_id: process.env.SMILE_ID_PARTNER_ID,
      callback_url: process.env.SMILE_ID_CALLBACK_URL,
      job_type: 1, // ID verification + selfie
      id_type,
      id_number,
      user_id,
    };

    console.log(`[KYC] Smile ID job submitted:`, smilePayload);

    // Queue notification
    await notificationQueue.add("kyc-submitted", {
      user_id,
      phone,
      channel: "sms",
      template: "kyc_submitted",
      vars: { name: "User" },
    });

    return { status: "submitted", smile_job_id: `MOCK_${Date.now()}` };
  },
  { connection, concurrency: 5 }
);

// ─────────────────────────────────────────────
// PAYMENT WORKER
// ─────────────────────────────────────────────

const paymentWorker = new Worker(
  "payment-jobs",
  async (job) => {
    const { tx_id, amount_zar, rail, method, user_id } = job.data;
    console.log(`[Payment] Processing ${tx_id} — R${amount_zar} via ${rail}/${method}`);

    if (rail === "nedbank") {
      // In production: call Nedbank API
      console.log(`[Payment] Nedbank ${method} processing...`);
    } else if (rail === "softycomp") {
      if (method === "ozow_eft") {
        // Ozow EFT processing
        console.log(`[Payment] Ozow EFT processing...`);
      } else if (method === "debit_order") {
        console.log(`[Payment] Debit order processing...`);
      }
    }

    // Trigger GreenWallet clip
    await greenWalletQueue.add("clip", {
      user_id,
      tx_id,
      amount_zar,
      clip_rate: 0.001,
    });

    // Queue confirmation SMS
    await notificationQueue.add("payment-confirmed", {
      user_id,
      channel: "sms",
      template: "payment_confirmed",
      vars: { amount: `R${amount_zar}`, tx_id },
    });

    return { status: "completed", tx_id };
  },
  { connection, concurrency: 10 }
);

// ─────────────────────────────────────────────
// SAFEBET WORKER — USDC swap via VALR
// ─────────────────────────────────────────────

const safeBetWorker = new Worker(
  "safebet-jobs",
  async (job) => {
    const { deposit_id, user_id, clip_zar } = job.data;
    console.log(`[SafeBet] USDC swap for deposit ${deposit_id} — R${clip_zar}`);

    // In production: call VALR API to buy USDC
    // 1. GET /v1/marketdata/USDCZAR/orderbook
    // 2. POST /v1/orders/market to buy USDC with ZAR
    const mockUsdcRate = 18.5;
    const usdc_amount = Math.round((clip_zar / mockUsdcRate) * 10000) / 10000;

    console.log(`[SafeBet] Purchased ${usdc_amount} USDC at R${mockUsdcRate}/USDC`);

    // Update safebet_deposits with USDC balance
    // In production: UPDATE safebet_deposits SET usdc_purchased = $1, valr_order_id = $2

    await notificationQueue.add("safebet-swap", {
      user_id,
      channel: "sms",
      template: "safebet_usdc_purchased",
      vars: { usdc: usdc_amount, zar: clip_zar },
    });

    return { status: "completed", usdc_purchased: usdc_amount };
  },
  { connection, concurrency: 3 }
);

// ─────────────────────────────────────────────
// GREENWALLET WORKER — Batch clip settlement
// ─────────────────────────────────────────────

const greenWalletWorker = new Worker(
  "greenwallet-jobs",
  async (job) => {
    if (job.name === "clip") {
      const { user_id, tx_id, amount_zar, clip_rate } = job.data;
      const clip_cents = Math.max(1, Math.floor(amount_zar * clip_rate * 100));
      
      console.log(`[GreenWallet] Clip R${clip_cents / 100} for user ${user_id}`);
      // In production: INSERT INTO greenwallet_clips + UPDATE wallets
      
      return { clip_cents };
    }

    if (job.name === "settle-batch") {
      // Run daily — aggregate all unsettled clips and allocate to projects
      console.log(`[GreenWallet] Running daily batch settlement...`);
      // In production: 
      //   SELECT SUM(clip_cents) FROM greenwallet_clips WHERE settled = false
      //   Allocate to active green_projects
      //   UPDATE greenwallet_clips SET settled = true, settled_batch_id = $1
      return { status: "settled" };
    }
  },
  { connection, concurrency: 20 }
);

// ─────────────────────────────────────────────
// NOTIFICATION WORKER — Clickatell SMS
// ─────────────────────────────────────────────

const SMS_TEMPLATES: Record<string, (vars: Record<string, string>) => string> = {
  kyc_submitted: (v) => `MoveEasy: Your identity verification has been submitted, ${v.name}. We'll notify you within 2 hours.`,
  kyc_verified: (v) => `MoveEasy: ✓ Identity verified! You can now transact across all MoveEasy products.`,
  payment_confirmed: (v) => `MoveEasy: ✓ Payment of ${v.amount} confirmed. Ref: ${v.tx_id}`,
  safebet_usdc_purchased: (v) => `SafeBet: ${v.usdc} USDC saved from R${v.zar} deposit. Locked for 3 months.`,
  fuel_voucher_ready: (v) => `EasyFuel: Your voucher is ready. Code: ${v.code}. Valid at ${v.station}.`,
  otp: (v) => `MoveEasy OTP: ${v.code}. Valid for 5 minutes. Do not share.`,
};

const notificationWorker = new Worker(
  "notification-jobs",
  async (job) => {
    const { user_id, phone, channel, template, vars } = job.data;

    if (channel === "sms") {
      const message = SMS_TEMPLATES[template]?.(vars) || vars.message;
      
      console.log(`[SMS] → ${phone}: ${message}`);
      
      // In production: POST to Clickatell API
      // fetch('https://platform.clickatell.com/messages', {
      //   method: 'POST',
      //   headers: { Authorization: `Bearer ${process.env.CLICKATELL_API_KEY}` },
      //   body: JSON.stringify({ messages: [{ channel: 'sms', to: phone, content: message }] })
      // })

      return { status: "sent", provider_ref: `CLICK_MOCK_${Date.now()}` };
    }
  },
  { connection, concurrency: 50 }
);

// ─────────────────────────────────────────────
// BRAIN WORKER — AI analysis
// ─────────────────────────────────────────────

const brainWorker = new Worker(
  "brain-jobs",
  async (job) => {
    const { user_id, trigger } = job.data;
    console.log(`[Brain] Triggered for ${user_id} — reason: ${trigger}`);

    // Call brain API endpoint
    const response = await fetch(`http://127.0.0.1:3002/api/brain/analyse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, events: job.data.events || [] }),
    });

    if (!response.ok) {
      throw new Error(`Brain API error: ${response.status}`);
    }

    const result = await response.json();
    
    // Execute recommended actions
    for (const action of result.analysis?.recommended_actions || []) {
      console.log(`[Brain] Executing action: ${action.action_type} → ${action.product_target}`);
      
      if (action.action_type === "notification_sms") {
        await notificationQueue.add("brain-notification", {
          user_id,
          channel: "sms",
          template: "custom",
          vars: { message: action.payload?.message },
        });
      }

      if (action.action_type === "compliance_flag") {
        console.log(`[Compliance] FLAG raised for ${user_id}:`, action.payload);
        // In production: INSERT INTO compliance_flags
      }
    }

    return result;
  },
  { connection, concurrency: 3 }
);

// ─────────────────────────────────────────────
// SCHEDULED JOBS
// ─────────────────────────────────────────────

// Daily GreenWallet batch settlement (2am SAST)
greenWalletQueue.add("settle-batch", {}, {
  repeat: { cron: "0 2 * * *", tz: "Africa/Johannesburg" },
  jobId: "daily-green-settle",
});

// SafeBet principal unlock check (daily 6am SAST)
// In production: trigger DB function unlock_safebet_principals()

// Error handling
[kycWorker, paymentWorker, safeBetWorker, greenWalletWorker, notificationWorker, brainWorker]
  .forEach(worker => {
    worker.on("failed", (job, err) => {
      console.error(`[Worker] Job ${job?.id} failed in ${job?.queueName}:`, err.message);
    });
    worker.on("completed", (job) => {
      console.log(`[Worker] Job ${job.id} completed in ${job.queueName}`);
    });
  });

console.log("🚀 MoveEasy Workers started");
console.log("   Queues: kyc | payments | safebet | greenwallet | notifications | brain");
