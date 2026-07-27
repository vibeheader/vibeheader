const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect, test: base } = require('@playwright/test');

const extensionPath = path.resolve(__dirname, '..', 'dist');

const test = base.extend({
  context: async ({ headless }, use) => {
    const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeheader-e2e-'));
    const context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    try {
      await use(context);
    } finally {
      await context.close();
      await fs.rm(profilePath, { recursive: true, force: true });
    }
  },

  extensionId: async ({ context }, use) => {
    let worker = context.serviceWorkers()
      .find(candidate => candidate.url().startsWith('chrome-extension://'));
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', {
        predicate: candidate => candidate.url().startsWith('chrome-extension://')
      });
    }
    await use(new URL(worker.url()).hostname);
  },

  openPopup: async ({ context, extensionId }, use) => {
    await use(async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(page.locator('#addHeaderBtn')).toBeEnabled();
      return page;
    });
  }
});

async function configBarrier(page) {
  return page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'getConfigs' });
    if (!response?.success) {
      throw new Error(response?.error || 'getConfigs failed');
    }
    return response.data;
  });
}

module.exports = {
  configBarrier,
  expect,
  test
};
