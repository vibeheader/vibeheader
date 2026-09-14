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
    response.end(JSON.stringify(request.headers));
  });
  await new Promise((resolve, reject) => {
    echoServer.once('error', reject);
    echoServer.listen(0, '127.0.0.1', resolve);
  });
  echoOrigin = `http://127.0.0.1:${echoServer.address().port}`;
});

test.afterAll(async () => {
  if (!echoServer) return;
  await new Promise((resolve, reject) => {
    echoServer.close(error => error ? reject(error) : resolve());
  });
});

async function toggleComments(popup) {
  await popup.locator('#profileTrigger').click();
  await popup.getByRole('menuitemcheckbox', { name: 'Show comments' }).click();
  await popup.locator('#profileTrigger').click();
}

async function enterReorder(popup) {
  await popup.locator('#profileTrigger').click();
  await popup.locator('.vh-profile-more').first().click();
  await popup.getByRole('button', { name: 'Reorder headers', exact: true }).click();
  await expect(popup.locator('#reorderBar')).toBeVisible();
}

test('persists comments on immediate close, shares the display preference across Profiles, and preserves hidden notes', async ({ openPopup }) => {
  let popup = await openPopup();
  await expect(popup.locator('.vh-header-comment')).toHaveCount(0);
  await expect(popup.locator('.vh-header-grip')).toHaveCount(0);
  await popup.locator('.vh-h-name').fill('X-Environment');
  await popup.locator('.vh-h-value').fill('staging');
  await toggleComments(popup);
  await popup.locator('.vh-header-comment').fill('Staging server');
  await popup.close();

  popup = await openPopup();
  await expect(popup.locator('.vh-header-comment')).toHaveValue('Staging server');
  await popup.locator('#profileTrigger').click();
  await popup.locator('.vh-new-profile').click();
  await popup.locator('#profileRenameInput').fill('QA');
  await popup.locator('#profileRenameSave').click();
  await expect(popup.locator('.vh-header-comment')).toHaveValue('');
  await toggleComments(popup);
  await expect(popup.locator('.vh-header-comment')).toHaveCount(0);

  await popup.locator('#profileTrigger').click();
  await popup.locator('.vh-profile-select').first().click();
  await expect(popup.locator('.vh-header-comment')).toHaveCount(0);
  await popup.locator('.vh-h-value').fill('new-staging');
  await configBarrier(popup);
  await toggleComments(popup);
  await expect(popup.locator('.vh-header-comment')).toHaveValue('Staging server');
});

test('keyboard and pointer ordering move whole rows and the last enabled duplicate still wins', async ({ context, openPopup }, testInfo) => {
  let popup = await openPopup();
  await popup.setViewportSize({ width: 480, height: 600 });
  await popup.locator('.vh-h-name').fill('X-Order-Test');
  await popup.locator('.vh-h-value').fill('first');
  await popup.locator('#addHeaderBtn').click();
  await popup.locator('.vh-h-name').last().fill('x-order-test');
  await popup.locator('.vh-h-value').last().fill('winner');
  await toggleComments(popup);
  await popup.locator('.vh-header-comment').first().fill('First server');
  await popup.locator('.vh-header-comment').last().fill('Second server');
  await configBarrier(popup);
  await popup.locator('#profileTrigger').click();
  await popup.screenshot({ path: testInfo.outputPath('comments-menu.png') });
  await popup.locator('#profileTrigger').click();

  const requestPage = await context.newPage();
  const requestValue = async () => {
    const response = await requestPage.goto(`${echoOrigin}/echo?nonce=${Date.now()}`);
    return (await response.json())['x-order-test'];
  };
  expect(await requestValue()).toBe('winner');

  await enterReorder(popup);
  await popup.screenshot({ path: testInfo.outputPath('reorder-mode.png') });
  await popup.locator('.vh-header-grip').first().press('ArrowDown');
  await expect(popup.locator('.vh-h-value').first()).toHaveValue('winner');
  await expect(popup.locator('.vh-header-comment').first()).toHaveValue('Second server');
  await configBarrier(popup);
  expect(await requestValue()).toBe('first');

  await popup.locator('#reorderUndo').click();
  await expect(popup.locator('.vh-h-value').first()).toHaveValue('first');
  await configBarrier(popup);
  expect(await requestValue()).toBe('winner');
  const handle = await popup.locator('.vh-header-grip').first().boundingBox();
  const last = await popup.locator('.vh-header-row').last().boundingBox();
  await popup.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(handle.x + handle.width / 2, last.y + last.height - 2, { steps: 8 });
  await expect(popup.locator('.vh-drag-ghost')).toBeVisible();
  await popup.mouse.up();
  await expect(popup.locator('.vh-drag-ghost')).toHaveCount(0);
  await expect(popup.locator('.vh-h-value').first()).toHaveValue('winner');
  await configBarrier(popup);
  expect(await requestValue()).toBe('first');

  await popup.locator('#reorderDone').click();
  await expect(popup.locator('.vh-header-grip')).toHaveCount(0);
  await popup.close();
  popup = await openPopup();
  await expect(popup.locator('#reorderBar')).toBeHidden();
  await expect(popup.locator('.vh-h-value').first()).toHaveValue('winner');
  await expect(popup.locator('.vh-header-comment').first()).toHaveValue('Second server');
  await popup.locator('.vh-h-value').last().fill('changed-first');
  await configBarrier(popup);
  expect(await requestValue()).toBe('changed-first');
});

test('moving the only enabled IP to the front preserves its request value and disabled alternatives', async ({ context, openPopup }) => {
  let popup = await openPopup();
  for (let index = 0; index < 3; index++) {
    if (index) await popup.locator('#addHeaderBtn').click();
    await popup.locator('.vh-h-name').last().fill('X-Forwarded-For');
    await popup.locator('.vh-h-value').last().fill(`192.0.2.${index + 1}`);
  }
  await toggleComments(popup);
  await popup.locator('.vh-header-comment').nth(0).fill('Occasional');
  await popup.locator('.vh-header-comment').nth(1).fill('Frequent');
  await popup.locator('.vh-header-comment').nth(2).fill('Backup');
  await popup.locator('.vh-h-enabled').nth(0).uncheck();
  await popup.locator('.vh-h-enabled').nth(2).uncheck();
  await configBarrier(popup);
  const requestPage = await context.newPage();
  const requestValue = async () => {
    const response = await requestPage.goto(`${echoOrigin}/ip?nonce=${Date.now()}`);
    return (await response.json())['x-forwarded-for'];
  };
  expect(await requestValue()).toBe('192.0.2.2');
  await enterReorder(popup);
  await popup.locator('.vh-header-grip').nth(1).press('Home');
  await configBarrier(popup);
  expect(await requestValue()).toBe('192.0.2.2');
  await popup.locator('#reorderDone').click();
  await popup.close();
  popup = await openPopup();
  await expect(popup.locator('.vh-h-value').first()).toHaveValue('192.0.2.2');
  await expect(popup.locator('.vh-header-comment').first()).toHaveValue('Frequent');
  await expect(popup.locator('.vh-h-enabled').first()).toBeChecked();
  await expect(popup.locator('.vh-h-enabled').nth(1)).not.toBeChecked();
  await expect(popup.locator('.vh-h-enabled').nth(2)).not.toBeChecked();
  expect(await requestValue()).toBe('192.0.2.2');
});

test('scrolls a long Header list while dragging and Escape cancels the move', async ({ openPopup }) => {
  const popup = await openPopup();
  await popup.setViewportSize({ width: 480, height: 400 });
  await popup.evaluate(async () => {
    const state = await chrome.runtime.sendMessage({ action: 'getConfigs' });
    const response = await chrome.runtime.sendMessage({
      action: 'updateConfig',
      data: {
        id: state.data[0].id,
        config: { active: true, headers: Array.from({ length: 18 }, (_, index) => ({
          name: `X-Server-${index}`, value: String(index), comment: `Server ${index}`
        })) }
      }
    });
    if (!response.success) throw new Error(response.error);
  });
  await popup.reload();
  await expect(popup.locator('.vh-header-row')).toHaveCount(18);
  await enterReorder(popup);
  const handle = await popup.locator('.vh-header-grip').first().boundingBox();
  await popup.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(handle.x + handle.width / 2, 390, { steps: 4 });
  await expect.poll(() => popup.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await popup.keyboard.press('Escape');
  await popup.mouse.up();
  await expect(popup.locator('.vh-drag-ghost')).toHaveCount(0);
  await expect(popup.locator('.vh-h-value').first()).toHaveValue('0');
  await expect(popup.locator('#reorderUndo')).toBeDisabled();
  await configBarrier(popup);
  const headers = await configBarrier(popup);
  expect(headers[0].headers.map(header => header.value))
    .toEqual(Array.from({ length: 18 }, (_, index) => String(index)));
});
