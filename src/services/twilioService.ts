import twilio from 'twilio';

let client: ReturnType<typeof twilio> | null = null;

function getClient(): ReturnType<typeof twilio> {
  if (!client) {
    const sid = requireEnv('TWILIO_ACCOUNT_SID');
    const token = requireEnv('TWILIO_AUTH_TOKEN');
    client = twilio(sid, token);
  }
  return client;
}

export async function sendSMS(to: string, body: string): Promise<string> {
  const from = requireEnv('TWILIO_PHONE_NUMBER');
  const msg = await getClient().messages.create({ body, from, to });
  return msg.sid;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
