import { Router, Request, Response } from 'express';
import { store } from '../store';
import { getCurrentlyPlaying, isAuthorized } from '../services/spotifyService';
import { calculateImpulseScore } from '../services/impulseEngine';
import { createOrder } from '../services/paypalService';
import { sendSMS } from '../services/twilioService';
import { generatePurchaseAlertSms } from '../services/groqService';
import {
  WorkflowLog,
  TransactionStatus,
  SpotifyContext,
} from '../../../shared/types';

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function log(
  txId: string,
  step: string,
  message: string,
  type: WorkflowLog['type'] = 'info'
): void {
  const entry: WorkflowLog = {
    timestamp: new Date().toISOString(),
    step,
    message,
    type,
  };
  store.addLog(txId, entry);
  const prefix = `[${type.toUpperCase().padEnd(7)}][${step.padEnd(10)}]`;
  console.log(`${prefix} ${message}`);
}

function setStatus(txId: string, status: TransactionStatus): void {
  store.setStatus(txId, status);
  console.log(`[STATUS] ${txId} → ${status}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForSms(phone: string, timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('SMS reply timed out')),
      timeoutMs
    );
    store.setSmsCallback(phone, (reply) => {
      clearTimeout(t);
      resolve(reply);
    });
  });
}

// ── PayPal helpers ───────────────────────────────────────────────────────────

async function startPaypalApproval(
  txId: string,
  amount: number,
  productName: string
): Promise<void> {
  log(txId, 'paypal', `Creating PayPal sandbox order for $${amount.toFixed(2)}…`);
  const { orderId, approveUrl } = await createOrder(amount, 'USD', productName);
  store.update(txId, { paypalOrderId: orderId });
  log(txId, 'paypal', `Order created: ${orderId}`, 'success');
  log(txId, 'paypal', `Open this URL to approve in PayPal sandbox: ${approveUrl}`);
  setStatus(txId, 'approved');
  store.emit(txId, 'complete', {
    status: 'approved',
    orderId,
    approveUrl,
  });
}

// ── main workflow ────────────────────────────────────────────────────────────

async function runWorkflow(txId: string): Promise<void> {
  const tx = store.get(txId);
  if (!tx) return;

  const { product, customerPhone } = tx;

  try {
    setStatus(txId, 'analyzing');
    log(
      txId,
      'init',
      `Starting checkout for "${product.name}" @ $${product.price} — customer ${customerPhone}`
    );

    // ── 1. Low-value fast path ──────────────────────────────────────────────
    if (product.price <= 100) {
      log(
        txId,
        'decision',
        `Amount $${product.price} ≤ $100 → auto-approve`,
        'success'
      );
      await startPaypalApproval(txId, product.price, product.name);
      return;
    }

    // ── 2. Spotify context (real API only) ──────────────────────────────────
    if (!isAuthorized()) {
      throw new Error(
        'Spotify not authorized. Visit /auth/login to grant access before initiating a high-value checkout.'
      );
    }

    log(txId, 'spotify', 'Fetching Spotify listening context…');
    let spotify: SpotifyContext;
    try {
      spotify = await getCurrentlyPlaying();
      store.update(txId, { spotifyContext: spotify });
      store.emit(txId, 'spotify_update', spotify);

      if (spotify.isPlaying) {
        log(
          txId,
          'spotify',
          `Now playing: "${spotify.trackName}" by ${spotify.artist} | Energy ${(spotify.energy * 100).toFixed(0)}% | ${spotify.tempo.toFixed(0)} BPM`
        );
      } else {
        log(txId, 'spotify', 'No track currently playing.');
      }
    } catch (err) {
      const msg = (err as Error).message;
      log(txId, 'spotify', `Spotify fetch failed: ${msg}`, 'error');
      throw err;
    }

    // ── 3. Impulse score ────────────────────────────────────────────────────
    log(txId, 'impulse', 'Calculating impulse risk score…');
    const score = calculateImpulseScore(spotify, product.price);
    store.update(txId, { impulseScore: score });
    store.emit(txId, 'score_update', score);

    log(txId, 'impulse', `Score: ${score.score}/100`);
    score.factors.forEach((f) => log(txId, 'impulse', `  ${f}`));
    log(txId, 'impulse', `Reasoning: ${score.reasoning}`);

    // ── 4. Decision ─────────────────────────────────────────────────────────
    if (score.score < 50) {
      log(
        txId,
        'decision',
        `Score ${score.score} < 50 — low risk, auto-approving`,
        'success'
      );
      await startPaypalApproval(txId, product.price, product.name);
      return;
    }

    if (score.score < 75) {
      log(
        txId,
        'decision',
        `Score ${score.score} (50-74) — moderate risk, requesting SMS confirmation`,
        'warning'
      );
    } else {
      log(
        txId,
        'decision',
        `Score ${score.score} ≥ 75 — high risk, starting 60-second cooldown`,
        'warning'
      );
      setStatus(txId, 'cooldown');

      const cooldownEndsAt = new Date(Date.now() + 60_000).toISOString();
      store.update(txId, { cooldownEndsAt });
      store.emit(txId, 'cooldown_start', {
        endsAt: cooldownEndsAt,
        durationMs: 60_000,
      });

      let cooldownBody: string;
      try {
        cooldownBody = await generatePurchaseAlertSms({
          kind: 'cooldown',
          productName: product.name,
          productPrice: product.price,
          impulseScore: score.score,
          trackName: spotify.trackName,
          artist: spotify.artist,
          energy: spotify.energy,
          tempo: spotify.tempo,
        });
      } catch (e) {
        log(txId, 'sms', `Groq SMS generation failed, using fallback: ${(e as Error).message}`, 'warning');
        cooldownBody = `[Impulse Guardian] COOLDOWN ACTIVE. Reconsider your purchase of ${product.name} ($${product.price}) for 60 seconds. A confirmation request follows.`;
      }
      const cooldownSid = await sendSMS(customerPhone, cooldownBody);
      log(txId, 'sms', `Cooldown SMS body: ${cooldownBody}`);
      log(txId, 'sms', `Cooldown SMS sent (SID: ${cooldownSid})`);

      for (let remaining = 60; remaining > 0; remaining -= 10) {
        log(txId, 'cooldown', `⏱  ${remaining}s remaining…`);
        await sleep(10_000);
      }
      log(
        txId,
        'cooldown',
        'Cooldown complete — sending confirmation SMS',
        'success'
      );
    }

    setStatus(txId, 'awaiting_sms');
    let smsText: string;
    try {
      smsText = await generatePurchaseAlertSms({
        kind: 'confirmation',
        productName: product.name,
        productPrice: product.price,
        impulseScore: score.score,
        trackName: spotify.trackName,
        artist: spotify.artist,
        energy: spotify.energy,
        tempo: spotify.tempo,
      });
      if (!/yes/i.test(smsText) || !/no/i.test(smsText)) {
        smsText += ' Reply YES to proceed, NO to walk away.';
      }
    } catch (e) {
      log(txId, 'sms', `Groq SMS generation failed, using fallback: ${(e as Error).message}`, 'warning');
      smsText =
        `[Impulse Guardian] Potentially impulsive purchase: ${product.name} ($${product.price}). ` +
        `Reply YES to confirm or NO to cancel.`;
    }

    const sid = await sendSMS(customerPhone, smsText);
    log(txId, 'sms', `Confirmation SMS body: ${smsText}`);
    log(
      txId,
      'sms',
      `Confirmation SMS sent to ${customerPhone} (SID: ${sid})`,
      'success'
    );
    log(txId, 'sms', 'Waiting for SMS reply (YES / NO)…');

    const reply = await waitForSms(customerPhone);
    log(txId, 'sms', `Reply received: "${reply}"`, 'success');

    if (/\byes\b/i.test(reply)) {
      log(txId, 'decision', 'User confirmed via SMS', 'success');
      await startPaypalApproval(txId, product.price, product.name);
    } else {
      log(txId, 'decision', 'User cancelled via SMS', 'warning');
      setStatus(txId, 'cancelled');
      store.emit(txId, 'complete', { status: 'cancelled' });
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[Workflow]', msg);
    log(txId, 'error', `Workflow error: ${msg}`, 'error');
    setStatus(txId, 'failed');
    store.emit(txId, 'complete', { status: 'failed', error: msg });
  }
}

// ── route handler ────────────────────────────────────────────────────────────

interface CheckoutBody {
  productId?: string;
  productName?: string;
  price?: number;
  currency?: string;
  customerPhone?: string;
}

router.post('/preview-sms', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    price?: number;
    productName?: string;
    kind?: 'cooldown' | 'confirmation';
  };
  const price = typeof body.price === 'number' ? body.price : 5000;
  const productName = body.productName ?? 'Gaming Headset';
  const kind = body.kind === 'cooldown' ? 'cooldown' : 'confirmation';

  let spotify: SpotifyContext | undefined;
  try {
    if (isAuthorized()) spotify = await getCurrentlyPlaying();
  } catch {
    // ignore — generate without spotify context
  }

  try {
    const text = await generatePurchaseAlertSms({
      kind,
      productName,
      productPrice: price,
      trackName: spotify?.isPlaying ? spotify.trackName : undefined,
      artist: spotify?.isPlaying ? spotify.artist : undefined,
      energy: spotify?.isPlaying ? spotify.energy : undefined,
      tempo: spotify?.isPlaying ? spotify.tempo : undefined,
    });
    res.json({ sms: text, spotify });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CheckoutBody;

  const defaultPhone = process.env.USER_PHONE_NUMBER;
  const customerPhone = body.customerPhone ?? defaultPhone;
  if (!customerPhone) {
    res.status(400).json({
      error:
        'customerPhone is required (or set USER_PHONE_NUMBER in .env as the default).',
    });
    return;
  }

  const product = {
    id: body.productId ?? 'gaming-headset-001',
    name: body.productName ?? 'Gaming Headset',
    price: typeof body.price === 'number' ? body.price : 300,
    currency: body.currency ?? 'USD',
  };

  const tx = store.create(product, customerPhone);

  runWorkflow(tx.id).catch((e) =>
    console.error('[Checkout] Unhandled:', e)
  );

  res.json({
    transactionId: tx.id,
    product,
    customerPhone,
    message:
      'Checkout initiated — connect to SSE stream for live updates.',
  });
});

export default router;
