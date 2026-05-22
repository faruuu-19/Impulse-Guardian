import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { SpotifyContext } from '../../../shared/types';

const TOKEN_FILE = path.join(__dirname, '..', '..', '.spotify-tokens.json');

interface StoredTokens {
  refreshToken: string;
  obtainedAt: number;
}

interface TokenState {
  accessToken: string | null;
  accessTokenExpiresAt: number;
  refreshToken: string | null;
}

const state: TokenState = {
  accessToken: null,
  accessTokenExpiresAt: 0,
  refreshToken: null,
};

function loadStoredTokens(): void {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
      const parsed = JSON.parse(raw) as StoredTokens;
      state.refreshToken = parsed.refreshToken;
      console.log('[Spotify] Loaded refresh token from', TOKEN_FILE);
    } else if (process.env.SPOTIFY_REFRESH_TOKEN) {
      state.refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
      console.log('[Spotify] Loaded refresh token from .env');
    }
  } catch (e) {
    console.error('[Spotify] Failed to load tokens:', (e as Error).message);
  }
}

loadStoredTokens();

function saveRefreshToken(refreshToken: string): void {
  const payload: StoredTokens = { refreshToken, obtainedAt: Date.now() };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2), 'utf8');
  state.refreshToken = refreshToken;
  console.log('[Spotify] Refresh token persisted to', TOKEN_FILE);
}

export function isAuthorized(): boolean {
  return state.refreshToken !== null;
}

export function getAuthorizeUrl(): string {
  const clientId = requireEnv('SPOTIFY_CLIENT_ID');
  const redirectUri = requireEnv('SPOTIFY_REDIRECT_URI');
  const scope = 'user-read-currently-playing user-read-playback-state';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope,
    redirect_uri: redirectUri,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const clientId = requireEnv('SPOTIFY_CLIENT_ID');
  const clientSecret = requireEnv('SPOTIFY_CLIENT_SECRET');
  const redirectUri = requireEnv('SPOTIFY_REDIRECT_URI');
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const accessToken = res.data.access_token as string;
  const refreshToken = res.data.refresh_token as string;
  const expiresIn = res.data.expires_in as number;

  state.accessToken = accessToken;
  state.accessTokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;
  saveRefreshToken(refreshToken);
}

async function getAccessToken(): Promise<string> {
  if (state.accessToken && Date.now() < state.accessTokenExpiresAt) {
    return state.accessToken;
  }
  if (!state.refreshToken) {
    throw new Error(
      'Spotify is not authorized. Visit /auth/login to complete OAuth.'
    );
  }

  const clientId = requireEnv('SPOTIFY_CLIENT_ID');
  const clientSecret = requireEnv('SPOTIFY_CLIENT_SECRET');
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
    }),
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  state.accessToken = res.data.access_token as string;
  state.accessTokenExpiresAt =
    Date.now() + ((res.data.expires_in as number) - 60) * 1000;

  if (res.data.refresh_token) {
    saveRefreshToken(res.data.refresh_token as string);
  }

  return state.accessToken;
}

export async function getCurrentlyPlaying(): Promise<SpotifyContext> {
  const token = await getAccessToken();

  const res = await axios.get(
    'https://api.spotify.com/v1/me/player/currently-playing',
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
      validateStatus: (s) => s < 500,
    }
  );

  if (res.status === 204 || !res.data?.item) {
    return {
      isPlaying: false,
      trackName: 'Nothing playing',
      artist: 'Unknown',
      energy: 0.3,
      tempo: 80,
    };
  }

  const track = res.data.item;
  const trackId: string = track.id;
  const trackName: string = track.name;
  const artist: string = (track.artists as Array<{ name: string }>)
    .map((a) => a.name)
    .join(', ');
  const images = (track.album?.images ?? []) as Array<{ url: string; width: number; height: number }>;
  const albumArt = images.length
    ? images.reduce((a, b) => (a.width >= b.width ? a : b)).url
    : undefined;

  let energy = 0.5;
  let tempo = 120;

  const feat = await axios.get(
    `https://api.spotify.com/v1/audio-features/${trackId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
      validateStatus: (s) => s < 500,
    }
  );

  if (feat.status === 200 && feat.data) {
    energy = feat.data.energy as number;
    tempo = feat.data.tempo as number;
  }

  return { isPlaying: res.data.is_playing ?? true, trackName, artist, energy, tempo, albumArt };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
