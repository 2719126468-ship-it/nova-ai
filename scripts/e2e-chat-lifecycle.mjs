#!/usr/bin/env node
/**
 * V0.1 Chat browser lifecycle regression.
 * Exercises a real browser against the NOVA API and a deterministic local
 * OpenAI-compatible SSE provider. All state lives in a disposable SQLite DB.
 *
 * Usage: node scripts/e2e-chat-lifecycle.mjs
 * Requires `npm run build` and Chromium (CHROMIUM_PATH may be specified).
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromiumPath = process.env.CHROMIUM_PATH
  || ['/data/data/com.termux/files/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((candidate) => fs.existsSync(candidate));

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, log, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url + '/api/v1/health');
      if (response.ok) return true;
    } catch { /* wait for the child process */ }
    await delay(250);
  }
  throw new Error('NOVA API did not start: ' + log.join('').slice(-1200));
}

async function clickByText(page, selector, text) {
  const handle = await page.evaluateHandle((sel, value) => (
    [...document.querySelectorAll(sel)].find((node) => (node.textContent || '').includes(value)) || null
  ), selector, text);
  const element = handle.asElement();
  if (!element) return false;
  await element.click();
  return true;
}

function sseDelta(content) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2500),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  if (!chromiumPath) throw new Error('No Chromium executable found; set CHROMIUM_PATH.');
  if (!fs.existsSync(path.join(rootDir, 'client/dist/index.html'))) {
    throw new Error('client/dist is missing. Run: npm run build');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-chat-lifecycle-'));
  const dbPath = path.join(tempDir, 'chat-lifecycle.sqlite');
  const apiPort = await reservePort();
  const providerPort = await reservePort();
  const baseUrl = 'http://127.0.0.1:' + apiPort;
  const providerUrl = 'http://127.0.0.1:' + providerPort + '/v1';
  const providerAttempts = new Map();
  const providerRequests = [];
  let stopConnectionClosedResolve;
  const stopConnectionClosed = new Promise((resolve) => { stopConnectionClosedResolve = resolve; });
  let multiTurnHistorySeen = false;

  const providerServer = createServer((incoming, outgoing) => {
    if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
      outgoing.writeHead(404).end();
      return;
    }
    let rawBody = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { rawBody += chunk; });
    incoming.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        outgoing.writeHead(400).end();
        return;
      }
      const prompt = String(payload.messages?.at(-1)?.content || '');
      providerRequests.push({ path: incoming.url, prompt });
      const attempt = (providerAttempts.get(prompt) || 0) + 1;
      providerAttempts.set(prompt, attempt);
      outgoing.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (prompt.includes('E2E stop generation')) {
        multiTurnHistorySeen = Array.isArray(payload.messages)
          && payload.messages.some((message) => message.role === 'assistant'
            && String(message.content || '').includes('NOVA_STREAM_SECOND'));
        outgoing.write(sseDelta('NOVA_PARTIAL_STOP_MARKER'));
        const hold = setTimeout(() => {
          if (!outgoing.destroyed) outgoing.write(sseDelta('SHOULD_NOT_COMPLETE_AFTER_STOP'));
        }, 15000);
        outgoing.on('close', () => {
          clearTimeout(hold);
          stopConnectionClosedResolve();
        });
        return;
      }

      if (prompt.includes('E2E provider failure then retry') && attempt === 1) {
        outgoing.end('data: ' + JSON.stringify({ error: { message: 'private upstream detail' } }) + '\n\n');
        return;
      }

      const first = prompt.includes('E2E provider failure then retry')
        ? 'NOVA_RETRY_SUCCEEDED'
        : 'NOVA_STREAM_FIRST';
      const second = prompt.includes('E2E provider failure then retry') ? '' : ' NOVA_STREAM_SECOND';
      outgoing.write(sseDelta(first));
      const finish = setTimeout(() => {
        if (outgoing.destroyed) return;
        if (second) outgoing.write(sseDelta(second));
        outgoing.end('data: [DONE]\n\n');
      }, 120);
      outgoing.on('close', () => clearTimeout(finish));
    });
  });

  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(providerPort, '127.0.0.1', resolve);
  });

  const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(apiPort),
      DB_PATH: dbPath,
      SESSION_SECRET: randomBytes(48).toString('base64url'),
      PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      WEB_ORIGIN: baseUrl,
      AI_BASE_URL: providerUrl,
      AI_API_KEY: randomBytes(48).toString('base64url'),
      AI_MODEL: 'nova-e2e-model',
      AI_PROVIDERS_JSON: '',
      AI_DEFAULT_MODEL: '',
      AI_TIMEOUT_MS: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

  let browser;
  try {
    await waitForServer(baseUrl, serverLog);
    check('API starts with an isolated temporary SQLite database and mock Provider', true);

    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      defaultViewport: { width: 360, height: 780, isMobile: true, hasTouch: true },
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) return request.abort();
      return request.continue();
    });
    const consoleErrors = [];
    const httpErrors = [];
    let phase = 'setup';
    const streamRequests = [];
    // Capture browser interactions and fetch stacks when duplicate submissions occur.
    const interactionEvents = [];
    await page.exposeFunction('__novaRecordInteraction', (event) => {
      interactionEvents.push({ ...event, phase });
    });
    await page.evaluateOnNewDocument(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url;
        if (String(url || '').includes('/messages/stream')) {
          window.__novaRecordInteraction?.({ type: 'fetch', url: String(url), stack: new Error().stack });
        }
        return originalFetch(...args);
      };
      document.addEventListener('submit', (event) => {
        if (event.target?.matches?.('form.chat-composer')) {
          window.__novaRecordInteraction?.({
            type: 'submit',
            button: event.submitter?.getAttribute('aria-label') || null,
          });
        }
      }, true);
      document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('button[aria-label]');
        const label = button?.getAttribute('aria-label');
        if (label === '发送消息' || label === '停止生成') {
          window.__novaRecordInteraction?.({ type: 'click', label });
        }
      }, true);
      document.addEventListener('keydown', (event) => {
        if (event.target?.matches?.('.chat-composer textarea') && event.key === 'Enter') {
          window.__novaRecordInteraction?.({ type: 'keydown-enter', shiftKey: event.shiftKey });
        }
      }, true);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));
    page.on('request', (request) => {
      if (request.url().includes('/messages/stream')) streamRequests.push({ phase, method: request.method(), url: request.url(), body: request.postData() });
    });
    page.on('response', (response) => {
      if (response.status() >= 400) httpErrors.push({ phase, status: response.status(), url: response.url() });
    });

    const email = 'chat-lifecycle-' + Date.now() + '@example.com';
    await page.goto(baseUrl + '/register', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('form.form-stack input', { timeout: 20000 });
    const inputs = await page.$$('form.form-stack input');
    if (inputs.length < 3) throw new Error('Registration form is missing required inputs.');
    await inputs[0].type('Chat Lifecycle Tester');
    await inputs[1].type(email);
    await inputs[2].type('e2e-strong-password-1');
    if (!await clickByText(page, 'button', '创建账户')) throw new Error('Registration submit button is missing.');
    await page.waitForFunction(() => !location.pathname.startsWith('/register'), { timeout: 20000 });
    check('User can register before starting the Chat lifecycle', !page.url().includes('/register'));

    await page.goto(baseUrl + '/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-composer textarea', { timeout: 20000 });
    await page.waitForSelector('select.chat-model-select', { timeout: 15000 });
    await page.waitForFunction(() => Boolean(document.querySelector('select.chat-model-select')?.value), { timeout: 10000 });
    check('Configured mock model is selectable at the 360px mobile viewport', true,
      await page.$eval('select.chat-model-select', (node) => node.value));

    async function sendPrompt(prompt) {
      await page.waitForSelector('.chat-composer textarea:not([disabled])', { timeout: 15000 });
      await page.click('.chat-composer textarea');
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.type('.chat-composer textarea', prompt);
      const sendButton = await page.$('button[aria-label="发送消息"]');
      if (!sendButton || !await sendButton.evaluate((button) => !button.disabled)) {
        throw new Error('Send button is disabled after typing; draft=' + await page.$eval('.chat-composer textarea', (node) => node.value));
      }
      await sendButton.click();
    }

    async function waitForAssistantText(text, status = null) {
      try {
        await page.waitForFunction((needle, expectedStatus) => (
          [...document.querySelectorAll('.chat-message-assistant')].some((row) => {
            const body = row.querySelector('.markdown-body')?.innerText || '';
            const statusVisible = expectedStatus
              ? Boolean(row.querySelector('.message-status-' + expectedStatus))
              : true;
            return body.includes(needle) && statusVisible;
          })
        ), { timeout: 20000 }, text, status);
      } catch (error) {
        const state = await page.evaluate(() => ({
          text: document.body.innerText.slice(-1800),
          messages: [...document.querySelectorAll('.chat-message')].map((row) => ({
            role: row.classList.contains('chat-message-assistant') ? 'assistant' : 'user',
            status: row.querySelector('.message-status')?.className || null,
            content: row.querySelector('.markdown-body')?.innerText || '',
          })),
        }));
        console.log('DEBUG expected assistant text:', text, 'status:', status);
        console.log('DEBUG browser state:', JSON.stringify(state));
        console.log('DEBUG mock Provider requests:', JSON.stringify(providerRequests));
        console.log('DEBUG API log:', serverLog.join('').slice(-4000));
        console.log('DEBUG browser errors:', JSON.stringify(consoleErrors));
        throw error;
      }
    }

    phase = 'success-stream';
    await sendPrompt('E2E successful stream and persistence');
    await waitForAssistantText('NOVA_STREAM_FIRST', 'streaming');
    check('Chat renders the first SSE delta while the assistant is still streaming', true);
    await waitForAssistantText('NOVA_STREAM_SECOND');
    await page.waitForFunction(() => !document.querySelector('.message-status-streaming'));
    check('Chat completes and renders the full streamed assistant response', true);

    const successVisible = await page.evaluate(() => (
      [...document.querySelectorAll('.chat-message-user .markdown-body')]
        .some((node) => node.innerText.includes('E2E successful stream and persistence'))
      && [...document.querySelectorAll('.chat-message-assistant .markdown-body')]
        .some((node) => node.innerText.includes('NOVA_STREAM_SECOND'))
    ));
    check('Completed user and assistant messages remain visible before the next turn', successVisible);

    phase = 'stop-stream';
    await sendPrompt('E2E stop generation');
    await waitForAssistantText('NOVA_PARTIAL_STOP_MARKER', 'streaming');
    check('Stop scenario receives and displays partial output before cancellation', true);
    await page.click('button[aria-label="停止生成"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-message-assistant')]
      .some((row) => row.querySelector('.message-status-cancelled')
        && (row.querySelector('.markdown-body')?.innerText || '').includes('NOVA_PARTIAL_STOP_MARKER')),
    { timeout: 15000 });
    await Promise.race([
      stopConnectionClosed,
      delay(5000).then(() => { throw new Error('Mock Provider did not observe upstream cancellation.'); }),
    ]);
    check('Stop propagates cancellation to the upstream Provider and preserves partial text', true);
    check('Second turn includes the previous completed assistant answer in its context', multiTurnHistorySeen);

    check('Cancelled partial assistant response remains visible in the active conversation', true);

    phase = 'provider-failure';
    await sendPrompt('E2E provider failure then retry');
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-message-assistant')]
      .some((row) => row.querySelector('.message-status-failed')),
    { timeout: 15000 });
    const safeFailure = await page.evaluate(() => (
      !document.body.innerText.includes('private upstream detail')
      && document.body.innerText.includes('模型服务在生成过程中返回错误')
    ));
    check('Provider stream failure is shown with a safe message, not upstream internals', safeFailure);

    phase = 'retry';
    const retryClicked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.chat-message-assistant')];
      const button = rows.at(-1)?.querySelector('button[aria-label="重试回答"]');
      if (!button) return false;
      button.click();
      return true;
    });
    check('Failed assistant response exposes a retry action', retryClicked);
    await waitForAssistantText('NOVA_RETRY_SUCCEEDED');
    await page.waitForFunction(() => !document.querySelector('.message-status-streaming'));
    check('Retry replaces the failed response with a completed answer', true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const assistants = [...document.querySelectorAll('.chat-message-assistant')];
      const hasSuccess = assistants.some((row) => (row.querySelector('.markdown-body')?.innerText || '').includes('NOVA_STREAM_SECOND'));
      const hasCancelled = assistants.some((row) => row.querySelector('.message-status-cancelled')
        && (row.querySelector('.markdown-body')?.innerText || '').includes('NOVA_PARTIAL_STOP_MARKER'));
      const hasRetry = assistants.some((row) => (row.querySelector('.markdown-body')?.innerText || '').includes('NOVA_RETRY_SUCCEEDED'));
      return hasSuccess && hasCancelled && hasRetry;
    }, { timeout: 20000 });
    const finalPersisted = await page.evaluate(() => (
      [...document.querySelectorAll('.chat-message-user .markdown-body')]
        .some((node) => node.innerText.includes('E2E successful stream and persistence'))
      && [...document.querySelectorAll('.chat-message-assistant .markdown-body')]
        .some((node) => node.innerText.includes('NOVA_STREAM_SECOND'))
      && [...document.querySelectorAll('.chat-message-assistant')].some((row) => row.querySelector('.message-status-cancelled')
        && (row.querySelector('.markdown-body')?.innerText || '').includes('NOVA_PARTIAL_STOP_MARKER'))
      && [...document.querySelectorAll('.chat-message-assistant .markdown-body')]
        .some((node) => node.innerText.includes('NOVA_RETRY_SUCCEEDED'))
      && !document.body.innerText.includes('private upstream detail')
    ));
    check('Completed, cancelled and retried messages all survive reload without leaking Provider details', finalPersisted);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('360px Chat streaming workflow has no root horizontal overflow', overflow <= 2, 'overflow=' + overflow + 'px');
    const relevantErrors = consoleErrors.filter((message) => !/favicon|fonts\.(googleapis|gstatic)|ERR_FAILED|401 \(Unauthorized\)/.test(message));
    const unexpectedHttpErrors = httpErrors.filter((item) => !(item.status === 401 && item.url.endsWith('/api/auth/me')));
    check('No uncaught browser errors during the Chat lifecycle', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));
    check('No unexpected HTTP error responses during the Chat lifecycle', unexpectedHttpErrors.length === 0, JSON.stringify({ unexpectedHttpErrors, streamRequests, providerRequests }));
    const stopClickIndex = interactionEvents.findIndex((event) => (
      event.phase === 'stop-stream' && event.type === 'click' && event.label === '停止生成'
    ));
    const stopTriggeredSubmits = interactionEvents.filter((event, index) => (
      index > stopClickIndex && event.phase === 'stop-stream' && event.type === 'submit'
    ));
    check('Stopping generation does not submit the composer again', stopTriggeredSubmits.length === 0,
      JSON.stringify(stopTriggeredSubmits));
    const duplicateStreamRequests = streamRequests.filter((request, index, all) => (
      all.findIndex((item) => item.url === request.url && item.body === request.body) !== index
    ));
    check('Each Chat prompt starts at most one stream request', duplicateStreamRequests.length === 0, JSON.stringify({
      duplicateStreamRequests,
      stopPhaseInteractions: interactionEvents.filter((event) => event.phase === 'stop-stream'),
      stopPhaseRequests: streamRequests.filter((request) => request.phase === 'stop-stream'),
    }));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopChild(server);
    providerServer.closeAllConnections?.();
    await new Promise((resolve) => providerServer.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const failed = results.filter((item) => !item.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' Chat lifecycle browser checks passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Chat lifecycle E2E failed:', error.stack || error.message);
  process.exitCode = 1;
});