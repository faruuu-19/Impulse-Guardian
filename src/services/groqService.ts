import axios from 'axios';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Missing required env var: GROQ_API_KEY');

  const res = await axios.post(
    GROQ_URL,
    {
      model: DEFAULT_MODEL,
      messages,
      temperature: options.temperature ?? 0.5,
      max_tokens: options.maxTokens ?? 200,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  const choice = res.data?.choices?.[0]?.message?.content;
  if (typeof choice !== 'string') {
    throw new Error('Groq response missing choices[0].message.content');
  }
  return choice.trim();
}

export async function generatePurchaseAlertSms(params: {
  kind: 'cooldown' | 'confirmation';
  productName: string;
  productPrice: number;
  impulseScore?: number;
  trackName?: string;
  artist?: string;
  energy?: number;
  tempo?: number;
}): Promise<string> {
  const {
    kind,
    productName,
    productPrice,
    impulseScore,
    trackName,
    artist,
    energy,
    tempo,
  } = params;

  const system =
    `You write SMS messages for "Impulse Purchase Guardian" — a service that intervenes ` +
    `right before someone makes a regrettable expensive purchase. Your job is to write ONE ` +
    `SMS (max 300 chars, no emojis, no hashtags, no markdown) that is genuinely witty and ` +
    `rhetorical — the kind of message that makes the reader pause and laugh nervously at ` +
    `themselves. Think: a slightly judgmental but loving friend who happens to have read ` +
    `behavioral economics. Be specific to the context (the song they're listening to, the ` +
    `energy of the music, the absurdity of the price). Avoid: "Purchase alert", generic ` +
    `corporate-warning language, the words "intentional" or "confirm your purchase", ` +
    `exclamation points, and anything that sounds like a bank fraud SMS. ` +
    `End with EXACTLY: "Reply YES to proceed, NO to walk away." (must be the literal ` +
    `final sentence so the parser can pick up the reply).`;

  const contextLines: string[] = [
    `Product: ${productName}`,
    `Price: $${productPrice.toFixed(2)}`,
  ];
  if (typeof impulseScore === 'number') {
    contextLines.push(`Impulse risk score: ${impulseScore}/100`);
  }
  if (trackName && artist) {
    contextLines.push(`Currently playing: "${trackName}" by ${artist}`);
  }
  if (typeof energy === 'number') {
    contextLines.push(`Track energy: ${Math.round(energy * 100)}%`);
  }
  if (typeof tempo === 'number') {
    contextLines.push(`Track tempo: ${Math.round(tempo)} BPM`);
  }

  const kindHint =
    kind === 'cooldown'
      ? `This is the COOLDOWN message — a 60-second pause is starting before the real ` +
        `confirmation SMS arrives. Tone: "step away from the cart, take a breath." Do NOT ` +
        `ask for a reply in this one — instead end with EXACTLY: ` +
        `"A confirmation text will follow in 60 seconds." (literal final sentence).`
      : `This is the CONFIRMATION message — they get one chance to say YES or NO. Tone: ` +
        `"are you sure this is the version of you that should be making this call?" ` +
        `End with the YES/NO sentence from the system prompt.`;

  const user =
    `Context:\n${contextLines.join('\n')}\n\n` +
    `${kindHint}\n\n` +
    `Write the SMS now. Output ONLY the SMS text — no preamble, no quotes, no labels.`;

  const out = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.95, maxTokens: 180 }
  );
  return out.replace(/^["']|["']$/g, '').trim();
}

export async function replyToInboundSms(params: {
  inbound: string;
  productName?: string;
  productPrice?: number;
  impulseScore?: number;
  decisionResolved: boolean;
}): Promise<string> {
  const { inbound, productName, productPrice, impulseScore, decisionResolved } = params;

  const system =
    'You are the Impulse Purchase Guardian assistant. Reply in 1-2 short SMS-friendly sentences (under 320 characters). ' +
    'Be empathetic and concise. If the user confirmed (YES), acknowledge and reassure. If they cancelled (NO), affirm the wise choice. ' +
    'If the user asks a question, answer briefly. Never invent prices or order details beyond what is provided.';

  const context: string[] = [];
  if (productName) context.push(`Product: ${productName}`);
  if (typeof productPrice === 'number') context.push(`Price: $${productPrice.toFixed(2)}`);
  if (typeof impulseScore === 'number') context.push(`Impulse risk score: ${impulseScore}/100`);
  context.push(`Pending confirmation resolved by this message: ${decisionResolved}`);

  const user =
    `Context:\n${context.join('\n')}\n\n` +
    `User SMS reply: "${inbound}"\n\n` +
    `Write a short SMS reply to the user.`;

  return chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
}
