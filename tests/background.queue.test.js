import { BackgroundService } from '../src/background/BackgroundService.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeConfigService(overrides = {}) {
  return {
    init: jest.fn(async () => {}),
    getAllConfigs: jest.fn(() => []),
    addConfig: jest.fn(async data => ({ id: 'imported-profile', ...data })),
    importConfig: jest.fn(async data => ({ id: 'imported-profile', ...data })),
    updateConfig: jest.fn(async (_id, data) => data),
    toggleConfig: jest.fn(async (_id, enabled) => ({ enabled })),
    updateNetworkRules: jest.fn(async () => {}),
    assertRequestMatchesSupported: jest.fn(async () => {}),
    selectProfile: jest.fn(async id => ({ selectedProfileId: id, profiles: [] })),
    loadConfigs: jest.fn(async () => {}),
    ...overrides
  };
}

afterEach(() => {
  delete global.chrome;
  jest.restoreAllMocks();
});

describe('BackgroundService config task queue', () => {
  test('registers message listeners before async storage initialization finishes', async () => {
    const initialization = deferred();
    const configService = makeConfigService({
      init: jest.fn(() => initialization.promise)
    });
    const service = new BackgroundService(configService);
    service.setupEventListeners = jest.fn();
    service.updateActionState = jest.fn(async () => {});

    const start = service.init();
    expect(service.setupEventListeners).toHaveBeenCalledTimes(1);

    initialization.resolve();
    await start;
  });

  test('runs tasks strictly in enqueue order', async () => {
    const service = new BackgroundService(makeConfigService());
    const releaseFirst = deferred();
    const events = [];

    const first = service.enqueueConfigTask(async () => {
      events.push('first:start');
      await releaseFirst.promise;
      events.push('first:end');
    });
    const second = service.enqueueConfigTask(async () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  test('continues after one task fails', async () => {
    const service = new BackgroundService(makeConfigService());
    const failed = service.enqueueConfigTask(async () => {
      throw new Error('expected failure');
    });
    const next = service.enqueueConfigTask(async () => 'ok');

    await expect(failed).rejects.toThrow('expected failure');
    await expect(next).resolves.toBe('ok');
  });

  test('uses getConfigs as a barrier behind a pending update', async () => {
    const releaseUpdate = deferred();
    const configService = makeConfigService({
      updateConfig: jest.fn(async () => {
        await releaseUpdate.promise;
        return { id: 'config_test', enabled: true, headers: [] };
      }),
      getAllConfigs: jest.fn(() => [
        { id: 'config_test', enabled: true, headers: [] }
      ])
    });
    const service = new BackgroundService(configService);
    service.readyPromise = Promise.resolve();
    service.updateActionState = jest.fn(async () => {});

    const responses = [];
    const update = service.handleMessage({
      action: 'updateConfig',
      data: { id: 'config_test', config: { headers: [] } }
    }, {}, response => responses.push(['update', response]));
    const read = service.handleMessage({
      action: 'getConfigs'
    }, {}, response => responses.push(['read', response]));

    await Promise.resolve();
    expect(configService.getAllConfigs).not.toHaveBeenCalled();

    releaseUpdate.resolve();
    await Promise.all([update, read]);

    expect(responses.map(([type]) => type)).toEqual(['update', 'read']);
    expect(responses[1][1].data[0].id).toBe('config_test');
  });

  test('uses local defaults for unnamed imports and plain suffixes for named conflicts', () => {
    const configService = makeConfigService({
      getAllConfigs: jest.fn(() => [
        { name: 'Profile 1' },
        { name: 'Staging' },
        { name: 'Staging 2' }
      ])
    });
    const service = new BackgroundService(configService);

    expect(service.importedProfileName()).toBe('Profile 2');
    expect(service.importedProfileName('Production')).toBe('Production');
    expect(service.importedProfileName('Staging')).toBe('Staging 3');
    expect(service.importedProfileName('Profile 1')).toBe('Profile 2');
  });

  test('does not treat the single replaceable Profile as a name conflict', () => {
    const configService = makeConfigService({
      getAllConfigs: jest.fn(() => [
        { id: 'empty-profile', name: 'My empty Profile' }
      ]),
      replaceableEmptyProfile: jest.fn(() => ({ id: 'empty-profile' }))
    });
    const service = new BackgroundService(configService);

    expect(service.importedProfileName('My empty Profile'))
      .toBe('My empty Profile');
    expect(service.importedProfileName()).toBe('Profile 1');
  });

  test('imports a v2 share as a new active Profile with its Filters', async () => {
    const configService = makeConfigService({
      getAllConfigs: jest.fn(() => [{ name: 'Existing' }])
    });
    const service = new BackgroundService(configService);
    service.updateActionState = jest.fn(async () => {});

    await service.importSharedProfile({
      v: 2,
      kind: 'profile',
      profile: {
        suggestedName: 'Staging',
        headers: [{ name: 'X-Test', value: '1', enabled: true }],
        requestScope: {
          type: 'filtered',
          filters: [{ expression: '*.example.com', enabled: true }]
        }
      }
    });

    expect(configService.importConfig).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Staging',
      active: true,
      headers: [expect.objectContaining({ name: 'X-Test', enabled: true })],
      filters: [expect.objectContaining({
        expression: '*.example.com',
        enabled: true
      })]
    }));
    expect(configService.updateNetworkRules).toHaveBeenCalledTimes(1);
  });

  test('imports the compact v2 Profile share format', async () => {
    const configService = makeConfigService({
      getAllConfigs: jest.fn(() => [{ name: 'Existing' }])
    });
    const service = new BackgroundService(configService);
    service.updateActionState = jest.fn(async () => {});

    await service.importSharedProfile({
      v: 2,
      n: 'Profile 1',
      h: [
        ['x-vibe-env', 'local-test'],
        ['x-vibe-param', 'true']
      ],
      f: [
        ['www.google.com.hk', true],
        ['*.vibeheader.com', false]
      ]
    });

    expect(configService.importConfig).toHaveBeenCalledWith({
      name: 'Profile 1',
      active: true,
      headers: [
        expect.objectContaining({ name: 'x-vibe-env', value: 'local-test' }),
        expect.objectContaining({ name: 'x-vibe-param', value: 'true' })
      ],
      filters: [
        expect.objectContaining({
          expression: 'www.google.com.hk',
          enabled: true
        }),
        expect.objectContaining({
          expression: '*.vibeheader.com',
          enabled: false
        })
      ]
    });
    expect(configService.selectProfile)
      .toHaveBeenCalledWith('imported-profile');
  });

  test('assigns the next local default name to a legacy unnamed import', async () => {
    const configService = makeConfigService({
      getAllConfigs: jest.fn(() => [{ name: 'Profile 1' }])
    });
    const service = new BackgroundService(configService);
    service.updateActionState = jest.fn(async () => {});

    await service.importSharedProfile({
      v: 2,
      n: '',
      h: [['X-Test', '1']],
      f: []
    });

    expect(configService.importConfig).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Profile 2' })
    );
  });

  test('rejects oversized shared Profiles before persistence', async () => {
    const configService = makeConfigService();
    const service = new BackgroundService(configService);

    await expect(service.importSharedProfile({
      v: 2,
      n: 'Oversized',
      h: [['X-Test', 'x'.repeat(128 * 1024)]],
      f: []
    })).rejects.toThrow('128KB or smaller');
    expect(configService.importConfig).not.toHaveBeenCalled();
  });

  test('rejects shared Profiles above the Filter count limit', async () => {
    const configService = makeConfigService();
    const service = new BackgroundService(configService);

    await expect(service.importSharedProfile({
      v: 2,
      n: 'Too many filters',
      h: [['X-Test', '1']],
      f: Array.from({ length: 101 }, (_, index) => [
        `api-${index}.example.com`,
        true
      ])
    })).rejects.toThrow('up to 100 filters');
    expect(configService.importConfig).not.toHaveBeenCalled();
  });

  test('checks Chrome regex support before importing', async () => {
    const configService = makeConfigService({
      assertRequestMatchesSupported: jest.fn(async () => {
        throw new Error('Regex is not supported by Chrome');
      })
    });
    const service = new BackgroundService(configService);

    await expect(service.importSharedProfile({
      v: 2,
      n: 'Unsupported',
      h: [['X-Test', '1']],
      f: [['^https://api\\.example\\.com/', true]]
    })).rejects.toThrow('not supported by Chrome');
    expect(configService.importConfig).not.toHaveBeenCalled();
  });

  test('opens the popup after import without turning popup failure into import failure', async () => {
    const configService = makeConfigService();
    const service = new BackgroundService(configService);
    service.updateActionState = jest.fn(async () => {});
    const openPopup = jest.fn(async () => {
      throw new Error('Popup unavailable');
    });
    global.chrome = { action: { openPopup } };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const sendResponse = jest.fn();

    await service.handleMessage({
      action: 'importSharedProfile',
      data: {
        v: 2,
        n: 'Imported Profile',
        h: [['X-Test', '1']],
        f: []
      }
    }, {}, sendResponse);

    expect(configService.selectProfile)
      .toHaveBeenCalledWith('imported-profile');
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        id: 'imported-profile',
        active: true
      })
    }));
    expect(openPopup).toHaveBeenCalledTimes(1);
  });
});
