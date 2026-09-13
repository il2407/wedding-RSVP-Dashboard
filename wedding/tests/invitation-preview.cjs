// Run: node wedding/tests/invitation-preview.cjs
// Requires Playwright; PLAYWRIGHT_MODULE can point to an existing installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_DESIGN } = require('../server/rsvpDesign');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, pathname, pathname.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const config = { couple_name_1: 'איה', couple_name_2: 'עידו', theme_color: '#45634f', rsvp_design: DEFAULT_DESIGN };
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/api/**', async route => {
      const url = route.request().url();
      if (url.includes('/public/')) await new Promise(resolve => setTimeout(resolve, 200));
      await route.fulfill({ json: url.includes('/config') ? config : url.includes('/auth/me') ? { id: 1 } : [] });
    });
    await context.route('**/media/**', route => route.fulfill({ status: 404 }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const admin = await context.newPage();
    await admin.goto(`${origin}/admin/`);
    await admin.waitForFunction(() => document.getElementById('design-title').value.length > 0);
    const popupPromise = context.waitForEvent('page');
    await admin.locator('#preview-rsvp-link').click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    const iframe = admin.frameLocator('#invitation-preview');
    for (const [field, target, text] of [
      ['title', 'landing-title', 'הכותרת החדשה שלנו'],
      ['message', 'invitation-message', 'פסקה חדשה\nעם שורה שנייה'],
      ['signoff', 'landing-signoff', 'באהבה, איה ועידו'],
    ]) {
      await admin.locator(`#design-${field}`).fill(text);
      for (const surface of [iframe, popup]) {
        await surface.locator(`#${target}`).evaluate((el, expected) => new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const check = () => el.textContent === expected ? resolve() : Date.now() > deadline ? reject(Error('Text preview did not update')) : setTimeout(check, 20);
          check();
        }), text);
      }
    }
    for (const [field, color, selector, property, expected] of [
      ['design-background', '#123456', 'body', 'backgroundColor', 'rgb(18, 52, 86)'],
      ['design-text_color', '#fedcba', '#landing-title', 'color', 'rgb(254, 220, 186)'],
      ['theme_color', '#804020', '#submit-btn', 'backgroundColor', 'rgb(109, 54, 27)'],
    ]) {
      await admin.locator(`#${field}`).evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }, color);
      for (const surface of [iframe, popup]) {
        await surface.locator(selector).evaluate((el, { property, expected }) => new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const check = () => getComputedStyle(el)[property] === expected ? resolve() : Date.now() > deadline ? reject(Error(`${property}: ${getComputedStyle(el)[property]} !== ${expected}`)) : setTimeout(check, 20);
          check();
        }), { property, expected });
      }
    }
    // A newly opened/reloaded preview must receive unsaved edits, even with a slow saved-config request.
    await popup.reload();
    await popup.waitForTimeout(400);
    assert.equal(await popup.locator('#landing-signoff').textContent(), 'באהבה, איה ועידו');
    assert.equal(await popup.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(18, 52, 86)');
    // Guest pages must not subscribe to the admin's draft updates.
    const guest = await context.newPage();
    await guest.goto(`${origin}/rsvp-form/?u=1&phone=0501234567`);
    await guest.waitForTimeout(300);
    await admin.locator('#design-title').fill('טיוטה פרטית');
    await guest.waitForTimeout(100);
    assert.equal(await guest.locator('#landing-title').textContent(), DEFAULT_DESIGN.title);
    assert.deepEqual(errors, []);
    console.log('PASS: title, paragraph, signature, background, text and theme colors in iframe and separate tab; reload synchronization; guest draft isolation.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
