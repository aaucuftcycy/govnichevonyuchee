#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DS_BRIDGE_PORT || 32123);
const BRIDGE_VERSION = '0.4.3';
const HOST = '127.0.0.1';
const DEBUG_DIR = path.join(PROJECT_ROOT, '.debug');
const DAEMON_PATH = path.join(PROJECT_ROOT, 'src', 'daemon.mjs');

let cachedDaemonReady = false;

const HELP = `
DeepSeek Browser Bridge

Commands:
  npm run setup                       Open browser / check login
  npm run doctor                      Check connection
  npm run ask -- "your prompt"        Send a prompt
  npm run ask -- --new "your prompt"  Send in a new chat
  npm run ask -- --chat <id> "..."    Send to a specific chat
  npm run ask -- --<id> "..."        Short form for a specific chat
  npm run history                     Show chats
  npm run new                         Open a new empty chat
  npm run stop                        Stop the background browser bridge

Options for ask:
  --new                               Use a new chat
  --chat <id-or-url>                  Use a specific chat
  --<uuid>                             Short form for a specific chat
  --file <path>                       Add a local file to the prompt
  --timeout <seconds>                 Response timeout (default: 120)

Examples:
  npm run ask -- "Explain recursion."
  npm run ask -- --new "Start a new conversation."
  npm run history
  npm run ask -- --chat <ID> "Continue."
  npm run ask -- --<ID> "Continue."
`;

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  const options = { newChat: false, chat: null, files: [], timeoutMs: 120_000, promptParts: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--new') options.newChat = true;
    else if (arg === '--chat') {
      const chat = args[++i];
      if (!chat) throw new Error('--chat requires a UUID or full DeepSeek conversation URL');
      options.chat = chat;
    } else if (arg.startsWith('--chat=')) {
      const chat = arg.slice('--chat='.length);
      if (!chat) throw new Error('--chat requires a UUID or full DeepSeek conversation URL');
      options.chat = chat;
    } else if (/^--[0-9a-f-]{20,}$/i.test(arg)) {
      // Convenient shorthand: --<conversation-id>
      // Example: npm run ask -- --6530476f-6b16-4298-98cf-5527dbf10e76 "Continue"
      if (options.chat) throw new Error('A chat was already selected.');
      options.chat = arg.slice(2);
    } else if (/^[0-9a-f-]{20,}$/i.test(arg) && i + 1 < args.length) {
      // Also accept a bare UUID as a convenience when followed by a prompt.
      if (options.chat) throw new Error('A chat was already selected.');
      options.chat = arg;
    } else if (arg === '--file') {
      const file = args[++i];
      if (!file) throw new Error('--file requires a path');
      options.files.push(file);
    } else if (arg === '--timeout') {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be a positive number');
      options.timeoutMs = seconds * 1000;
    } else if (arg === '--help' || arg === '-h') options.showHelp = true;
    else options.promptParts.push(arg);
  }

  if (options.newChat && options.chat) throw new Error('Use either --new or --chat, not both.');
  return { command, options };
}

async function readPrompt(options) {
  const inline = options.promptParts.join(' ').trim();
  const sections = [];
  if (inline) sections.push(inline);
  for (const file of options.files) {
    const absolute = path.resolve(PROJECT_ROOT, file);
    const content = await fs.readFile(absolute, 'utf8');
    sections.push(`\n--- FILE: ${file} ---\n${content}\n--- END FILE ---`);
  }
  const prompt = sections.join('\n');
  if (!prompt.trim()) throw new Error('PROMPT_EMPTY: Add a prompt, or use --file with a prompt.');
  return prompt;
}

function request(method, pathname, body = null, timeoutMs = 130_000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: HOST,
      port: PORT,
      path: pathname,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : undefined,
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(parsed?.error || `DAEMON_HTTP_${res.statusCode}: ${data.slice(0, 400)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('DAEMON_TIMEOUT: Background bridge did not respond in time.')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function health() {
  try {
    return await request('GET', '/health', null, 1000);
  } catch {
    return null;
  }
}

async function killProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

async function ensureDaemon() {
  if (cachedDaemonReady) {
    const cached = await health();
    if (cached?.ok && cached.version === BRIDGE_VERSION) return;
    cachedDaemonReady = false;
  }

  let existing = await health();
  if (existing?.ok && existing.version !== BRIDGE_VERSION) {
    // A daemon from an older project version is occupying our fixed local
    // port. Stop it first; otherwise the new CLI silently talks to old code.
    try { await request('POST', '/stop', null, 3000); } catch {}
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      existing = await health();
      if (!existing?.ok) break;
      await new Promise(r => setTimeout(r, 150));
    }

    // On Windows an old Playwright process can occasionally fail to shut down
    // promptly. The health response gives us the exact PID of our bridge, so
    // terminate only that process rather than touching arbitrary processes.
    existing = await health();
    if (existing?.ok && existing.pid) await killProcess(existing.pid);
    await new Promise(r => setTimeout(r, 250));
  }

  existing = await health();
  if (existing?.ok && existing.version === BRIDGE_VERSION) {
    cachedDaemonReady = true;
    return;
  }
  if (existing?.ok) {
    throw new Error(`DAEMON_VERSION_CONFLICT: Another bridge is still using ${HOST}:${PORT}. Run \"npm run stop\" and try again.`);
  }

  await fs.mkdir(DEBUG_DIR, { recursive: true });
  const out = await fs.open(path.join(DEBUG_DIR, 'daemon.log'), 'a');
  const err = await fs.open(path.join(DEBUG_DIR, 'daemon.err.log'), 'a');
  const child = spawn(process.execPath, [DAEMON_PATH], {
    cwd: PROJECT_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out.fd, err.fd],
    env: { ...process.env, DS_BRIDGE_VERSION: BRIDGE_VERSION }
  });
  child.unref();
  await out.close();
  await err.close();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await health();
    if (ready?.ok && ready.version === BRIDGE_VERSION) {
      cachedDaemonReady = true;
      return;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`DAEMON_START_FAILED: Could not start the background bridge. Check ${path.join(DEBUG_DIR, 'daemon.err.log')}`);
}

function printStatus(status) {
  console.log(`URL:             ${status.url}`);
  console.log(`Page title:      ${status.title}`);
  console.log(`Chat input:      ${status.inputVisible ? 'visible' : 'not found'}`);
  console.log(`Login form:      ${status.loginVisible ? 'visible' : 'not found'}`);
  console.log(`Assistant nodes: ${status.assistantNodes}`);
  console.log(`Conversation:    ${status.conversationId || 'not detected'}`);
  console.log(`Profile:         ${status.profileDir}`);
}

async function commandSetup() {
  await ensureDaemon();
  const result = await request('POST', '/setup');
  printStatus(result.status);
  console.log('\nBrowser bridge is running in the background.');
}

async function commandDoctor() {
  await ensureDaemon();
  const result = await request('GET', '/status');
  printStatus(result.status);
  console.log('\nOK: DeepSeek bridge is ready.');
}

async function commandAsk(options) {
  const prompt = await readPrompt(options);
  await ensureDaemon();
  const result = await request('POST', '/ask', {
    prompt,
    newChat: options.newChat,
    chat: options.chat,
    timeoutMs: options.timeoutMs
  }, options.timeoutMs + 10_000);
  process.stdout.write(`${result.answer}\n`);
}

async function commandHistory() {
  await ensureDaemon();
  const result = await request('GET', '/history');
  if (!result.chats.length) {
    console.log('No conversation links were found in the visible sidebar.');
    return;
  }
  for (const [index, chat] of result.chats.entries()) {
    console.log(`${index + 1}. ${chat.title || '(untitled)'}`);
    console.log(`   ${chat.id}`);
  }
}

async function commandNew() {
  await ensureDaemon();
  const result = await request('POST', '/new');
  console.log('New chat opened.');
  console.log(`URL: ${result.conversation.url}`);
  console.log('Use: npm run ask -- --new "your message"');
}

async function commandStop() {
  const existing = await health();
  if (!existing?.ok) {
    console.log('Bridge is not running.');
    return;
  }
  await request('POST', '/stop');
  cachedDaemonReady = false;
  console.log('Bridge stopped.');
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.showHelp || command === 'help') return console.log(HELP);

  switch (command) {
    case 'setup': return commandSetup();
    case 'doctor': return commandDoctor();
    case 'ask': return commandAsk(options);
    case 'history': return commandHistory();
    case 'new': return commandNew();
    case 'stop': return commandStop();
    default: throw new Error(`Unknown command: ${command}\n${HELP}`);
  }
}

main().catch(error => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});
