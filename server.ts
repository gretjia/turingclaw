import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { TuringClawEngine } from './server/engine';

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // Workspace setup
  const workspacePath = path.join(process.cwd(), 'workspace');
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath);
  }

  const engine = new TuringClawEngine(wss);

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    await engine.addUserMessage(message);
    res.json({ status: 'ok' });
  });

  app.get('/api/workspace', (req, res) => {
    const getFiles = (dir: string, fileList: string[] = []) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
          getFiles(filePath, fileList);
        } else {
          fileList.push(path.relative(workspacePath, filePath));
        }
      }
      return fileList;
    };
    res.json({ files: getFiles(workspacePath) });
  });

  app.get('/api/workspace/file', (req, res) => {
    const filename = req.query.filename as string;
    if (!filename) return res.status(400).send('Filename required');
    const filePath = path.join(workspacePath, filename);
    if (fs.existsSync(filePath)) {
      res.send(fs.readFileSync(filePath, 'utf-8'));
    } else {
      res.status(404).send('Not found');
    }
  });

  // WebSocket handling
  wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.send(JSON.stringify({ type: 'tape_update', content: engine.readCellS(engine.getD()) }));
    ws.send(JSON.stringify({ type: 'status', status: engine.getIsRunning() ? 'running' : 'idle' }));
    ws.send(JSON.stringify({ type: 'state_update', q: engine.getQ(), d: engine.getD() }));
  });

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
