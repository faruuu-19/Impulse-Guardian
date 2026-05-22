import { Router, Request, Response } from 'express';
import {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  isAuthorized,
  getCurrentlyPlaying,
} from '../services/spotifyService';

const router = Router();

router.get('/login', (_req: Request, res: Response) => {
  try {
    const url = getAuthorizeUrl();
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    res.status(400).send(`Spotify authorization failed: ${error}`);
    return;
  }
  if (!code) {
    res.status(400).send('Missing authorization code.');
    return;
  }

  try {
    await exchangeCodeForTokens(code);
    res
      .status(200)
      .send(
        '<h1>Spotify connected.</h1><p>Refresh token stored. You can close this tab.</p>'
      );
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[Auth] Token exchange failed:', msg);
    res.status(500).send(`Token exchange failed: ${msg}`);
  }
});

router.get('/status', (_req: Request, res: Response) => {
  res.json({ spotifyAuthorized: isAuthorized() });
});

router.get('/now-playing', async (_req: Request, res: Response) => {
  if (!isAuthorized()) {
    res.status(401).json({ error: 'Spotify not authorized. Visit /auth/login first.' });
    return;
  }
  try {
    const ctx = await getCurrentlyPlaying();
    res.json(ctx);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
