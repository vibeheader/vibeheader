const http = require('node:http');
const { configBarrier, expect, test } = require('./fixtures');

let echoServer;
let echoOrigin;
let assetRequestHeaders;

test.beforeAll(async () => {
  assetRequestHeaders = new Map();
  echoServer = http.createServer((request, response) => {
    if (request.url === '/asset-page') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html'
      });
      response.end(`<!doctype html>
        <link rel="stylesheet" href="/asset.css">
        <script src="/asset.js"></script>
        <img src="/asset.svg" alt="fixture">
        <video src="/asset.webm" preload="auto" muted></video>`);
      return;
    }

    if (request.url?.startsWith('/asset.')) {
      assetRequestHeaders.set(request.url, request.headers);
      const contentTypes = {
        '/asset.css': 'text/css',
        '/asset.js': 'text/javascript',
        '/asset.svg': 'image/svg+xml',
        '/asset.webm': 'video/webm'
      };
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentTypes[request.url] || 'application/octet-stream'
      });
      if (request.url === '/asset.css') response.end('body { color: rgb(1, 2, 3); }');
      else if (request.url === '/asset.js') response.end('window.assetScriptLoaded = true;');
      else if (request.url === '/asset.svg') {
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
      } else response.end(Buffer.alloc(0));
      return;
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Connection': 'close',
      'Content-Type': 'application/json'
    });
    response.end(JSON.stringify({
      method: request.method,
      url: request.url,
      headers: request.headers,
      rawHeaders: request.rawHeaders
    }));
  });

  await new Promise((resolve, reject) => {
    echoServer.once('error', reject);
    echoServer.listen(0, '127.0.0.1', resolve);
  });
  const address = echoServer.address();
  echoOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (!echoServer) return;
  await new Promise((resolve, reject) => {
    echoServer.close(error => error ? reject(error) : resolve());
  });
});

test('applies the latest saved value to a real Chromium request', async ({ context, openPopup }) => {
  let popup = await openPopup();
  await popup.locator('.vh-h-name').fill('X-VibeHeader-Test');
  await popup.locator('.vh-h-value').fill('old');
  await configBarrier(popup);

  const requestPage = await context.newPage();
  let response = await requestPage.goto(`${echoOrigin}/echo?version=old`);
  let body = await response.json();
  expect(body.headers['x-vibeheader-test']).toBe('old');

  await popup.locator('.vh-h-value').fill('new');
  await popup.close();

  popup = await openPopup();
  await expect(popup.locator('.vh-h-value')).toHaveValue('new');
  await configBarrier(popup);

  const ruleValues = await popup.evaluate(async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.flatMap(rule => rule.action.requestHeaders || [])
      .filter(header => header.header.toLowerCase() === 'x-vibeheader-test')
      .map(header => header.value);
  });
  expect(ruleValues).toEqual(['new']);

  response = await requestPage.goto(`${echoOrigin}/echo?version=new`);
  body = await response.json();
  expect(body.headers['x-vibeheader-test']).toBe('new');
});

test('applies a Header to CSS, JS, image, and media requests', async ({ context, openPopup }) => {
  const popup = await openPopup();
  await popup.locator('.vh-h-name').fill('X-VibeHeader-Asset');
  await popup.locator('.vh-h-value').fill('canary');
  await configBarrier(popup);

  const page = await context.newPage();
  await page.goto(`${echoOrigin}/asset-page`);
  await expect.poll(() => [...assetRequestHeaders.keys()].sort()).toEqual([
    '/asset.css',
    '/asset.js',
    '/asset.svg',
    '/asset.webm'
  ]);

  for (const headers of assetRequestHeaders.values()) {
    expect(headers['x-vibeheader-asset']).toBe('canary');
  }
});
