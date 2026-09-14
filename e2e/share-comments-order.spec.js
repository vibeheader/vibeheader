const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { configBarrier, expect, test } = require('./fixtures');

// Build the companion website first, then pass its astro/dist directory.
// Every website request is fulfilled locally; no shared data leaves the test.
const siteDist = process.env.VIBEHEADER_SITE_DIST;
test.skip(!siteDist, 'Set VIBEHEADER_SITE_DIST to the built companion share site');

async function toggleComments(popup) {
  await popup.locator('#profileTrigger').click();
  await popup.getByRole('menuitemcheckbox', { name: 'Show comments' }).click();
  await popup.locator('#profileTrigger').click();
}

async function copyLink(popup) {
  // Capture the actual Copy Link output without touching the system clipboard.
  await popup.evaluate(() => {
    window.copiedShareUrl = null;
    navigator.clipboard.writeText = async value => { window.copiedShareUrl = value; };
  });
  await popup.locator('#shareBtn').click();
  await expect.poll(() => popup.evaluate(() => window.copiedShareUrl)).toBeTruthy();
  return popup.evaluate(() => window.copiedShareUrl);
}

async function serveShareWebsite(context) {
  const websiteRequests = [];
  await context.route('https://vibeheader.com/**', async route => {
    websiteRequests.push(route.request().url());
    const pathname = new URL(route.request().url()).pathname;
    const relative = pathname === '/s' || pathname === '/s/' ? 's/index.html' : pathname.slice(1);
    const file = path.resolve(siteDist, relative);
    if (!file.startsWith(`${path.resolve(siteDist)}${path.sep}`)) return route.abort();
    try {
      await fs.access(file);
      await route.fulfill({ path: file });
    } catch (_) {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  });
  return websiteRequests;
}

for (const hasExistingHeaders of [false, true]) {
  test(`a first commented import reveals Comments when ${hasExistingHeaders ? 'adding a Profile' : 'replacing the empty Profile'}`, async ({ context, openPopup }) => {
    await serveShareWebsite(context);
    let popup = await openPopup();
    await expect(popup.locator('.vh-header-comment')).toHaveCount(0);
    if (hasExistingHeaders) {
      await popup.locator('.vh-h-name').fill('X-Existing');
      await popup.locator('.vh-h-value').fill('keep');
    }
    await configBarrier(popup);
    await popup.close();

    const payload = { v: 2, n: 'Incoming servers',
      h: [['X-Server', 'staging'], ['X-Backup', 'backup']], f: [],
      c: ['测试服务器 🟢', 'Backup server'] };
    const sharePage = await context.newPage();
    await sharePage.goto(`https://vibeheader.com/s#c=${encodeURIComponent(JSON.stringify(payload))}`);
    await sharePage.getByRole('button', { name: 'Import Now', exact: true }).click();
    await expect(sharePage.locator('#status')).toContainText('active now');

    popup = await openPopup();
    await expect(popup.locator('.vh-header-comment').first()).toHaveValue(payload.c[0]);
    await expect(popup.locator('.vh-header-comment').last()).toHaveValue(payload.c[1]);
    expect(await configBarrier(popup)).toHaveLength(hasExistingHeaders ? 2 : 1);
    await popup.reload();
    await expect(popup.locator('.vh-header-comment').first()).toHaveValue(payload.c[0]);
    if (hasExistingHeaders) {
      await popup.locator('#profileTrigger').click();
      await popup.locator('.vh-profile-select').first().click();
      await expect(popup.locator('.vh-header-comment')).toHaveValue('');
    }
  });
}

test('real extension shares hidden comments and natural Header order through the website', async ({ context, openPopup }, testInfo) => {
  const websiteRequests = await serveShareWebsite(context);
  let popup = await openPopup();
  await popup.locator('.vh-h-name').fill('X-Order-Test');
  await popup.locator('.vh-h-value').fill('first');
  await popup.locator('#addHeaderBtn').click();
  await popup.locator('.vh-h-name').last().fill('x-order-test');
  await popup.locator('.vh-h-value').last().fill('winner');
  await toggleComments(popup);
  await popup.locator('.vh-header-comment').first().fill('备用服务器 <b>QA</b>');
  await popup.locator('.vh-header-comment').last().fill('生产服务器 🟢');
  await popup.locator('#profileTrigger').click();
  await popup.locator('.vh-profile-more').first().click();
  await popup.getByRole('button', { name: 'Reorder headers', exact: true }).click();
  await popup.locator('.vh-header-grip').first().press('ArrowDown');
  await popup.locator('#reorderDone').click();
  await toggleComments(popup);
  await expect(popup.locator('.vh-header-comment')).toHaveCount(0);
  await configBarrier(popup);
  const link = await copyLink(popup);
  const payload = JSON.parse(decodeURIComponent(new URL(link).hash.slice(3)));
  expect(payload).toMatchObject({
    v: 2, h: [['x-order-test', 'winner'], ['X-Order-Test', 'first']],
    c: ['生产服务器 🟢', '备用服务器 <b>QA</b>']
  });
  expect(Object.keys(payload).sort()).toEqual(['c', 'f', 'h', 'n', 'v']);
  // Pause the sender so the HTTP assertion can only be satisfied by the import.
  await popup.locator('#toggleBtn').click();
  await configBarrier(popup);

  const sharePage = await context.newPage();
  await sharePage.goto(link);
  await expect(sharePage.locator('.preview-comment')).toHaveText(payload.c);
  await expect(sharePage.locator('#headerList .preview-value')).toHaveText(['winner', 'first']);
  await expect(sharePage.locator('#headerList b')).toHaveCount(0);
  await sharePage.evaluate(() => document.fonts.ready);
  await sharePage.screenshot({ path: testInfo.outputPath('share-comments-light.png'), fullPage: true });
  await sharePage.emulateMedia({ colorScheme: 'dark' });
  await sharePage.screenshot({ path: testInfo.outputPath('share-comments-dark.png'), fullPage: true });
  await sharePage.getByRole('button', { name: 'Import Now', exact: true }).click();
  await expect(sharePage.locator('#status')).toContainText('active now');
  const profiles = await configBarrier(popup);
  expect(profiles).toHaveLength(2);
  expect(profiles[0].active).toBe(false);
  expect(profiles[1].active).toBe(true);
  await popup.close();
  popup = await openPopup();
  await expect(popup.locator('.vh-header-comment')).toHaveCount(0);
  await expect(popup.locator('.vh-h-value').first()).toHaveValue('winner');
  await toggleComments(popup);
  await expect(popup.locator('.vh-header-comment').first()).toHaveValue('生产服务器 🟢');
  await expect(popup.locator('.vh-header-comment').last()).toHaveValue('备用服务器 <b>QA</b>');
  const reshared = JSON.parse(decodeURIComponent(new URL(await copyLink(popup)).hash.slice(3)));
  expect({ ...reshared, n: payload.n }).toEqual(payload);
  expect(websiteRequests.every(url => !url.includes('#') && !url.includes('winner'))).toBe(true);

  const echoServer = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
    response.end(JSON.stringify({ url: request.url, headers: request.headers }));
  });
  try {
    await new Promise((resolve, reject) => {
      echoServer.once('error', reject);
      echoServer.listen(0, '127.0.0.1', resolve);
    });
    const requestPage = await context.newPage();
    const response = await requestPage.goto(`http://127.0.0.1:${echoServer.address().port}/echo`);
    const received = await response.json();
    expect(received.headers['x-order-test']).toBe('first');
    expect(received.url).toBe('/echo');
    expect(JSON.stringify(received)).not.toContain('服务器');
    expect(JSON.stringify(received)).not.toContain('<b>QA</b>');
  } finally {
    await new Promise(resolve => {
      echoServer.close(resolve);
      echoServer.closeAllConnections();
    });
  }
});

test('a real pre-comments extension imports the shared Header order and filters, omitting only comments', async ({ headless }) => {
  const oldDist = process.env.VIBEHEADER_PRE_COMMENTS_DIST;
  test.skip(!oldDist, 'Set VIBEHEADER_PRE_COMMENTS_DIST to a pre-comments v2 extension build');
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeheader-old-share-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless,
    args: [`--disable-extensions-except=${oldDist}`, `--load-extension=${oldDist}`]
  });
  try {
    await serveShareWebsite(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('#addHeaderBtn')).toBeEnabled();
    const sharePage = await context.newPage();
    const payload = { v: 2, n: 'Older receiver',
      h: [['x-test', 'winner'], ['X-Test', 'first']],
      f: [['*.example.com', true], ['localhost:3000', false]],
      c: ['Production server', 'Backup server'] };
    await sharePage.goto(`https://vibeheader.com/s#c=${encodeURIComponent(JSON.stringify(payload))}`);
    await expect(sharePage.locator('#status')).toContainText("comments won't be retained");
    await sharePage.getByRole('button', { name: 'Import Now', exact: true }).click();
    await expect(sharePage.locator('#status')).toContainText('active now');
    const profiles = await configBarrier(popup);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].headers.map(header => [header.name, header.value]))
      .toEqual(payload.h);
    expect(profiles[0].headers.every(header => !header.comment)).toBe(true);
    expect(profiles[0].filters.map(filter => [filter.expression, filter.enabled])).toEqual(payload.f);
    const rules = await popup.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    expect(rules).toHaveLength(1);
    expect(rules[0].action.requestHeaders).toEqual([
      { header: 'X-Test', operation: 'set', value: 'first' }
    ]);
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
