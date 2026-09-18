import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  SELECTORS,
  findVisible,
  findChatInput,
  countAssistantReplies,
  lastAssistantText
} from './selectors.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = path.join(PROJECT_ROOT, '.browser-profile');
const DEBUG_DIR = path.join(PROJECT_ROOT, '.debug');
const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const CHAT_PATH_RE = /^\/a\/chat\/s\/([0-9a-f-]{20,})$/i;
const COMPLETION_PATH = '/api/v0/chat/completion';
const CREATE_SESSION_PATH = '/api/v0/chat_session/create';

export class DeepSeekBridge {
  constructor({ headless = false, timeoutMs = 120_000 } = {}) {
    this.headless = headless;
    this.timeoutMs = timeoutMs;
    this.context = null;
    this.page = null;
  }

  async start() {
    await fs.mkdir(PROFILE_DIR, { recursive: true });
    await fs.mkdir(DEBUG_DIR, { recursive: true });

    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: this.headless,
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
      args: ['--disable-blink-features=AutomationControlled']
    });

    this.page = await this.pickLivePage();
    this.page.setDefaultTimeout(this.timeoutMs);

    if (!this.page.url().startsWith('https://chat.deepseek.com/')) {
      await this.safeGoto(this.page, DEEPSEEK_URL);
    }

    return this.page;
  }

  async pickLivePage() {
    if (!this.context || this.context.isClosed()) {
      this.page = null;
      throw new Error('BROWSER_CONTEXT_CLOSED: Browser context is closed. Restart the bridge.');
    }

    const livePages = this.context.pages().filter(page => !page.isClosed());
    const preferred = livePages.find(page => page.url().startsWith('https://chat.deepseek.com/'));
    const page = preferred ?? livePages[0] ?? await this.context.newPage();
    page.setDefaultTimeout(this.timeoutMs);
    return page;
  }

  async ensureLivePage() {
    if (!this.context || this.context.isClosed()) {
      this.context = null;
      this.page = null;
      await this.start();
      return this.page;
    }

    if (this.page && !this.page.isClosed()) return this.page;

    this.page = await this.pickLivePage();
    return this.page;
  }

  async recoverPage() {
    if (!this.context || this.context.isClosed()) {
      this.context = null;
      this.page = null;
      await this.start();
      return this.page;
    }

    this.page = await this.pickLivePage();
    return this.page;
  }

  async safeGoto(page, url) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
      return page;
    } catch (error) {
      const closed = /Target page, context or browser has been closed/i.test(String(error?.message || error))
        || page.isClosed();
      if (!closed) throw error;

      await this.recoverPage();
      if (!this.page || this.page.isClosed()) throw new Error('PAGE_RECOVERY_FAILED: Could not recover a live browser tab.');
      await this.page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
      return this.page;
    }
  }

  async sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }

  async status() {
    await this.ensureLivePage();
    const input = await findChatInput(this.page);
    const login = await findVisible(this.page, SELECTORS.login);
    const assistant = await countAssistantReplies(this.page);

    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      inputVisible: Boolean(input),
      loginVisible: Boolean(login),
      assistantNodes: assistant.count,
      conversationId: this.getConversationId(this.page.url()),
      profileDir: PROFILE_DIR
    };
  }

  async ensureLoggedIn() {
    await this.ensureLivePage();
    const input = await findChatInput(this.page);
    if (input) return;

    const login = await findVisible(this.page, SELECTORS.login);
    if (login) {
      throw new Error(
        'LOGIN_REQUIRED: DeepSeek is not logged in. Finish login in the opened browser, then run the command again.'
      );
    }

    await this.sleep(600);
    await this.ensureLivePage();
    const inputAfterWait = await findChatInput(this.page);
    if (!inputAfterWait) {
      await this.saveDebugScreenshot('login-or-ui-not-detected');
      throw new Error(
        `UI_NOT_READY: Could not find the DeepSeek chat input. A screenshot was saved to ${DEBUG_DIR}.`
      );
    }
  }

  async openConversation(target) {
    await this.ensureLivePage();
    await this.ensureLoggedIn();

    const url = normalizeConversationUrl(target);
    const expectedId = this.getConversationId(url);
    if (!expectedId) throw new Error('CHAT_INVALID: Use a DeepSeek conversation UUID or full /a/chat/s/<id> URL.');

    if (this.getConversationId(this.page.url()) === expectedId) return this.page;

    let navigated = false;
    for (let attempt = 0; attempt < 2 && !navigated; attempt++) {
      try {
        await this.safeGoto(this.page, url);
        await this.page.waitForURL(new RegExp(`/a/chat/s/${expectedId}$`), { timeout: 20_000 }).catch(() => {});
        navigated = true;
      } catch (error) {
        if (attempt === 1) throw error;
        await this.recoverPage();
      }
    }

    await this.ensureLoggedIn();
    const actualId = this.getConversationId(this.page.url());
    if (actualId !== expectedId) {
      await this.saveDebugScreenshot('chat-navigation-mismatch');
      throw new Error(`CHAT_NAVIGATION_FAILED: Wanted ${expectedId}, but DeepSeek opened ${this.page.url()}`);
    }
    return this.page;
  }

  async listConversations(limit = 20) {
    await this.ensureLivePage();
    await this.ensureLoggedIn();

    const items = await this.page.evaluate(({ selectors, max }) => {
      const seen = new Set();
      const result = [];
      const nodes = [];
      for (const selector of selectors) nodes.push(...document.querySelectorAll(selector));

      for (const node of nodes) {
        const rawHref = node.getAttribute('href') || node.getAttribute('data-href') || '';
        const match = rawHref.match(/\/a\/chat\/s\/([0-9a-f-]{20,})/i);
        if (!match) continue;
        const id = match[1];
        if (seen.has(id)) continue;
        seen.add(id);

        const title = (node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        result.push({ id, url: `https://chat.deepseek.com/a/chat/s/${id}`, title });
        if (result.length >= max) break;
      }
      return result;
    }, { selectors: SELECTORS.conversationLinks, max: limit });

    return items;
  }

  /**
   * Prepare a genuinely new web conversation without depending on the private
   * chat_session/create response shape. DeepSeek creates the persistent
   * conversation when the first message is submitted from the root chat page.
   */
  async createConversation() {
    await this.ensureLivePage();
    await this.ensureLoggedIn();

    // The root composer is DeepSeek's canonical "new chat" state. Avoid the
    // brittle UI button and avoid depending on a private create-session JSON
    // envelope that has changed across web deployments.
    await this.safeGoto(this.page, DEEPSEEK_URL);
    await this.ensureLoggedIn();

    return {
      id: null,
      url: DEEPSEEK_URL,
      pending: true
    };
  }

  async ask(prompt, { newChat = false, chat = null } = {}) {
    if (!prompt?.trim()) throw new Error('PROMPT_EMPTY: Provide a non-empty prompt.');
    await this.ensureLivePage();
    await this.ensureLoggedIn();

    if (newChat) {
      await this.createConversation();
    } else if (chat) {
      await this.openConversation(chat);
    }

    const input = await findChatInput(this.page);
    if (!input) throw new Error('INPUT_NOT_FOUND: DeepSeek chat input is not visible.');

    // Fast path: fill the composer in one DOM operation instead of typing
    // one character at a time. This matters a lot for large code prompts.
    try {
      await input.fill(prompt);
    } catch {
      await input.click();
      await this.page.keyboard.insertText(prompt);
    }

    // PRINCIPAL CHANGE: do not wait for the rendered DOM to stabilize.
    // Listen for the web client's own completion SSE response instead.
    const completionWaiter = this.waitForCompletionResponse();

    await input.click();
    await this.page.keyboard.press('Enter');

    // Keep the same network waiter alive. If Enter did not submit, click the
    // visible send control without risking a second independent capture path.
    await this.sleep(400);
    if (!completionWaiter.observed) {
      const send = await findVisible(this.page, SELECTORS.send);
      if (send) await send.click();
    }

    const response = await completionWaiter.promise;
    if (response.status() < 200 || response.status() >= 300) {
      const preview = await response.text().catch(() => '');
      throw new Error(`DEEPSEEK_COMPLETION_FAILED: HTTP ${response.status()} ${preview.slice(0, 400)}`);
    }

    // body() completes when the browser's SSE stream completes. At that point
    // we read the final rendered answer exactly once; no stability polling.
    await Promise.race([
      response.body(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('STREAM_TIMEOUT')), this.timeoutMs))
    ]).catch((error) => {
      if (error?.message === 'STREAM_TIMEOUT') {
        throw new Error(`TIMEOUT: DeepSeek completion stream did not finish within ${this.timeoutMs} ms.`);
      }
      throw error;
    });

    // Give the renderer one microtask-sized chance to commit the final DOM.
    // Normally the first read succeeds immediately.
    for (const delay of [0, 25, 50]) {
      if (delay) await this.sleep(delay);
      await this.ensureLivePage();
      const text = await lastAssistantText(this.page);
      if (text) return text;
    }

    await this.saveDebugScreenshot('network-finished-but-no-answer');
    throw new Error(`RESPONSE_EXTRACT_FAILED: Network stream finished, but no assistant text was found. Screenshot saved to ${DEBUG_DIR}.`);
  }

  /**
   * Resolve as soon as the browser receives the DeepSeek completion response.
   * The response object itself is stream-backed; response.body() below waits
   * for completion without any DOM polling or "stable text" delay.
   */
  waitForCompletionResponse() {
    let observed = false;
    let settled = false;
    let cleanup = () => {};

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`TIMEOUT: DeepSeek did not start a completion stream within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);

      const listener = (response) => {
        try {
          const request = response.request();
          const url = new URL(response.url());
          if (request.method() !== 'POST') return;
          if (url.origin !== new URL(DEEPSEEK_URL).origin) return;
          if (url.pathname !== COMPLETION_PATH) return;
          if (settled) return;

          observed = true;
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve(response);
        } catch {
          // Ignore unrelated browser responses.
        }
      };

      cleanup = () => this.page.off('response', listener);
      this.page.on('response', listener);
    });

    return {
      promise,
      get observed() {
        return observed;
      }
    };
  }

  getConversationId(url) {
    try {
      return new URL(url).pathname.match(CHAT_PATH_RE)?.[1] || null;
    } catch {
      return null;
    }
  }

  async saveDebugScreenshot(label) {
    if (!this.page) return;
    const filename = `${Date.now()}-${label}.png`;
    await this.page.screenshot({
      path: path.join(DEBUG_DIR, filename),
      fullPage: true
    }).catch(() => {});
  }

  async saveDebugJson(label, value) {
    const filename = `${Date.now()}-${label}.json`;
    await fs.writeFile(
      path.join(DEBUG_DIR, filename),
      JSON.stringify(value, null, 2),
      'utf8'
    ).catch(() => {});
  }

  async ensureStarted() {
    await this.ensureLivePage();
  }
}

export function normalizeConversationUrl(target) {
  const value = String(target || '').trim();
  if (!value) return '';
  if (/^[0-9a-f-]{20,}$/i.test(value)) return `https://chat.deepseek.com/a/chat/s/${value}`;
  if (/^https?:\/\/chat\.deepseek\.com\/a\/chat\/s\//i.test(value)) return value;
  throw new Error('CHAT_INVALID: Use a DeepSeek conversation UUID or full URL.');
}

export { PROJECT_ROOT, PROFILE_DIR, DEBUG_DIR, DEEPSEEK_URL };
