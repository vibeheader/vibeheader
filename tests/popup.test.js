/**
 * @jest-environment jsdom
 */

import { PopupApp, getPopupUiState, hasEffectiveHeaders } from '../src/popup/PopupApp.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeConfig(overrides = {}) {
  return {
    id: 'config_test',
    name: 'Default',
    enabled: false,
    headers: [],
    scope: { type: 'all', value: '' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function renderShell() {
  document.body.innerHTML = `
    <div id="app">
      <button id="toggleBtn" hidden disabled><span>Resume</span></button>
      <button id="shareBtn" hidden disabled><span>Copy Link</span></button>
      <div id="headers"></div>
      <button id="addHeaderBtn" disabled>+ Add header</button>
      <a id="feedbackLink" hidden>Feedback</a>
    </div>
  `;
}

function installChromeMock(initialConfig, options = {}) {
  let persistedConfig = clone(initialConfig);
  const storageGet = options.storageGet || jest.fn(async () => ({
    configs: [clone(persistedConfig)]
  }));
  const sendMessage = options.sendMessage || jest.fn(async (message) => {
    switch (message.action) {
    case 'getConfigs':
      return { success: true, data: [clone(persistedConfig)] };
    case 'addConfig':
      persistedConfig = makeConfig(message.data);
      return { success: true, data: clone(persistedConfig) };
    case 'updateConfig':
      persistedConfig = {
        ...persistedConfig,
        ...clone(message.data.config)
      };
      return { success: true, data: clone(persistedConfig) };
    case 'toggleConfig':
      persistedConfig = { ...persistedConfig, enabled: message.data.enabled };
      return { success: true, data: clone(persistedConfig) };
    default:
      return { success: false, error: `Unexpected action: ${message.action}` };
    }
  });

  global.chrome = {
    storage: {
      local: {
        get: storageGet
      }
    },
    runtime: {
      sendMessage,
      lastError: null
    }
  };

  return {
    sendMessage,
    storageGet,
    getPersistedConfig: () => clone(persistedConfig)
  };
}

async function createApp(config, options) {
  renderShell();
  const chromeMock = installChromeMock(config, options);
  const app = new PopupApp();
  await app.ready;
  return { app, chromeMock };
}

function updateMessages(sendMessage) {
  return sendMessage.mock.calls
    .map(([message]) => message)
    .filter(message => message.action === 'updateConfig');
}

afterEach(() => {
  delete global.chrome;
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

describe('popup state', () => {
  test('requires an enabled row with a non-empty name', () => {
    expect(hasEffectiveHeaders([
      { name: 'X-Test', value: '', enabled: true }
    ])).toBe(true);
    expect(hasEffectiveHeaders([
      { name: 'X-Test', value: 'value', enabled: false }
    ])).toBe(false);
    expect(hasEffectiveHeaders([
      { name: '   ', value: 'value', enabled: true }
    ])).toBe(false);
  });

  test('derives empty, active, and paused action states without conflating them', () => {
    expect(getPopupUiState(makeConfig())).toEqual({
      hasEffectiveHeaders: false,
      actionsVisible: false,
      enabled: false,
      paused: false
    });
    expect(getPopupUiState(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: '', enabled: true }]
    }))).toEqual({
      hasEffectiveHeaders: true,
      actionsVisible: true,
      enabled: true,
      paused: false
    });
    expect(getPopupUiState(makeConfig({
      enabled: false,
      headers: [{ name: 'X-Test', value: '', enabled: true }]
    }))).toEqual({
      hasEffectiveHeaders: true,
      actionsVisible: true,
      enabled: false,
      paused: true
    });
  });

  test('keeps controls gated until initialization completes', async () => {
    renderShell();
    const storageResult = deferred();
    installChromeMock(makeConfig(), {
      sendMessage: jest.fn(async (message) => {
        if (message.action === 'getConfigs') {
          await storageResult.promise;
          return { success: true, data: [makeConfig()] };
        }
        throw new Error(`Unexpected action: ${message.action}`);
      })
    });

    const app = new PopupApp();

    expect(document.getElementById('toggleBtn').hidden).toBe(true);
    expect(document.getElementById('shareBtn').hidden).toBe(true);
    expect(document.getElementById('addHeaderBtn').disabled).toBe(true);

    storageResult.resolve();
    await app.ready;

    expect(document.getElementById('toggleBtn').hidden).toBe(true);
    expect(document.getElementById('shareBtn').hidden).toBe(true);
    expect(document.getElementById('addHeaderBtn').disabled).toBe(false);
  });
});

describe('popup persistence', () => {
  test('sends text edits immediately without waiting for a timer', async () => {
    const { chromeMock } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'old', enabled: true, type: 'request' }]
    }));
    chromeMock.sendMessage.mockClear();

    const valueInput = document.querySelector('.vh-h-value');
    valueInput.value = 'new';
    valueInput.dispatchEvent(new Event('input', { bubbles: true }));

    const messages = updateMessages(chromeMock.sendMessage);
    expect(messages).toHaveLength(1);
    expect(messages[0].data.config.headers[0].value).toBe('new');
  });

  test('sends one immediate save for a checkbox change', async () => {
    const { chromeMock } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }]
    }));
    chromeMock.sendMessage.mockClear();

    const checkbox = document.querySelector('.vh-h-enabled');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));

    const messages = updateMessages(chromeMock.sendMessage);
    expect(messages).toHaveLength(1);
    expect(messages[0].data.config.headers[0].enabled).toBe(false);
  });

  test('sends immutable snapshots for rapid edits', async () => {
    const pending = [];
    const sendMessage = jest.fn((message) => {
      if (message.action !== 'updateConfig') {
        return Promise.resolve({ success: true, data: [makeConfig()] });
      }
      const result = deferred();
      pending.push(result);
      return result.promise;
    });
    await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'old', enabled: true, type: 'request' }]
    }), { sendMessage });
    sendMessage.mockClear();

    const valueInput = document.querySelector('.vh-h-value');
    valueInput.value = 'n';
    valueInput.dispatchEvent(new Event('input', { bubbles: true }));
    valueInput.value = 'new';
    valueInput.dispatchEvent(new Event('input', { bubbles: true }));

    const messages = updateMessages(sendMessage);
    expect(messages).toHaveLength(2);
    expect(messages[0].data.config.headers[0].value).toBe('n');
    expect(messages[1].data.config.headers[0].value).toBe('new');

    pending.forEach((item, index) => item.resolve({
      success: true,
      data: makeConfig({
        enabled: true,
        headers: messages[index].data.config.headers
      })
    }));
  });

  test('ignores a stale response that arrives after the latest edit', async () => {
    const pending = [];
    const sendMessage = jest.fn((message) => {
      if (message.action === 'getConfigs') {
        return Promise.resolve({
          success: true,
          data: [makeConfig({
            enabled: true,
            headers: [{ name: 'X-Test', value: 'old', enabled: true, type: 'request' }]
          })]
        });
      }
      const result = deferred();
      pending.push({ result, message });
      return result.promise;
    });
    const { app } = await createApp(makeConfig(), { sendMessage });
    sendMessage.mockClear();

    const valueInput = document.querySelector('.vh-h-value');
    valueInput.value = 'n';
    valueInput.dispatchEvent(new Event('input', { bubbles: true }));
    valueInput.value = 'new';
    valueInput.dispatchEvent(new Event('input', { bubbles: true }));

    pending[1].result.resolve({
      success: true,
      data: makeConfig({
        enabled: true,
        headers: pending[1].message.data.config.headers
      })
    });
    await Promise.resolve();
    pending[0].result.resolve({
      success: true,
      data: makeConfig({
        enabled: false,
        headers: pending[0].message.data.config.headers
      })
    });
    await Promise.resolve();

    expect(document.querySelector('.vh-h-value').value).toBe('new');
    expect(app.config.headers[0].value).toBe('new');
    expect(app.config.enabled).toBe(true);
  });

  test('does not let a pending save response undo an immediate Pause', async () => {
    const initialConfig = makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'old', enabled: true, type: 'request' }]
    });
    const saveResult = deferred();
    const toggleResult = deferred();
    const sendMessage = jest.fn((message) => {
      if (message.action === 'getConfigs') {
        return Promise.resolve({ success: true, data: [clone(initialConfig)] });
      }
      if (message.action === 'updateConfig') return saveResult.promise;
      if (message.action === 'toggleConfig') return toggleResult.promise;
      throw new Error(`Unexpected action: ${message.action}`);
    });
    const { app } = await createApp(initialConfig, { sendMessage });
    sendMessage.mockClear();

    const valueInput = document.querySelector('.vh-h-value');
    valueInput.value = 'new';
    valueInput.dispatchEvent(new Event('input', { bubbles: true }));
    const savePromise = app._lastMutationPromise;

    const toggleButton = document.getElementById('toggleBtn');
    toggleButton.click();
    const togglePromise = app._lastMutationPromise;

    expect(updateMessages(sendMessage)).toHaveLength(1);
    expect(sendMessage.mock.calls.map(([message]) => message.action)).toEqual([
      'updateConfig',
      'toggleConfig'
    ]);
    expect(sendMessage.mock.calls[1][0].data.enabled).toBe(false);
    expect(app.config.enabled).toBe(false);
    expect(toggleButton.getAttribute('data-enabled')).toBe('false');
    expect(toggleButton.textContent).toContain('Resume');

    // An older save can finish before the queued toggle. Its response must not
    // restore the previous enabled state in this popup.
    saveResult.resolve({
      success: true,
      data: makeConfig({
        enabled: true,
        headers: [{ name: 'X-Test', value: 'new', enabled: true, type: 'request' }]
      })
    });
    await savePromise;

    expect(app.config.enabled).toBe(false);
    expect(toggleButton.getAttribute('data-enabled')).toBe('false');
    expect(toggleButton.textContent).toContain('Resume');

    toggleResult.resolve({
      success: true,
      data: makeConfig({
        enabled: false,
        headers: [{ name: 'X-Test', value: 'new', enabled: true, type: 'request' }]
      })
    });
    await togglePromise;

    expect(app.config.enabled).toBe(false);
    expect(toggleButton.getAttribute('data-enabled')).toBe('false');
    expect(toggleButton.textContent).toContain('Resume');
  });
});
