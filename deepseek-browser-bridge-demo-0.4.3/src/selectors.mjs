/**
 * DeepSeek web UI selectors.
 * Keep UI-specific details here so interface changes are isolated.
 */
export const SELECTORS = {
  input: [
    'textarea[placeholder*="Message DeepSeek"]',
    'textarea[placeholder*="DeepSeek"]',
    'textarea[placeholder*="Ask"]',
    '#chat-input',
    '[contenteditable="true"]',
    'textarea'
  ],
  inputRoleNames: [
    '给 DeepSeek 发送消息',
    /send message to deepseek/i,
    /message deepseek/i,
    /ask deepseek/i
  ],
  send: [
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[data-testid*="send"]',
    '[role="button"][aria-label*="Send"]',
    '[role="button"][aria-label*="发送"]'
  ],
  assistantReply: 'dslc-reply-wrapper',
  assistantMarkdown: 'dslc-markdown',
  assistantLegacy: [
    'div.ds-markdown',
    '[data-testid*="message-content"]',
    '[class*="message-content"]'
  ],
  stop: [
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]',
    '[role="button"][aria-label*="Stop"]',
    '[role="button"][aria-label*="停止"]',
    'button[data-testid*="stop"]'
  ],
  login: [
    '.ds-sign-in-form__main',
    '.ds-sign-in-form-wrapper',
    '.ds-auth-form-wrapper',
    'input[type="password"]'
  ],
  conversationLinks: [
    'a[href*="/a/chat/s/"]',
    '[data-href*="/a/chat/s/"]'
  ],
  loginPath: '/sign_in'
};

export async function findVisible(page, candidates) {
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 700 })) return locator;
    } catch {}
  }
  return null;
}

export async function findChatInput(page) {
  for (const name of SELECTORS.inputRoleNames) {
    try {
      const locator = page.getByRole('textbox', { name }).first();
      if (await locator.isVisible({ timeout: 500 })) return locator;
    } catch {}
  }
  return findVisible(page, SELECTORS.input);
}

export async function countAssistantReplies(page) {
  try {
    const count = await page.locator(SELECTORS.assistantReply).count();
    if (count > 0) return { selector: SELECTORS.assistantReply, count };
  } catch {}
  return countMatching(page, SELECTORS.assistantLegacy);
}

/**
 * Extract the last assistant reply and remove citation/source UI noise.
 * DeepSeek's web UI may render citations as tiny numeric elements; those
 * should not leak into a plain-text CLI response.
 */
export async function lastAssistantText(page) {
  try {
    const replies = page.locator(SELECTORS.assistantReply);
    const count = await replies.count();
    for (let i = count - 1; i >= 0; i--) {
      const markdown = replies.nth(i).locator(SELECTORS.assistantMarkdown).last();
      if (await markdown.count()) {
        const text = await extractCleanText(markdown);
        if (text) return text;
      }
    }
  } catch {}
  return lastMatchingText(page, SELECTORS.assistantLegacy);
}

export async function extractCleanText(locator) {
  try {
    return await locator.evaluate((node) => {
      const clone = node.cloneNode(true);

      // Remove obvious citation/source widgets before calling innerText.
      for (const el of clone.querySelectorAll('sup, button, a, [role="button"]')) {
        const text = (el.textContent || '').trim();
        const meta = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`;
        const numericOnly = /^\[?\(?\d{1,3}\)?\]?$/.test(text);
        const citationLike = /citation|source|reference|引用|来源/i.test(meta);
        if (numericOnly || citationLike) el.remove();
      }

      let text = (clone.innerText || clone.textContent || '').trim();

      // Fallback cleanup for citation markers flattened by innerText.
      text = text
        .replace(/\u200b/g, '')
        .replace(/-\s*\n\s*\d{1,3}\s*\n\s*-/g, '')
        .replace(/-\s*\n\s*\d{1,3}(?=\s*(?:[.!?,;:]|$))/g, '')
        .replace(/^\s*\d{1,3}\s*$/gm, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return text;
    });
  } catch {
    return '';
  }
}

export async function countMatching(page, candidates) {
  for (const selector of candidates) {
    try {
      const count = await page.locator(selector).count();
      if (count > 0) return { selector, count };
    } catch {}
  }
  return { selector: null, count: 0 };
}

export async function lastMatchingText(page, candidates) {
  for (const selector of candidates) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (!count) continue;
      const text = await locator.nth(count - 1).innerText({ timeout: 1200 });
      if (text?.trim()) return normalizePlainText(text);
    } catch {}
  }
  return '';
}

export function normalizePlainText(text) {
  return String(text || '')
    .replace(/\u200b/g, '')
    .replace(/-\s*\n\s*\d{1,3}\s*\n\s*-/g, '')
    .replace(/-\s*\n\s*\d{1,3}(?=\s*(?:[.!?,;:]|$))/g, '')
    .replace(/^\s*\d{1,3}\s*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
