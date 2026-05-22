import { Router, Request, Response } from 'express';
import { store } from '../store';
import { sendSMS } from '../services/twilioService';
import { replyToInboundSms } from '../services/groqService';
import { captureOrder } from '../services/paypalService';

const router = Router();

// Twilio webhook — incoming SMS
router.post('/sms', async (req: Request, res: Response) => {
  const from: string = (req.body.From as string) ?? '';
  const body: string = ((req.body.Body as string) ?? '').trim();

  console.log(`\n[Webhook] SMS received from ${from}: "${body}"`);

  // Respond to Twilio immediately so it doesn't retry.
  res
    .type('text/xml')
    .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // Resolve any pending YES/NO confirmation callback.
  const resolved = store.resolveSmsCallback(from, body);
  console.log(
    resolved
      ? `[Webhook] SMS callback resolved for ${from}`
      : `[Webhook] No pending callback for ${from}`
  );

  // Generate a contextual reply via Groq and send it back via Twilio.
  try {
    const tx = store.findLatestTransactionByPhone(from);
    const llmReply = await replyToInboundSms({
      inbound: body,
      productName: tx?.product.name,
      productPrice: tx?.product.price,
      impulseScore: tx?.impulseScore?.score,
      decisionResolved: resolved,
    });

    const sid = await sendSMS(from, llmReply);
    console.log(`[Webhook] Groq reply sent to ${from} (SID: ${sid}): "${llmReply}"`);
  } catch (err) {
    console.error(
      '[Webhook] Groq/Twilio reply failed:',
      (err as Error).message
    );
  }
});

// PayPal return URL — buyer approved, capture the order.
router.get('/paypal/return', async (req: Request, res: Response) => {
  const orderId = (req.query.token as string | undefined) ?? '';
  if (!orderId) {
    res.status(400).send('Missing PayPal order token.');
    return;
  }

  try {
    const result = await captureOrder(orderId);

    const tx = store.findTransactionByOrder(orderId);
    if (tx) {
      store.addLog(tx.id, {
        timestamp: new Date().toISOString(),
        step: 'paypal',
        message: `Payment captured! Status: ${result.status} | Capture ID: ${result.captureId}`,
        type: 'success',
      });
      store.setStatus(tx.id, 'captured');
      store.emit(tx.id, 'complete', {
        status: 'captured',
        orderId,
        captureId: result.captureId,
      });
    }

    res
      .status(200)
      .send(
        `<h1>Payment captured.</h1><p>Order ${orderId} status: ${result.status}.</p>`
      );
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[Webhook] PayPal capture failed:', msg);
    res.status(500).send(`Capture failed: ${msg}`);
  }
});

router.get('/paypal/cancel', (req: Request, res: Response) => {
  const orderId = (req.query.token as string | undefined) ?? '';
  const tx = store.findTransactionByOrder(orderId);
  if (tx) {
    store.setStatus(tx.id, 'cancelled');
    store.emit(tx.id, 'complete', { status: 'cancelled', reason: 'paypal_cancelled' });
  }
  res.status(200).send('<h1>Payment cancelled.</h1>');
});

export default router;
