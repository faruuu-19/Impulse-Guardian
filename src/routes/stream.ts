import { Router, Request, Response } from 'express';
import { store } from '../store';

const router = Router();

router.get('/:transactionId', (req: Request, res: Response) => {
  const { transactionId } = req.params;

  const transaction = store.get(transactionId);
  if (!transaction) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (type: string, data: unknown) => {
    try {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    } catch {
      // client disconnected
    }
  };

  // Replay existing state
  store.getLogs(transactionId).forEach((log) => send('log', log));

  const current = store.get(transactionId);
  if (current) {
    send('status_update', { status: current.status });
    if (current.spotifyContext) send('spotify_update', current.spotifyContext);
    if (current.impulseScore) send('score_update', current.impulseScore);
    if (current.cooldownEndsAt) {
      send('cooldown_start', { endsAt: current.cooldownEndsAt, durationMs: 60000 });
    }
    if (current.status === 'captured' || current.status === 'cancelled' || current.status === 'failed') {
      send('complete', { status: current.status });
      res.end();
      return;
    }
  }

  const emitter = store.getEmitter(transactionId);
  if (!emitter) { res.end(); return; }

  const onLog        = (d: unknown) => send('log', d);
  const onStatus     = (d: unknown) => send('status_update', d);
  const onSpotify    = (d: unknown) => send('spotify_update', d);
  const onScore      = (d: unknown) => send('score_update', d);
  const onCooldown   = (d: unknown) => send('cooldown_start', d);
  const onComplete   = (d: unknown) => { send('complete', d); cleanup(); res.end(); };

  emitter.on('log', onLog);
  emitter.on('status_update', onStatus);
  emitter.on('spotify_update', onSpotify);
  emitter.on('score_update', onScore);
  emitter.on('cooldown_start', onCooldown);
  emitter.on('complete', onComplete);

  function cleanup() {
    emitter?.off('log', onLog);
    emitter?.off('status_update', onStatus);
    emitter?.off('spotify_update', onSpotify);
    emitter?.off('score_update', onScore);
    emitter?.off('cooldown_start', onCooldown);
    emitter?.off('complete', onComplete);
  }

  req.on('close', cleanup);
});

export default router;
