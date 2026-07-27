/**
 * @jest-environment jsdom
 */

import {
  findOverridingProfile,
  PopupApp,
  getPopupUiState,
  hasEffectiveHeaders
} from '../src/popup/PopupApp.js';

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
      <div id="profileContext">
        <button id="profileTrigger"><span id="profileName"></span></button>
      </div>
      <div id="profileRename" hidden>
        <input id="profileRenameInput">
        <button id="profileRenameSave">Save</button>
      </div>
      <button id="toggleBtn" hidden disabled><span>Resume</span></button>
      <button id="shareBtn" hidden disabled><span>Copy Link</span></button>
      <div id="pauseBanner" hidden>
        <span id="pauseBannerText"></span>
      </div>
      <div id="headers"></div>
      <section id="filtersSection" hidden>
        <button id="filtersSummary"></button>
        <div id="filtersPanel" hidden>
          <div id="filters"></div>
          <button id="testUrlBtn"></button>
          <div id="urlTester" hidden>
            <input id="urlTesterInput">
            <button id="urlTesterRun"></button>
            <button id="urlTesterDone"></button>
            <div id="urlTesterResult"></div>
          </div>
        </div>
      </section>
      <button id="addHeaderBtn" disabled>Add header</button>
      <button id="addFilterBtn" disabled>Add filter</button>
      <a id="feedbackLink" hidden>Feedback</a>
      <div id="profileMenu" hidden></div>
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
    case 'getProfileState':
      return {
        success: true,
        data: {
          profiles: [clone(persistedConfig)],
          selectedProfileId: persistedConfig.id,
          profileModeActivated: false
        }
      };
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
      persistedConfig = {
        ...persistedConfig,
        active: message.data.enabled,
        enabled: message.data.enabled
      };
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
  jest.useRealTimers();
  delete global.chrome;
  delete global.Worker;
  delete navigator.clipboard;
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

describe('popup state', () => {
  test('requires an enabled row with a valid Header name and value', () => {
    expect(hasEffectiveHeaders([
      { name: 'X-Test', value: '', enabled: true }
    ])).toBe(true);
    expect(hasEffectiveHeaders([
      { name: 'X-Test', value: 'value', enabled: false }
    ])).toBe(false);
    expect(hasEffectiveHeaders([
      { name: '   ', value: 'value', enabled: true }
    ])).toBe(false);
    expect(hasEffectiveHeaders([
      { name: 'Bad Header', value: 'value', enabled: true }
    ])).toBe(false);
    expect(hasEffectiveHeaders([
      { name: 'X-Test', value: 'line\nbreak', enabled: true }
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

  test('finds only confirmed same-header conflicts in later active Profiles', () => {
    const header = {
      name: 'X-Test',
      value: 'first',
      enabled: true,
      type: 'request'
    };
    const first = {
      id: 'first',
      name: 'First',
      active: true,
      headers: [header],
      filters: [{ expression: '*.example.com', enabled: true }]
    };
    const later = {
      id: 'later',
      name: 'Later',
      active: true,
      headers: [{ ...header, value: 'later' }],
      filters: [{ expression: 'api.example.com', enabled: true }]
    };

    expect(findOverridingProfile([first, later], first.id, header))
      .toBe(later);

    later.headers[0].value = 'first';
    expect(findOverridingProfile([first, later], first.id, header))
      .toBeNull();
    later.headers[0].value = 'later';

    later.filters = [{ expression: 'api.other.com', enabled: true }];
    expect(findOverridingProfile([first, later], first.id, header))
      .toBeNull();

    first.filters = [{ expression: '^https://.*\\.example\\.com/', enabled: true }];
    later.filters = [{ expression: '^https://api\\.example\\.com/', enabled: true }];
    expect(findOverridingProfile([first, later], first.id, header))
      .toBeNull();

    later.filters = [{ expression: '^https://.*\\.example\\.com/', enabled: true }];
    expect(findOverridingProfile([first, later], first.id, header))
      .toBe(later);
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

  test('mentions other active Profiles only when they can still apply Headers', async () => {
    const { app } = await createApp(makeConfig({
      enabled: false,
      headers: [{ name: 'X-Current', value: '1', enabled: true }]
    }));

    expect(document.getElementById('pauseBannerText').textContent)
      .toBe('Paused. Headers aren’t being applied.');

    app.profiles.push({
      id: 'other',
      active: true,
      headers: [{ name: 'X-Other', value: '2', enabled: true }]
    });
    app.updateControlsUI();
    expect(document.getElementById('pauseBannerText').textContent)
      .toBe('Paused. 1 other profile is still active.');

    app.profiles.push({
      id: 'empty',
      active: true,
      headers: [{ name: '', value: '', enabled: true }]
    });
    app.updateControlsUI();
    expect(document.getElementById('pauseBannerText').textContent)
      .toBe('Paused. 1 other profile is still active.');

    app.profiles[1].active = false;
    app.updateControlsUI();
    expect(document.getElementById('pauseBannerText').textContent)
      .toBe('Paused. Headers aren’t being applied.');
  });
});

describe('popup persistence', () => {
  test('shows Copy Link feedback inside the button without a toast', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn(async () => {}) }
    });
    await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }]
    }));

    document.getElementById('shareBtn').click();
    await Promise.resolve();

    expect(document.getElementById('shareBtn').textContent).toContain('Copied!');
    const copiedIcon = document.querySelector('#shareBtn svg');
    expect(copiedIcon.getAttribute('class')).toBe('vh-icon');
    expect(copiedIcon.getAttribute('stroke-width')).toBe('2');
    expect(copiedIcon.querySelector('path').getAttribute('d'))
      .toBe('M20 6L9 17l-5-5');
    expect(document.getElementById('toast')).toBeNull();
  });

  test('treats a blank Filter as all requests and allows Copy Link', async () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const { app } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }],
      filters: [{ expression: '', enabled: true }]
    }));
    app.currentTabUrl = 'https://staging.example.com/dashboard';
    app.renderFilters();

    expect(document.getElementById('filtersSummary').textContent)
      .toContain('All requests');
    expect(document.getElementById('filtersSummary').textContent)
      .toContain('Active on this tab');

    document.getElementById('shareBtn').click();
    await Promise.resolve();

    expect(document.getElementById('shareBtn').textContent).toContain('Copied!');
    const encodedPayload = writeText.mock.calls[0][0].split('#c=')[1];
    const payload = JSON.parse(decodeURIComponent(encodedPayload));
    expect(payload).toEqual({
      v: 2,
      n: 'Default',
      h: [['X-Test', 'value']],
      f: []
    });
  });

  test('uses compact tuples for shared Headers and Filters', async () => {
    const { app } = await createApp(makeConfig({
      name: 'Profile 1',
      enabled: true,
      headers: [
        { name: 'x-vibe-env', value: 'local-test', enabled: true },
        { name: 'x-vibe-param', value: 'true', enabled: true }
      ],
      filters: [
        { expression: 'www.google.com.hk', enabled: true },
        { expression: '*.vibeheader.com', enabled: true }
      ]
    }));

    expect(app.profileSharePayload(app.config)).toEqual({
      v: 2,
      n: 'Profile 1',
      h: [
        ['x-vibe-env', 'local-test'],
        ['x-vibe-param', 'true']
      ],
      f: [
        ['www.google.com.hk', true],
        ['*.vibeheader.com', true]
      ]
    });
  });

  test('keeps an invalid Header draft visible but excludes it from sharing', async () => {
    const { app } = await createApp(makeConfig({
      name: 'Drafts',
      enabled: true,
      headers: [
        { name: 'Bad Header', value: 'draft', enabled: true },
        { name: 'X-Test', value: 'valid', enabled: true }
      ]
    }));

    const invalidInput = document.querySelector('.vh-h-name');
    expect(invalidInput.value).toBe('Bad Header');
    expect(invalidInput.getAttribute('aria-invalid')).toBe('true');
    expect(app.profileSharePayload(app.config).h).toEqual([
      ['X-Test', 'valid']
    ]);
  });

  test('keeps a new Filter focused, hides suggestions, and saves typed content', async () => {
    const { app, chromeMock } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }]
    }));
    app.currentTabUrl = 'https://staging.example.com/dashboard';
    app.currentTabHost = 'staging.example.com';
    app.currentTabRoot = 'example.com';
    chromeMock.sendMessage.mockClear();

    document.getElementById('addFilterBtn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const input = document.querySelector('.vh-filter-value');
    expect(input).toBe(document.activeElement);
    expect(document.querySelector('.vh-suggestions').hidden).toBe(false);

    const outside = document.getElementById('addHeaderBtn');
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    outside.focus();
    expect(document.querySelector('.vh-suggestions').hidden).toBe(true);

    input.focus();
    expect(document.querySelector('.vh-suggestions').hidden).toBe(false);

    document.getElementById('filtersSummary').click();
    document.getElementById('addFilterBtn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const suggestionPanels = [...document.querySelectorAll('.vh-suggestions')];
    expect(suggestionPanels).toHaveLength(2);
    expect(suggestionPanels.filter(panel => !panel.hidden)).toHaveLength(1);

    const focusedInput = document.activeElement;
    expect(focusedInput).toBe(document.querySelectorAll('.vh-filter-value')[1]);
    focusedInput.value = 'api.example.com';
    focusedInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(focusedInput).toBe(document.activeElement);
    expect(suggestionPanels[1].hidden).toBe(true);
    const messages = updateMessages(chromeMock.sendMessage);
    expect(messages.at(-1).data.config.filters[1].expression)
      .toBe('api.example.com');

    focusedInput.value = 'https://';
    focusedInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(focusedInput.getAttribute('aria-invalid')).toBe('true');
    const error = focusedInput.closest('.vh-filter-row')
      .querySelector('.vh-filter-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('valid HTTP(S) URL');

    focusedInput.value = '';
    focusedInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(focusedInput.getAttribute('aria-invalid')).toBe('false');
    expect(error.hidden).toBe(true);
  });

  test('shows a short inline reason for a risky regex without interrupting input', async () => {
    await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }],
      filters: [{ expression: 'api.example.com', enabled: true }]
    }));
    document.getElementById('filtersSummary').click();

    const input = document.querySelector('.vh-filter-value');
    input.focus();
    input.value = '/^(a+)+$/';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const error = input.closest('.vh-filter-row')
      .querySelector('.vh-filter-error');
    expect(input).toBe(document.activeElement);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Regex contains a repeated nested pattern');
  });

  test('restores invalid draft highlighting after Filters are reopened', async () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const expression = '^([a-zA-Z0-9])(([\\-.]|[_]+)?([a-zA-Z0-9]+))*'
      + '(@){1}[a-z0-9]+[.]{1}(([a-z]{2,3})|([a-z]{2,3}[.]{1}[a-z]{2,3}))$';
    await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }],
      filters: [{ expression, enabled: true }]
    }));

    document.getElementById('filtersSummary').click();
    let input = document.querySelector('.vh-filter-value');
    let error = document.querySelector('.vh-filter-error');
    expect(document.getElementById('filtersSummary').textContent)
      .toContain('All requests');
    expect(document.getElementById('filtersSummary').textContent)
      .toContain('Active on this tab');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error.textContent).toBe('Regex contains a repeated nested pattern');

    document.getElementById('filtersSummary').click();
    document.getElementById('filtersSummary').click();
    input = document.querySelector('.vh-filter-value');
    error = document.querySelector('.vh-filter-error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error.hidden).toBe(false);

    document.getElementById('shareBtn').click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(document.getElementById('shareBtn').textContent)
      .toContain('Copied!');
    const encodedPayload = writeText.mock.calls[0][0].split('#c=')[1];
    expect(JSON.parse(decodeURIComponent(encodedPayload)).f).toEqual([]);
  });

  test('excludes invalid drafts from the Applies to summary', async () => {
    const { app } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }],
      filters: [
        { expression: '/^(a+)+$/', enabled: true },
        { expression: 'api.example.com', enabled: true }
      ]
    }));

    const summary = document.getElementById('filtersSummary').textContent;
    expect(summary).toContain('api.example.com');
    expect(summary).not.toContain('/^(a+)+$/');
    expect(summary).not.toContain('+1');
    expect(app.profileSharePayload(app.config).f)
      .toEqual([['api.example.com', true]]);
  });

  test('disables Add filter at the per-Profile limit', async () => {
    await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }],
      filters: Array.from({ length: 100 }, (_, index) => ({
        expression: `api-${index}.example.com`,
        enabled: true
      }))
    }));

    expect(document.getElementById('addFilterBtn').disabled).toBe(true);
    expect(document.getElementById('addFilterBtn').title)
      .toContain('100 filters');
  });

  test('tests a domain without requiring an http(s) prefix', async () => {
    const { app } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }]
    }));
    app.currentTabUrl = 'https://staging.example.com/dashboard';
    app.currentTabHost = 'staging.example.com';
    app.currentTabRoot = 'example.com';

    document.getElementById('addFilterBtn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const input = document.querySelector('.vh-filter-value');
    input.value = 'api.example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    document.getElementById('testUrlBtn').click();
    const testerInput = document.getElementById('urlTesterInput');
    testerInput.value = 'api.example.com';
    testerInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('urlTesterRun').click();

    expect(testerInput.getAttribute('aria-invalid')).toBe('false');
    expect(document.getElementById('urlTesterResult').textContent)
      .toContain('Matched by 1 rule');
  });

  test('never evaluates a user Regex on the Popup thread when Worker is unavailable', async () => {
    const { app } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }],
      filters: [{ expression: '^https://api\\.example\\.com/', enabled: true }]
    }));
    app.currentTabUrl = 'https://api.example.com/users';
    app.renderFilters();

    expect(document.getElementById('filtersSummary').textContent)
      .toContain('Active with regex');

    document.getElementById('filtersSummary').click();
    document.getElementById('testUrlBtn').click();
    const testerInput = document.getElementById('urlTesterInput');
    testerInput.value = 'https://api.example.com/users';
    testerInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('urlTesterRun').click();

    expect(document.getElementById('urlTesterResult').textContent)
      .toBe('Regex testing is unavailable');
  });

  test('terminates an over-budget Filter test and marks only that Filter invalid', async () => {
    jest.useFakeTimers();
    const workers = [];
    class HangingWorker {
      constructor() {
        this.terminate = jest.fn();
        workers.push(this);
      }

      postMessage(message) {
        this.onmessage({
          data: {
            type: 'started',
            runId: message.runId,
            filterId: message.filters[0].id
          }
        });
      }
    }
    global.Worker = HangingWorker;

    const { chromeMock } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }],
      filters: [{ expression: '^https://api\\.example\\.com/', enabled: true }]
    }));
    chromeMock.sendMessage.mockClear();
    global.chrome.runtime.getURL = jest.fn(() => 'filter-match-worker.js');

    document.getElementById('filtersSummary').click();
    document.getElementById('testUrlBtn').click();
    const testerInput = document.getElementById('urlTesterInput');
    testerInput.value = 'https://api.example.com/users';
    testerInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('urlTesterRun').click();

    jest.advanceTimersByTime(101);

    expect(workers[0].terminate).toHaveBeenCalled();
    const filterInput = document.querySelector('.vh-filter-value');
    const error = document.querySelector('.vh-filter-error');
    expect(filterInput.getAttribute('aria-invalid')).toBe('true');
    expect(error.textContent).toBe('Filter is too complex to test safely');
    expect(document.getElementById('urlTesterResult').textContent)
      .toBe('Filter is too complex to test safely');

    const messages = updateMessages(chromeMock.sendMessage);
    expect(messages.at(-1).data.config.filters[0].runtimeValidationReason)
      .toBe('Filter is too complex to test safely');
  });

  test('shows suggestions when an existing Filter is cleared', async () => {
    const { app } = await createApp(makeConfig({
      enabled: true,
      headers: [{ name: 'X-Test', value: 'value', enabled: true, type: 'request' }],
      filters: [{ expression: 'api.example.com', enabled: true }]
    }));
    app.currentTabUrl = 'https://staging.example.com/dashboard';
    app.currentTabHost = 'staging.example.com';
    app.currentTabRoot = 'example.com';
    app.filtersOpen = true;
    app.renderFilters();

    const input = document.querySelector('.vh-filter-value');
    expect(document.querySelector('.vh-suggestions').hidden).toBe(true);

    input.focus();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(document.querySelector('.vh-suggestions').hidden).toBe(false);
  });

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
      if (message.action === 'getProfileState') {
        return Promise.resolve({ success: false });
      }
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
