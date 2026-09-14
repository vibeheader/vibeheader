import { Config } from '../src/shared/models/Config.js';
import { ConfigService } from '../src/shared/services/ConfigService.js';
import { BackgroundService } from '../src/background/BackgroundService.js';

function sample() {
  return new Config({
    name: 'QA', active: true,
    headers: [
      { id: 'first', name: 'X-Test', value: 'first', comment: 'First test' },
      { id: 'second', name: 'x-test', value: 'winner', comment: 'Second test' },
      { id: 'other', name: 'X-Other', value: 'other', enabled: false }
    ]
  });
}

test('natural sorting survives storage and duplication and the last enabled duplicate still wins', () => {
  const profile = sample();
  const service = new ConfigService();
  const rules = service.buildDnrRules([profile]);
  profile.headers = [...profile.headers].reverse();
  const restored = Config.fromJSON(profile.toJSON());
  expect(restored.headers.map(header => header.id)).toEqual(['other', 'second', 'first']);
  expect(restored.headers.map(header => header.comment)).toEqual(['', 'Second test', 'First test']);
  expect(restored.primaryRule.actions.map(action => action.id)).toEqual(['other', 'second', 'first']);
  expect(restored.toJSON().rules[0].actions.every(action => !('displayOrder' in action))).toBe(true);
  expect(service.buildDnrRules([restored])[0].action.requestHeaders).toEqual([
    { header: 'X-Test', operation: 'set', value: 'first' }
  ]);
  expect(rules[0].action.requestHeaders).toEqual([
    { header: 'x-test', operation: 'set', value: 'winner' }
  ]);
  const duplicate = Config.duplicate(restored, 'Copy');
  expect(duplicate.headers.map(header => header.value)).toEqual(['other', 'winner', 'first']);
  expect(duplicate.headers[2].comment).toBe('First test');
  expect(duplicate.headers[2].id).not.toBe('first');
  expect(service.enabledHeaderActions(duplicate.primaryRule)).toEqual(
    service.enabledHeaderActions(profile.primaryRule)
  );
});

test('edits, additions, and deletion preserve natural order after sorting', () => {
  const profile = sample();
  profile.headers = [...profile.headers].reverse();
  profile.headers = profile.headers.map(header => ({ ...header, comment: 'Updated' }));
  profile.headers = [...profile.headers, { id: 'new', name: 'X-Test', value: 'new winner' }];
  expect(profile.primaryRule.actions.map(action => action.id)).toEqual(['other', 'second', 'first', 'new']);
  profile.headers = profile.headers.filter(header => header.id !== 'second');
  expect(profile.primaryRule.actions.map(action => action.id)).toEqual(['other', 'first', 'new']);
  expect(profile.headers.map(header => header.id)).toEqual(['other', 'first', 'new']);
  const service = new ConfigService();
  expect(service.enabledHeaderActions(profile.primaryRule).requestHeaders[0].value).toBe('new winner');
});

test('moving a frequently used IP before disabled alternatives keeps the same effective value', () => {
  const profile = new Config({ active: true, headers: [
    { id: 'a', name: 'X-Forwarded-For', value: '192.0.2.1', enabled: false, comment: 'Occasional' },
    { id: 'b', name: 'x-forwarded-for', value: '192.0.2.2', enabled: true, comment: 'Frequent' },
    { id: 'c', name: 'X-Forwarded-For', value: '192.0.2.3', enabled: false, comment: 'Backup' }
  ] });
  const service = new ConfigService();
  const rules = service.buildDnrRules([profile]);
  const [a, b, c] = profile.headers;
  profile.headers = [b, a, c];
  const restored = Config.fromJSON(profile.toJSON());
  expect(restored.headers.map(header => [header.id, header.enabled, header.comment])).toEqual([
    ['b', true, 'Frequent'], ['a', false, 'Occasional'], ['c', false, 'Backup']
  ]);
  expect(service.buildDnrRules([restored])).toEqual(rules);
});

test('reordering different Header names keeps all effective values', () => {
  const profile = new Config({ headers: [
    { name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }
  ] });
  profile.headers = [...profile.headers].reverse();
  expect(new ConfigService().enabledHeaderActions(profile.primaryRule).requestHeaders).toEqual([
    { header: 'X-B', operation: 'set', value: '2' },
    { header: 'X-A', operation: 'set', value: '1' }
  ]);
});

test('old profiles retain their order and comments never become request fields', () => {
  const profile = new Config({ rules: [{ actions: [
    { id: 'a', type: 'requestHeader', name: 'X-Test', value: '1', comment: 'local\nnotes' },
    { id: 'b', type: 'requestHeader', name: 'X-Other', value: '2' }
  ] }] });
  expect(profile.headers.map(header => header.id)).toEqual(['a', 'b']);
  expect(profile.headers[1].comment).toBe('');
  expect(new ConfigService().enabledHeaderActions(profile.primaryRule).requestHeaders).toEqual([
    { header: 'X-Test', operation: 'set', value: '1' },
    { header: 'X-Other', operation: 'set', value: '2' }
  ]);
});

test('import does not replace a profile whose only content is a hidden comment', () => {
  const service = new ConfigService();
  service.configs = [new Config({ headers: [{ name: '', value: '', comment: 'Keep this note' }] })];
  expect(service.replaceableEmptyProfile()).toBeNull();
});

test('global Comments preference survives selection, profile deletion, and worker reload', async () => {
  const store = {};
  const storage = {
    set: jest.fn(async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); }),
    get: jest.fn(async key => store[key])
  };
  const service = new ConfigService();
  service.storage = storage;
  service.configs = [sample()];
  expect(service.getProfileState().showComments).toBe(false);
  await service.setShowComments(true);
  await service.selectProfile(service.configs[0].id);
  await service.deleteConfig(service.configs[0].id);
  const restored = new ConfigService();
  restored.storage = storage;
  await restored.init();
  expect(restored.getProfileState().showComments).toBe(true);
  expect(restored.popupState.commentsPreferenceSet).toBe(true);
  expect(restored.configs[0].toJSON()).not.toHaveProperty('showComments');
  expect(restored.configs[0].toJSON()).not.toHaveProperty('commentsPreferenceSet');
});

test('loading, editing, and duplicating existing comments leaves the untouched default hidden', async () => {
  const store = { configs: [sample().toJSON()] };
  const service = new ConfigService();
  service.storage = {
    get: jest.fn(async key => store[key]),
    set: jest.fn(async (key, value) => { store[key] = value; })
  };
  await service.init();
  expect(service.getProfileState().showComments).toBe(false);
  await service.updateConfig(service.configs[0].id, { name: 'Updated' });
  await service.duplicateConfig(service.configs[0].id);
  await service.addConfig(sample().toJSON());
  expect(service.getProfileState().showComments).toBe(false);
  expect(service.popupState.commentsPreferenceSet).toBe(false);
});

test('preference failure restores the prior value and does not rebuild network rules', async () => {
  const service = new ConfigService();
  service.storage = { set: jest.fn(async () => { throw new Error('storage unavailable'); }) };
  service.updateNetworkRules = jest.fn();
  const background = new BackgroundService(service);
  const respond = jest.fn();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await background.handleMessage({ action: 'setShowComments', data: { showComments: true } }, {}, respond);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(service.getProfileState().showComments).toBe(false);
    expect(service.popupState.commentsPreferenceSet).toBe(false);
    expect(service.updateNetworkRules).not.toHaveBeenCalled();
    await expect(service.setShowComments('yes')).rejects.toThrow('boolean');
  } finally {
    jest.restoreAllMocks();
  }
});

test('a failed order save leaves the previous order in the background state', async () => {
  const service = new ConfigService();
  const profile = sample();
  service.configs = [profile];
  service.storage = { set: jest.fn(async () => { throw new Error('storage unavailable'); }) };
  await expect(service.updateConfig(profile.id, { headers: [...profile.headers].reverse() }))
    .rejects.toThrow('storage unavailable');
  expect(service.getConfigById(profile.id).headers.map(header => header.id))
    .toEqual(['first', 'second', 'other']);
});
