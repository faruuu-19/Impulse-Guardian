import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

// Load root .env first (project-level), then backend/.env (overrides).
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

import checkoutRouter from './routes/checkout';
import webhookRouter from './routes/webhook';
import streamRouter from './routes/stream';
import authRouter from './routes/auth';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/checkout', checkoutRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/stream', streamRouter);
app.use('/auth', authRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║      Impulse Purchase Guardian  ·  Backend           ║
║      http://localhost:${PORT}                        ║
║                                                      ║
║  GET  /auth/login                Spotify OAuth       ║
║  GET  /auth/callback             Spotify OAuth cb    ║
║  GET  /auth/status               Auth status         ║
║  POST /api/checkout              Start checkout      ║
║  GET  /api/stream/:id            SSE live updates    ║
║  POST /api/webhook/sms           Twilio webhook      ║
║  GET  /api/webhook/paypal/return PayPal return URL   ║
║  GET  /api/webhook/paypal/cancel PayPal cancel URL   ║
╚══════════════════════════════════════════════════════╝
  `);
});

export default app;
