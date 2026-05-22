import { SpotifyContext, ImpulseScore } from '../../../shared/types';

const HIGH_RISK_ARTISTS = ['Macklemore', 'Black Sabbath', 'Eminem', 'Kanye West', 'AC/DC'];

export function calculateImpulseScore(
  context: SpotifyContext | null,
  amount: number
): ImpulseScore {
  let score = 0;
  const factors: string[] = [];

  if (!context || context.error) {
    score = 50;
    factors.push('Spotify unavailable — defaulting to neutral base score (50)');
    if (amount > 100) {
      score += 10;
      factors.push('+10: Purchase amount exceeds $100');
    }
    score = clamp(score);
    return { score, reasoning: buildReasoning(score, context), factors };
  }

  const energy = context.energy;
  const tempo = context.tempo;

  if (energy > 0.7 && tempo > 120) {
    score += 40;
    factors.push(
      `+40: High energy (${energy.toFixed(2)}) and high tempo (${tempo.toFixed(0)} BPM)`
    );
  } else if (energy > 0.7) {
    score += 25;
    factors.push(`+25: High energy (${energy.toFixed(2)})`);
  } else if (tempo > 120) {
    score += 15;
    factors.push(`+15: High tempo (${tempo.toFixed(0)} BPM)`);
  } else if (energy < 0.4 && tempo < 100) {
    score -= 30;
    factors.push(
      `-30: Low energy (${energy.toFixed(2)}) and low tempo (${tempo.toFixed(0)} BPM)`
    );
  }

  if (amount > 100) {
    score += 10;
    factors.push('+10: Purchase amount exceeds $100');
  }

  const artist = context.artist;
  if (artist && HIGH_RISK_ARTISTS.some((a) => a.toLowerCase() === artist.toLowerCase())) {
    score += 50;
    factors.push(`+50: High-risk artist (${artist})`);
  }

  score = clamp(score);
  return { score, reasoning: buildReasoning(score, context), factors };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function buildReasoning(score: number, context: SpotifyContext | null): string {
  const track =
    context?.isPlaying
      ? `"${context.trackName}" by ${context.artist}`
      : null;

  if (score >= 75) {
    return (
      `High impulse risk detected (score: ${score}/100). ` +
      (track
        ? `High-energy music ${track} combined with a high-value purchase signals elevated impulsive spending behaviour.`
        : 'Multiple risk factors indicate this may be an impulsive purchase.') +
      ' A 60-second cooldown has been activated to encourage reconsideration.'
    );
  }

  if (score >= 50) {
    return (
      `Moderate impulse risk detected (score: ${score}/100). ` +
      (track
        ? `The music you're listening to (${track}) may be influencing your purchasing decision.`
        : 'Some risk factors suggest this purchase may be impulsive.') +
      ' SMS confirmation is required before payment can proceed.'
    );
  }

  return (
    `Low impulse risk (score: ${score}/100). ` +
    (track
      ? `Your current listening context suggests a measured purchase decision.`
      : 'Risk factors are within acceptable range.') +
    ' Payment has been approved automatically.'
  );
}
