# Impulse Purchase Guardian

Real-time, event-driven checkout backend. A purchase request is scored against the user's live Spotify listening context; medium/high risk purchases gate behind a real Twilio SMS confirmation, and payment is captured in PayPal Sandbox after the buyer approves the order. Inbound SMS replies are also piped to **Groq** to generate an LLM response sent back via Twilio.

**No mocks. No demo fallbacks.** Every external call hits a real API.

## Architecture

```
POST /api/checkout
        │
        ▼
┌───────────────────────────────────────┐
│   Express Workflow (in-memory FSM)    │
│                                       │
│  1. analyzing                         │
│  2. Spotify /me/player/currently-     │
│     playing  (OAuth refresh token)    │
│  3. ImpulseScore                      │
│  4. (high risk) 60s real async        │
│     cooldown                          │
│  5. awaiting_sms ── Twilio sendSMS    │
│            ▲                          │
│            │ Twilio webhook           │
│            │  POST /api/webhook/sms   │
│            │  (ngrok → Express)       │
│  6. PayPal createOrder → approveUrl   │
│  7. buyer approves in sandbox         │
│  8. PayPal redirect → /paypal/return  │
│     → captureOrder                    │
└───────────────────────────────────────┘
            │
            ▼
   SSE /api/stream/:id  (live updates)
```

Every inbound SMS is also forwarded to Groq; the LLM-generated reply is sent back to the user via Twilio.

## Decision Logic

| Impulse Score | Action |
|---|---|
| amount ≤ $100 | Auto-approve, immediate PayPal order |
| 0 – 49        | Auto-approve, immediate PayPal order |
| 50 – 74       | Real Twilio SMS — PayPal order only on `YES` reply |
| 75 – 100      | 60-second async cooldown + SMS — PayPal order only on `YES` reply |

Score factors: `+40` high-energy music, `+20` medium energy, `-30` calm, `+10` price > $100.

## Setup

### 1. Configure environment

```bash
cp .env.example .env
# Fill in every value — no var is optional.
```

Required vars (see `.env.example` for full annotated list):

- Spotify: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`
- Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `USER_PHONE_NUMBER`
- PayPal: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL`
- Groq: `GROQ_API_KEY` (`GROQ_MODEL` optional)

### 2. Install + typecheck + run

```bash
cd backend
npm install
npm run typecheck   # tsc --noEmit
npm run dev         # ts-node-dev on PORT (default 3000)
```

### 3. Expose webhooks with ngrok

```bash
ngrok http 3000
```

Then update three things to your `https://<ngrok-id>.ngrok-free.app` URL:

| Where | What |
|---|---|
| Twilio console → Phone Number → Messaging webhook | `https://<ngrok>/api/webhook/sms` (HTTP POST) |
| `.env` `PAYPAL_RETURN_URL` | `https://<ngrok>/api/webhook/paypal/return` |
| `.env` `PAYPAL_CANCEL_URL` | `https://<ngrok>/api/webhook/paypal/cancel` |

> PayPal sandbox needs publicly reachable return URLs only if the buyer is on a different device. Localhost works for same-machine testing.

### 4. Authorize Spotify (one-time)

```
http://localhost:3000/auth/login
```

You'll be redirected to Spotify, approve the scopes (`user-read-currently-playing`, `user-read-playback-state`), then Spotify will redirect back to `SPOTIFY_REDIRECT_URI`. The refresh token is written to `backend/.spotify-tokens.json` and reused across restarts.

### 5. Trigger a checkout

```bash
curl -X POST http://localhost:3000/api/checkout \
  -H "Content-Type: application/json" \
  -d '{"productName":"Gaming Headset","price":300}'
```

The response includes `transactionId`. Stream live updates:

```bash
curl -N http://localhost:3000/api/stream/<transactionId>
```

When the workflow reaches the SMS gate, **reply YES from your phone**. Twilio's webhook resolves the in-memory pending promise, the workflow creates the PayPal order, and the SSE stream emits a `complete` event with the `approveUrl`. Open that URL in a browser, log into a sandbox buyer account, and approve. PayPal redirects to `/api/webhook/paypal/return`, the backend captures the payment, and the SSE stream emits `complete { status: 'captured', captureId }`.

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET`  | `/auth/login`                    | Start Spotify OAuth |
| `GET`  | `/auth/callback`                 | Spotify OAuth callback (persists refresh token) |
| `GET`  | `/auth/status`                   | `{ spotifyAuthorized: bool }` |
| `POST` | `/api/checkout`                  | Body `{ productName?, price?, customerPhone? }` |
| `GET`  | `/api/stream/:id`                | SSE event stream |
| `POST` | `/api/webhook/sms`               | Twilio inbound SMS (also triggers Groq reply) |
| `GET`  | `/api/webhook/paypal/return`     | PayPal buyer-approved redirect → captures order |
| `GET`  | `/api/webhook/paypal/cancel`     | PayPal cancel redirect |
| `GET`  | `/api/health`                    | `{ status: 'ok' }` |

## Project Layout

```
.
├── .env.example
├── README.md
├── shared/
│   └── types.ts
└── backend/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── server.ts
        ├── store.ts            # in-memory transaction state machine
        ├── routes/
        │   ├── auth.ts         # Spotify OAuth
        │   ├── checkout.ts     # workflow engine
        │   ├── stream.ts       # SSE
        │   └── webhook.ts      # Twilio + PayPal + Groq
        └── services/
            ├── spotifyService.ts   # OAuth + currently-playing + audio-features
            ├── twilioService.ts    # real SMS only
            ├── paypalService.ts    # sandbox createOrder/captureOrder
            ├── groqService.ts      # LLM SMS replies
            └── impulseEngine.ts    # scoring
```
