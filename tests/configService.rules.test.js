import { Config } from '../src/shared/models/Config.js';
import { ConfigService } from '../src/shared/services/ConfigService.js';

const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other'
];

describe('ConfigService buildDnrRules', () => {
  test('builds rules for domain scope with request header', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      name: 'domain test',
      enabled: true,
      scope: { type: 'domain', value: 'example.com' },
      headers: [{ name: 'Authorization', value: 'Bearer 123', type: 'request', enabled: true }]
    });

    const rules = svc.buildDnrRules([cfg]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action.type).toBe('modifyHeaders');
    expect(rules[0].action.requestHeaders[0]).toEqual({ header: 'Authorization', operation: 'set', value: 'Bearer 123' });
    expect(rules[0].condition).toEqual({
      regexFilter: '^https?://(?:[^./:]+\\.)*example\\.com(?::[0-9]+)?(?:/|$)',
      isUrlFilterCaseSensitive: false,
      resourceTypes: RESOURCE_TYPES
    });
  });

  test('applies Header actions to document and subresource requests by default', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      active: true,
      headers: [{ name: 'X-Canary', value: 'enabled', enabled: true }]
    });

    const [rule] = svc.buildDnrRules([cfg]);
    expect(rule.condition.resourceTypes).toEqual(RESOURCE_TYPES);
    expect(rule.condition.resourceTypes).toEqual(expect.arrayContaining([
      'main_frame',
      'stylesheet',
      'script',
      'image',
      'media',
      'xmlhttprequest'
    ]));
  });

  test('builds rules for prefix scope with response header', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      name: 'prefix test',
      enabled: true,
      scope: { type: 'prefix', value: 'https://api.example.com/v1/' },
      headers: [{ name: 'X-Debug', value: '1', type: 'response', enabled: true }]
    });

    const rules = svc.buildDnrRules([cfg]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action.responseHeaders[0]).toEqual({ header: 'X-Debug', operation: 'set', value: '1' });
    expect(rules[0].condition).toEqual({
      regexFilter: '^https://api\\.example\\.com/v1/.*$',
      isUrlFilterCaseSensitive: false,
      resourceTypes: RESOURCE_TYPES
    });
  });

  test('skips disabled and invalid Header drafts', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      name: 'mixed',
      enabled: true,
      scope: { type: 'domain', value: 'example.com' },
      headers: [
        { name: 'A', value: 'a', type: 'request', enabled: false },
        { name: '', value: 'x', type: 'request', enabled: true },
        { name: 'Bad Header', value: 'x', type: 'request', enabled: true },
        { name: 'Bad-Value', value: 'line\nbreak', type: 'request', enabled: true },
        { name: 'B', value: 'b', type: 'request', enabled: true }
      ]
    });

    const rules = svc.buildDnrRules([cfg]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action.requestHeaders[0]).toEqual({ header: 'B', operation: 'set', value: 'b' });
  });

  test('keeps a stable rule ID when a Filter expression changes', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      id: 'profile_stable',
      enabled: true,
      headers: [{ name: 'X-Test', value: '1', enabled: true }],
      filters: [{ expression: 'api.example.com', enabled: true }]
    });
    const before = svc.buildDnrRules([cfg]);
    const filter = cfg.filters[0];

    cfg.filters = [{ ...filter, expression: 'staging.example.com' }];
    const after = svc.buildDnrRules([cfg]);

    expect(after[0].id).toBe(before[0].id);
    expect(after[0].condition).not.toEqual(before[0].condition);
  });

  test('rejects Profiles above the Filter count limit', async () => {
    const svc = new ConfigService();
    await expect(svc.addConfig({
      name: 'Too many',
      filters: Array.from({ length: 101 }, (_, index) => ({
        expression: `api-${index}.example.com`
      }))
    })).rejects.toThrow('up to 100 filters');
  });
});

describe('ConfigService importConfig', () => {
  test('reuses a pristine Default Profile', async () => {
    const svc = new ConfigService();
    const original = new Config({
      id: 'default-profile',
      name: 'Default',
      active: false
    });
    svc.configs = [original];
    svc.popupState = {
      selectedProfileId: original.id,
      profileModeActivated: false
    };
    svc.saveConfigs = jest.fn(async () => {});
    svc.savePopupState = jest.fn(async () => {});

    const imported = await svc.importConfig({
      name: 'Staging',
      active: true,
      headers: [{ name: 'X-Test', value: '1', enabled: true }]
    });

    expect(svc.configs).toHaveLength(1);
    expect(imported.id).toBe('default-profile');
    expect(imported.name).toBe('Staging');
    expect(imported.active).toBe(true);
    expect(imported.headers[0]).toEqual(
      expect.objectContaining({ name: 'X-Test', value: '1' })
    );
    expect(svc.popupState.profileModeActivated).toBe(false);
  });

  test('also reuses the untouched blank row created by the popup', async () => {
    const svc = new ConfigService();
    const original = new Config({
      id: 'default-profile',
      name: 'Default',
      active: false,
      headers: [{ name: '', value: '', enabled: true }]
    });
    svc.configs = [original];
    svc.popupState = {
      selectedProfileId: original.id,
      profileModeActivated: false
    };
    svc.saveConfigs = jest.fn(async () => {});
    svc.savePopupState = jest.fn(async () => {});

    await svc.importConfig({
      name: 'Production',
      active: true,
      headers: [{ name: 'X-Env', value: 'production', enabled: true }]
    });

    expect(svc.configs).toHaveLength(1);
    expect(svc.configs[0].id).toBe('default-profile');
    expect(svc.configs[0].name).toBe('Production');
  });

  test.each([
    {
      label: 'a stale active state',
      setup: { active: true }
    },
    {
      label: 'a custom name and previous multi-Profile state',
      setup: {
        name: 'My empty Profile',
        popupState: { profileModeActivated: true }
      }
    },
    {
      label: 'a blank Filter row',
      setup: { filters: [{ expression: '', enabled: true }] }
    },
    {
      label: 'a disabled blank Header row',
      setup: { headers: [{ name: '', value: '', enabled: false }] }
    },
    {
      label: 'multiple blank Header rows',
      setup: {
        headers: [
          { name: '', value: '', enabled: true },
          { name: '', value: '', enabled: false }
        ]
      }
    }
  ])('reuses a visually empty Default with $label', async ({ setup }) => {
    const svc = new ConfigService();
    const original = new Config({
      id: 'default-profile',
      name: setup.name || 'Default',
      active: false,
      ...setup
    });
    svc.configs = [original];
    svc.popupState = {
      selectedProfileId: original.id,
      profileModeActivated: setup.popupState?.profileModeActivated || false
    };
    svc.saveConfigs = jest.fn(async () => {});
    svc.savePopupState = jest.fn(async () => {});

    const imported = await svc.importConfig({
      name: 'Imported',
      active: true,
      headers: [{ name: 'X-Test', value: '1', enabled: true }]
    });

    expect(svc.configs).toHaveLength(1);
    expect(imported.id).toBe('default-profile');
    expect(svc.popupState.profileModeActivated)
      .toBe(setup.popupState?.profileModeActivated || false);
  });

  test.each([
    {
      label: 'a Header value draft',
      setup: { headers: [{ name: '', value: 'draft', enabled: true }] }
    },
    {
      label: 'a Header name',
      setup: { headers: [{ name: 'X-Draft', value: '', enabled: false }] }
    },
    {
      label: 'a Filter expression',
      setup: { filters: [{ expression: 'api.example.com', enabled: false }] }
    }
  ])('creates a new Profile when Default contains $label', async ({ setup }) => {
    const svc = new ConfigService();
    const original = new Config({
      id: 'default-profile',
      name: 'Default',
      active: false,
      ...setup
    });
    svc.configs = [original];
    svc.popupState = {
      selectedProfileId: original.id,
      profileModeActivated: false
    };
    svc.saveConfigs = jest.fn(async () => {});
    svc.savePopupState = jest.fn(async () => {});

    const imported = await svc.importConfig({
      name: 'Imported',
      active: true,
      headers: [{ name: 'X-Test', value: '1', enabled: true }]
    });

    expect(svc.configs).toHaveLength(2);
    expect(imported.id).not.toBe('default-profile');
    expect(svc.popupState.profileModeActivated).toBe(true);
  });
});

describe('ConfigService updateNetworkRules', () => {
  afterEach(() => {
    delete global.chrome;
  });

  test('replaces old and new dynamic rules in one atomic call', async () => {
    const updateDynamicRules = jest.fn(async () => {});
    global.chrome = {
      declarativeNetRequest: {
        getDynamicRules: jest.fn(async () => [{ id: 99 }]),
        updateDynamicRules
      }
    };
    const svc = new ConfigService();
    const cfg = new Config({
      id: 'config_atomic',
      enabled: true,
      scope: { type: 'all', value: '' },
      headers: [{ name: 'X-Test', value: 'new', type: 'request', enabled: true }]
    });
    svc.configs = [cfg];

    await svc.updateNetworkRules();

    expect(updateDynamicRules).toHaveBeenCalledTimes(1);
    expect(updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [99],
      addRules: svc.buildDnrRules([cfg])
    });
  });

  test('allows a later rule update to recover after one update fails', async () => {
    const updateDynamicRules = jest.fn()
      .mockRejectedValueOnce(new Error('invalid runtime rule'))
      .mockResolvedValue(undefined);
    global.chrome = {
      declarativeNetRequest: {
        getDynamicRules: jest.fn(async () => []),
        updateDynamicRules
      }
    };
    const svc = new ConfigService();
    svc.configs = [new Config({
      enabled: true,
      headers: [{ name: 'X-Test', value: '1', type: 'request', enabled: true }]
    })];

    await expect(svc.updateNetworkRules()).rejects.toThrow('invalid runtime rule');
    await expect(svc.updateNetworkRules()).resolves.toBeUndefined();
    expect(updateDynamicRules).toHaveBeenCalledTimes(2);
  });

  test('removes only changed rules after a failed atomic update', async () => {
    const svc = new ConfigService();
    const first = new Config({
      id: 'profile_first',
      enabled: true,
      headers: [{ name: 'X-First', value: '1', enabled: true }],
      filters: [{ expression: 'first.example.com', enabled: true }]
    });
    const second = new Config({
      id: 'profile_second',
      enabled: true,
      headers: [{ name: 'X-Second', value: '2', enabled: true }],
      filters: [{ expression: 'second.example.com', enabled: true }]
    });
    const existingRules = svc.buildDnrRules([first, second]);
    const firstFilter = first.filters[0];
    first.filters = [{
      ...firstFilter,
      expression: 'changed.example.com'
    }];
    svc.configs = [first, second];

    const updateDynamicRules = jest.fn()
      .mockRejectedValueOnce(new Error('invalid changed rule'))
      .mockResolvedValue(undefined);
    global.chrome = {
      declarativeNetRequest: {
        getDynamicRules: jest.fn(async () => existingRules),
        updateDynamicRules
      }
    };

    await expect(svc.updateNetworkRules()).rejects.toThrow('invalid changed rule');

    expect(updateDynamicRules).toHaveBeenCalledTimes(2);
    expect(updateDynamicRules.mock.calls[0][0].removeRuleIds)
      .toEqual([existingRules[0].id]);
    expect(updateDynamicRules.mock.calls[0][0].addRules).toHaveLength(1);
    expect(updateDynamicRules.mock.calls[1][0])
      .toEqual({ removeRuleIds: [existingRules[0].id] });
  });
});

describe('ConfigService updateNetworkRules', () => {
  afterEach(() => {
    delete global.chrome;
  });

  test('replaces old and new dynamic rules in one atomic call', async () => {
    const updateDynamicRules = jest.fn(async () => {});
    global.chrome = {
      declarativeNetRequest: {
        getDynamicRules: jest.fn(async () => [{ id: 99 }]),
        updateDynamicRules
      }
    };
    const svc = new ConfigService();
    const cfg = new Config({
      id: 'config_atomic',
      enabled: true,
      scope: { type: 'all', value: '' },
      headers: [{ name: 'X-Test', value: 'new', type: 'request', enabled: true }]
    });
    svc.configs = [cfg];

    await svc.updateNetworkRules();

    expect(updateDynamicRules).toHaveBeenCalledTimes(1);
    expect(updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [99],
      addRules: svc.buildDnrRules([cfg])
    });
  });
});
