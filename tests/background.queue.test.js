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
    addConfig: jest.fn(async data => data),
    updateConfig: jest.fn(async (_id, data) => data),
    toggleConfig: jest.fn(async (_id, enabled) => ({ enabled })),
    updateNetworkRules: jest.fn(async () => {}),
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
});
