import axios from 'axios';

const BASE = 'https://api-m.sandbox.paypal.com';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export interface CreateOrderResult {
  orderId: string;
  approveUrl: string;
}

export interface CaptureResult {
  status: string;
  captureId: string;
}

export async function createOrder(
  amount: number,
  currency = 'USD',
  description = 'Impulse Guardian purchase'
): Promise<CreateOrderResult> {
  const token = await getAccessToken();

  const returnUrl = requireEnv('PAYPAL_RETURN_URL');
  const cancelUrl = requireEnv('PAYPAL_CANCEL_URL');

  const res = await axios.post(
    `${BASE}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: currency, value: amount.toFixed(2) },
          description,
        },
      ],
      application_context: {
        return_url: returnUrl,
        cancel_url: cancelUrl,
        user_action: 'PAY_NOW',
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const orderId = res.data.id as string;
  const links = (res.data.links ?? []) as Array<{ rel: string; href: string }>;
  const approve = links.find((l) => l.rel === 'approve');
  if (!approve) throw new Error('PayPal response missing approve link');

  return { orderId, approveUrl: approve.href };
}

export async function captureOrder(orderId: string): Promise<CaptureResult> {
  const token = await getAccessToken();

  const res = await axios.post(
    `${BASE}/v2/checkout/orders/${orderId}/capture`,
    {},
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const capture = (
    res.data.purchase_units as Array<{
      payments: { captures: Array<{ id: string }> };
    }>
  )?.[0]?.payments?.captures?.[0];

  return {
    status: res.data.status as string,
    captureId: capture?.id ?? 'N/A',
  };
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const clientId = requireEnv('PAYPAL_CLIENT_ID');
  const clientSecret = requireEnv('PAYPAL_CLIENT_SECRET');
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await axios.post(
    `${BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  cachedToken = res.data.access_token as string;
  tokenExpiresAt =
    Date.now() + ((res.data.expires_in as number) - 60) * 1000;
  return cachedToken;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
