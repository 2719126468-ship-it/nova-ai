#!/usr/bin/env node
/**
 * NOVA browser smoke test (TD-19 / B4-01).
 *
 * Boots the real API process with the production client build, then drives it
 * with the system Chromium through puppeteer-core at a desktop and a mobile
 * viewport. Covers: registration, session persistence, project creation,
 * document autosave + reload, chat unconfigured-model guidance, admin
 * monitoring/audit panels, and a 360 px mobile layout pass.
 *
 * Usage: node scripts/e2e-smoke.mjs [--headful] [--port 4123]
 * Requires a built client: npm run build
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const headful = args.includes('--headful');
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4123;
const baseUrl = 'http://127.0.0.1:' + port;

const chromiumPath = process.env.CHROMIUM_PATH
  || ['/data/data/com.termux/files/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((candidate) => fs.existsSync(candidate));

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

async function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url + '/api/v1/health');
      if (response.ok) return true;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function clickByText(page, selector, text) {
  const handle = await page.evaluateHandle((sel, value) => {
    return [...document.querySelectorAll(sel)].find((node) => (node.textContent || '').includes(value)) || null;
  }, selector, text);
  const element = handle.asElement();
  if (!element) return false;
  await element.click();
  return true;
}

async function main() {
  if (!chromiumPath) throw new Error('No Chromium executable found; set CHROMIUM_PATH.');
  if (!fs.existsSync(path.join(rootDir, 'client/dist/index.html'))) {
    throw new Error('client/dist is missing. Run: npm run build');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-'));
  const dbPath = path.join(tempDir, 'e2e.sqlite');
  const server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DB_PATH: dbPath,
      SESSION_SECRET: 'e2e-session-secret-with-more-than-32-characters',
      PROVIDER_ENCRYPTION_KEY: 'e2e-provider-encryption-key-32-plus-chars',
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
    const ready = await waitForServer(baseUrl);
    check('API server boots and reports health', ready, ready ? baseUrl : serverLog.join('').slice(-400));
    if (!ready) throw new Error('server did not start');

    const indexResponse = await fetch(baseUrl + '/documents');
    const indexHtml = await indexResponse.text();
    check('SPA deep link is served by the API process', indexResponse.status === 200 && indexHtml.includes('id="root"'));
    check('Document CSP header is present', /default-src 'self'/.test(indexResponse.headers.get('content-security-policy') || ''));

    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: headful ? false : 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);
    // Offline environments cannot reach Google Fonts; fail fast instead of hanging.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (/fonts\.(googleapis|gstatic)\.com/.test(req.url())) return req.abort();
      return req.continue();
    });
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));

    const email = 'e2e-' + Date.now() + '@example.com';
    const password = 'e2e-strong-password-1';

    await page.goto(baseUrl + '/register', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('form.form-stack', { timeout: 20000 });
    const inputs = await page.$$('form.form-stack input');
    await inputs[0].type('E2E Tester');
    await inputs[1].type(email);
    await inputs[2].type(password);
    await clickByText(page, 'button', '创建账户');
    await page.waitForFunction(() => !location.pathname.startsWith('/register'), { timeout: 20000 });
    check('Registration signs the user in and navigates away from /register', !page.url().includes('/register'), page.url());

    await page.goto(baseUrl + '/chat', { waitUntil: 'domcontentloaded' });
    const chatUnconfigured = await page.waitForFunction(
      () => document.body.innerText.includes('当前尚未配置可用 AI 模型'),
      { timeout: 20000 },
    ).then(() => true).catch(() => false);
    const chatBody = chatUnconfigured ? '' : await page.evaluate(() => document.body.innerText.slice(0, 400));
    check('Chat shows explicit unconfigured-model guidance instead of faking answers', chatUnconfigured, chatBody);

    await page.goto(baseUrl + '/studio', { waitUntil: 'domcontentloaded' });
    const studioReady = await page.waitForSelector('.create-project-form input', { timeout: 20000 }).then(() => true).catch(() => false);
    if (!studioReady) {
      const debug = await page.evaluate(() => ({ path: location.pathname, text: document.body.innerText.slice(0, 300) }));
      check('Studio create form is available', false, JSON.stringify(debug));
    } else {
      const projectInputs = await page.$$('.create-project-form input');
      await projectInputs[0].type('E2E 项目 ' + Date.now());
      if (projectInputs[1]) await projectInputs[1].type('端到端验证');
      await clickByText(page, '.create-project-form button', '创建项目');
      // A successful create either lands in the project editor or refreshes the card grid.
      const created = await page.waitForFunction(
        () => location.pathname.startsWith('/studio/') || document.querySelectorAll('.studio-project-card').length > 0,
        { timeout: 20000 },
      ).then(() => true).catch(() => false);
      check('Studio creates a project and opens it', created, await page.evaluate(() => location.pathname));
    }

    await page.goto(baseUrl + '/documents', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.documents-toolbar-actions button', { timeout: 20000 });
    const clickedNewDoc = await clickByText(page, '.documents-toolbar-actions button', '新建文档');
    const createdDoc = await page.waitForFunction(() => location.pathname.startsWith('/documents/'), { timeout: 20000 })
      .then(() => true).catch(() => false);
    if (!createdDoc) {
      console.log('DEBUG documents create:', clickedNewDoc, JSON.stringify(await page.evaluate(() => ({
        path: location.pathname,
        body: document.body.innerText.slice(0, 300),
      }))), consoleErrors.slice(-3).join(' | '));
    }
    check('Documents creates a new document', createdDoc);
    if (!createdDoc) throw new Error('document creation failed');
    await page.waitForSelector('.document-title-input');
    const stamp = 'E2E-AUTOSAVE-' + Date.now();
    await page.click('.document-title-input', { clickCount: 3 });
    await page.type('.document-title-input', 'E2E 文档 ' + stamp);
    const editor = await page.$('textarea[aria-label="Markdown 文档内容"]');
    await editor.click();
    await page.keyboard.type('# 标题\n\n自动保存验证正文 ' + stamp);
    await page.waitForFunction(
      () => document.body.innerText.includes('所有更改已保存'),
      { timeout: 25000 },
    );
    check('Document autosave reaches the saved state', true);

    const documentUrl = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('textarea[aria-label="Markdown 文档内容"]');
    const persisted = await page.$eval('textarea[aria-label="Markdown 文档内容"]', (node) => node.value);
    check('Saved document content survives a reload', persisted.includes(stamp), persisted.slice(0, 60));

    await page.goto(baseUrl + '/account', { waitUntil: 'domcontentloaded' });
    check('Session cookie keeps the account page authenticated', await page.evaluate(() => !document.body.innerText.includes('请先登录')));

    await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true });
    await page.goto(documentUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.document-title-input');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('Mobile 360px document editor has no horizontal overflow', overflow <= 2, 'overflow=' + overflow + 'px');

    await page.goto(baseUrl + '/documents', { waitUntil: 'domcontentloaded' });
    const mobileNavToggle = await page.$('.mobile-nav-toggle');
    check('Mobile navigation toggle is present at 360px', Boolean(mobileNavToggle));
    if (mobileNavToggle) {
      const navVisible = await page.evaluate(() => {
        const toggle = document.querySelector('.mobile-nav-toggle');
        if (!toggle) return false;
        toggle.click();
        return true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const drawerOpen = await page.evaluate(() => Boolean(document.querySelector('.main-nav-open')));
      check('Mobile navigation drawer opens', navVisible && drawerOpen);
    }

    // Promote the account to admin directly in SQLite, then verify the new panels.
    const Database = (await import('better-sqlite3')).default;
    const handle = new Database(dbPath);
    handle.prepare("UPDATE users SET role='admin' WHERE email=?").run(email);
    handle.close();

    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(baseUrl + '/admin?tab=monitoring', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('错误监控'), { timeout: 20000 });
    check('Admin monitoring panel renders', true);

    await page.goto(baseUrl + '/admin?tab=audit', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('管理员审计日志'), { timeout: 20000 });
    check('Admin audit panel renders', true);

    await page.goto(baseUrl + '/admin?tab=providers', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('模型与 Provider'), { timeout: 20000 });
    check('Admin provider management renders', true);

    // The pre-login /auth/me probe legitimately returns 401 and offline font loads
    // fail; neither is an application defect.
    const relevantErrors = consoleErrors.filter((text) => !/favicon|fonts\.(googleapis|gstatic)|ERR_FAILED|401 \(Unauthorized\)|403 \(Forbidden\)/.test(text));
    check('No uncaught page errors during the flow', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!server.killed) server.kill('SIGKILL');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const failed = results.filter((item) => !item.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' browser checks passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('E2E failed:', error.stack || error.message);
  process.exitCode = 1;
});