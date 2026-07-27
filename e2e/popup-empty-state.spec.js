const { configBarrier, expect, test } = require('./fixtures');

test('shows actions only when an effective header exists', async ({ openPopup }) => {
  const popup = await openPopup();
  const toggle = popup.locator('#toggleBtn');
  const share = popup.locator('#shareBtn');
  const name = popup.locator('.vh-h-name');
  const checkbox = popup.locator('.vh-h-enabled');

  await expect(toggle).toBeHidden();
  await expect(share).toBeHidden();
  const emptyLayout = await popup.evaluate(() => ({
    popupHeight: document.getElementById('app').getBoundingClientRect().height,
    headerHeight: document.querySelector('.vh-headerbar').getBoundingClientRect().height
  }));

  await name.fill('X-VibeHeader-Test');
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText('Pause');
  await expect(share).toBeVisible();
  const populatedLayout = await popup.evaluate(() => ({
    popupHeight: document.getElementById('app').getBoundingClientRect().height,
    headerHeight: document.querySelector('.vh-headerbar').getBoundingClientRect().height
  }));
  expect(populatedLayout).toEqual(emptyLayout);

  await toggle.click();
  await expect(toggle).toContainText('Resume');
  await expect(share).toBeVisible();
  let configs = await configBarrier(popup);
  expect(configs[0].enabled).toBe(false);

  await toggle.click();
  await expect(toggle).toContainText('Pause');
  configs = await configBarrier(popup);
  expect(configs[0].enabled).toBe(true);

  await checkbox.uncheck();
  await expect(toggle).toBeHidden();
  await expect(share).toBeHidden();

  await checkbox.check();
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText('Pause');

  await name.fill('');
  await expect(toggle).toBeHidden();
  await expect(share).toBeHidden();

  configs = await configBarrier(popup);
  expect(configs[0].headers[0].name).toBe('');
});
