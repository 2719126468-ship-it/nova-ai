#!/usr/bin/env node
/**
 * Mobile Chat history drawer regression test.
 * Boots an isolated NOVA API + temporary SQLite database and verifies that
 * conversation history remains reachable on narrow screens.
 *
 * Usage: node scripts/e2e-mobile-chat-history.mjs
 * Requires a built client and Chromium (CHROMIUM_PATH may be specified).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
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

async function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url, serverLog, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url + '/api/v1/health');
      if (response.ok) return true;
    } catch { /* wait for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('NOVA API did not start: ' + serverLog.join('').slice(-1000));
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

async function waitForDrawer(page, open) {
  await page.waitForFunction((shouldOpen) => {
    const sidebar = document.querySelector('.chat-sidebar');
    if (!sidebar) return false;
    const rect = sidebar.getBoundingClientRect();
    return shouldOpen ? rect.left >= -1 && rect.left < 2 : rect.right <= 1;
  }, { timeout: 10000 }, open);
}

async function main() {
  if (!chromiumPath) throw new Error('No Chromium executable found; set CHROMIUM_PATH.');
  if (!fs.existsSync(path.join(rootDir, 'client/dist/index.html'))) {
    throw new Error('client/dist is missing. Run: npm run build');
  }

  const port = await reservePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mobile-chat-e2e-'));
  const dbPath = path.join(tempDir, 'mobile-chat.sqlite');
  const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DB_PATH: dbPath,
      SESSION_SECRET: randomBytes(48).toString('base64url'),
      PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      WEB_ORIGIN: baseUrl,
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      AI_PROVIDERS_JSON: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

  let browser;
  try {
    await waitForServer(baseUrl, serverLog);
    check('Isolated NOVA API starts with a temporary SQLite database', true);

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
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));

    const email = 'mobile-history-' + Date.now() + '@example.com';
    await page.goto(baseUrl + '/register', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('form.form-stack', { timeout: 20000 });
    const inputs = await page.$$('form.form-stack input');
    if (inputs.length < 3) throw new Error('Registration form inputs are missing.');
    await inputs[0].type('Mobile History Tester');
    await inputs[1].type(email);
    await inputs[2].type('e2e-strong-password-1');
    if (!await clickByText(page, 'button', '创建账户')) throw new Error('Registration submit button is missing.');
    await page.waitForFunction(() => !location.pathname.startsWith('/register'), { timeout: 20000 });
    check('User can register and enter Chat at a phone viewport', page.url().includes('/chat') || !page.url().includes('/register'), page.url());

    await page.goto(baseUrl + '/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-top-action', { timeout: 20000 });
    await page.waitForSelector('button[aria-label="展开侧边栏"]', { timeout: 15000 });
    await waitForDrawer(page, false);
    check('360px Chat starts with the history drawer closed and an open control available', true);

    await page.click('.chat-top-action');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.history-item')].some((node) => (node.textContent || '').includes('新对话')),
      { timeout: 15000 },
    );
    check('A new conversation appears in the history list', true);

    await page.click('button[aria-label="展开侧边栏"]');
    await waitForDrawer(page, true);
    const opened = await page.evaluate(() => ({
      left: document.querySelector('.chat-sidebar')?.getBoundingClientRect().left ?? null,
      backdrop: getComputedStyle(document.querySelector('.chat-sidebar-backdrop')).display !== 'none',
      title: [...document.querySelectorAll('.history-item')].some((node) => (node.textContent || '').includes('新对话')),
    }));
    check('360px history drawer opens above Chat with the conversation visible', opened.left !== null && opened.left >= -1 && opened.backdrop && opened.title);

    await page.click('.history-item');
    await page.waitForSelector('button[aria-label="展开侧边栏"]', { timeout: 10000 });
    await waitForDrawer(page, false);
    check('Selecting a history item returns to Chat and closes the mobile drawer', true);

    await page.click('button[aria-label="展开侧边栏"]');
    await waitForDrawer(page, true);
    await page.click('button[aria-label="收起侧边栏"]');
    await page.waitForSelector('button[aria-label="展开侧边栏"]', { timeout: 10000 });
    await waitForDrawer(page, false);
    check('The drawer header close control closes history', true);

    await page.click('button[aria-label="展开侧边栏"]');
    await waitForDrawer(page, true);
    const backdropPoint = await page.$eval('.chat-sidebar-backdrop', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 8, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(backdropPoint.x, backdropPoint.y);
    await page.waitForSelector('button[aria-label="展开侧边栏"]', { timeout: 10000 });
    await waitForDrawer(page, false);
    check('Tapping outside the drawer closes history', true);

    const overflow360 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('360px Chat has no root horizontal overflow with the drawer closed', overflow360 <= 2, 'overflow=' + overflow360 + 'px');

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.waitForSelector('button[aria-label="展开侧边栏"]', { timeout: 10000 });
    await page.click('button[aria-label="展开侧边栏"]');
    await waitForDrawer(page, true);
    const history390 = await page.$eval('.history-item', (element) => (element.textContent || '').includes('新对话'));
    const overflow390 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('390px Chat can open history without horizontal overflow', history390 && overflow390 <= 2, 'overflow=' + overflow390 + 'px');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[aria-label="展开侧边栏"]', { timeout: 15000 });
    await page.waitForSelector('.history-item', { timeout: 15000 });
    await page.click('button[aria-label="展开侧边栏"]');
    await waitForDrawer(page, true);
    const restoredHistory = await page.$eval('.history-item', (element) => (element.textContent || '').includes('新对话'));
    check('Conversation history remains available after a page reload', restoredHistory);

    await page.setViewport({ width: 1280, height: 900, isMobile: false, hasTouch: false });
    await page.waitForFunction(() => {
      const sidebar = document.querySelector('.chat-sidebar');
      const rect = sidebar?.getBoundingClientRect();
      return Boolean(rect && rect.left >= -1 && rect.width >= 250 && getComputedStyle(sidebar).display !== 'none');
    }, { timeout: 10000 });
    const desktopBackdropHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.chat-sidebar-backdrop')).display === 'none');
    check('Desktop keeps the persistent history sidebar and hides the mobile backdrop', desktopBackdropHidden);

    await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true });
    await page.waitForSelector('button[aria-label="展开侧边栏"]', { timeout: 10000 });
    await waitForDrawer(page, false);
    check('Resizing back to a phone closes the drawer without losing history', true);

    const relevantErrors = consoleErrors.filter((message) => !/favicon|fonts\.(googleapis|gstatic)|ERR_FAILED|401 \(Unauthorized\)/.test(message));
    check('No uncaught browser errors during mobile history navigation', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      if (server.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 1000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const failed = results.filter((item) => !item.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' mobile Chat history checks passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Mobile Chat E2E failed:', error.stack || error.message);
  process.exitCode = 1;
});
