#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekBridge, DEBUG_DIR } from './browser.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DS_BRIDGE_PORT || 32123);
const BRIDGE_VERSION = '0.4.3';
const HOST = '127.0.0.1';

const bridge = new DeepSeekBridge({ headless: false, timeoutMs: 120_000 });
let queue = Promise.resolve();
let shuttingDown = false;

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  if (!data.trim()) return {};
  return JSON.parse(data);
}

async function route(req, res) {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const started = Boolean(bridge.page && bridge.context);
      const url = started ? bridge.page.url() : null;
      return sendJson(res, 200, { ok: true, pid: process.pid, started, url, version: BRIDGE_VERSION });
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    if (req.method === 'POST' && req.url === '/ask') {
      const body = await readJson(req);
      const answer = await enqueue(() => bridge.ask(body.prompt, {
        newChat: Boolean(body.newChat),
        chat: body.chat || null
      }));
      return sendJson(res, 200, { ok: true, answer, conversationId: bridge.getConversationId(bridge.page.url()) });
    }

    if (req.method === 'GET' && req.url === '/status') {
      const status = await enqueue(() => bridge.status());
      return sendJson(res, 200, { ok: true, status });
    }

    if (req.method === 'GET' && req.url === '/history') {
      const chats = await enqueue(() => bridge.listConversations(50));
      return sendJson(res, 200, { ok: true, chats });
    }

    if (req.method === 'POST' && req.url === '/new') {
      const conversation = await enqueue(() => bridge.createConversation());
      return sendJson(res, 200, { ok: true, conversation });
    }

    if (req.method === 'POST' && req.url === '/setup') {
      await enqueue(() => bridge.ensureLoggedIn());
      return sendJson(res, 200, { ok: true, status: await bridge.status() });
    }

    if (req.method === 'POST' && req.url === '/stop') {
      await sendJson(res, 200, { ok: true });
      setImmediate(() => shutdown());
      return;
    }

    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const message = error?.message || String(error);
    return sendJson(res, 500, { error: message });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch(async (error) => {
    await sendJson(res, 500, { error: error?.message || String(error) });
  });
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { await bridge.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', async (error) => {
  await fs.mkdir(DEBUG_DIR, { recursive: true }).catch(() => {});
  await fs.appendFile(path.join(DEBUG_DIR, 'daemon.err.log'), `uncaughtException: ${error?.stack || error}\n`).catch(() => {});
  await shutdown();
});
process.on('unhandledRejection', async (error) => {
  await fs.mkdir(DEBUG_DIR, { recursive: true }).catch(() => {});
  await fs.appendFile(path.join(DEBUG_DIR, 'daemon.err.log'), `unhandledRejection: ${error?.stack || error}\n`).catch(() => {});
});

await fs.mkdir(DEBUG_DIR, { recursive: true });
await bridge.start();
server.listen(PORT, HOST, () => {
  console.log(`DeepSeek bridge daemon listening on http://${HOST}:${PORT}`);
});
