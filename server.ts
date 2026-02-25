import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';
import { TuringRuntime } from './server/runtime.js';

async function startServer(): Promise<void> {
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  const runtime = new TuringRuntime();
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);

  await runtime.init();

  function broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }

  runtime.on('tape', (content: string) => {
    broadcast({ type: 'tape_update', content });
  });

  runtime.on('status', (status: string) => {
    broadcast({ type: 'status', status });
  });

  runtime.on('state', ({ q, d }: { q: string; d: string }) => {
    broadcast({ type: 'state_update', q, d });
  });

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    const snapshot = await runtime.getSnapshot();
    res.json({ status: 'ok', runtime: snapshot.status, error: snapshot.error });
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const message = typeof req.body?.message === 'string' ? req.body.message : '';
      if (!message.trim()) {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      await runtime.appendUserMessage(message);
      res.status(202).json({ status: 'accepted' });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? 'Failed to append message' });
    }
  });

  app.get('/api/workspace', async (_req, res) => {
    try {
      const files = await runtime.listWorkspaceFiles();
      res.json({ files });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? 'Failed to list workspace files' });
    }
  });

  app.get('/api/workspace/file', async (req, res) => {
    try {
      const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
      if (!filename) {
        res.status(400).send('Filename required');
        return;
      }

      const content = await runtime.readWorkspaceFile(filename);
      res.type('text/plain').send(content);
    } catch (error: any) {
      if (String(error?.message ?? '').includes('escapes workspace')) {
        res.status(400).send('Invalid path');
        return;
      }

      if (String(error?.message ?? '').includes('no such file')) {
        res.status(404).send('Not found');
        return;
      }

      if (String(error?.message ?? '').includes('directory')) {
        res.status(400).send('Path is a directory');
        return;
      }

      res.status(500).send(error?.message ?? 'Failed to read file');
    }
  });

  wss.on('connection', async (ws) => {
    const snapshot = await runtime.getSnapshot();

    ws.send(JSON.stringify({ type: 'tape_update', content: snapshot.tape }));
    ws.send(JSON.stringify({ type: 'status', status: snapshot.status }));
    ws.send(JSON.stringify({ type: 'state_update', q: snapshot.q, d: snapshot.d }));
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('[SERVER FATAL]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
