const http = require('node:http');
const { configBarrier, expect, test } = require('./fixtures');

let echoServer;
let echoOrigin;

test.beforeAll(async () => {
  echoServer = http.createServer((request, response) => {
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
