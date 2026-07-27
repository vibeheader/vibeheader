const { configBarrier, expect, test } = require('./fixtures');

test('persists a value when the popup is destroyed immediately', async ({ openPopup }) => {
  let popup = await openPopup();
  await popup.locator('.vh-h-name').fill('X-VibeHeader-Test');
  await popup.locator('.vh-h-value').fill('old');
  await configBarrier(popup);
  await popup.close();

  popup = await openPopup();
  await expect(popup.locator('.vh-h-value')).toHaveValue('old');
  await popup.locator('.vh-h-value').fill('n');
  await popup.locator('.vh-h-value').fill('new');
  await popup.close();

  popup = await openPopup();
  await expect(popup.locator('.vh-h-value')).toHaveValue('new');
  const configs = await configBarrier(popup);
  expect(configs[0].headers[0].value).toBe('new');
});

test('persists a checkbox change when the popup is destroyed immediately', async ({ openPopup }) => {
  let popup = await openPopup();
  await popup.locator('.vh-h-name').fill('X-VibeHeader-Test');
  await popup.locator('.vh-h-value').fill('value');
  await configBarrier(popup);
  await popup.close();

  popup = await openPopup();
  await popup.locator('.vh-h-enabled').uncheck();
  await popup.close();

  popup = await openPopup();
  await expect(popup.locator('.vh-h-enabled')).not.toBeChecked();
  const configs = await configBarrier(popup);
  expect(configs[0].headers[0].enabled).toBe(false);
});
