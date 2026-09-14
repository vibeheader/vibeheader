import { Config } from '../src/shared/models/Config.js';
import { ConfigService } from '../src/shared/services/ConfigService.js';
import { BackgroundService } from '../src/background/BackgroundService.js';
import { PopupApp } from '../src/popup/PopupApp.js';

const clone = value => JSON.parse(JSON.stringify(value));
const share = profile => PopupApp.prototype.profileSharePayload(profile);

function receiver(existing = new Config({ headers: [] }), showComments) {
  const store = {};
  const service = new ConfigService();
  service.configs = [existing];
  if (typeof showComments === 'boolean') {
    service.popupState.showComments = showComments;
    service.popupState.commentsPreferenceSet = true;
  }
  service.storage = {
    get: jest.fn(async key => clone(store[key] ?? null)),
    set: jest.fn(async (key, value) => { store[key] = clone(value); })
  };
  service.updateNetworkRules = jest.fn(async () => {});
  const background = new BackgroundService(service);
  background.updateActionState = jest.fn(async () => {});
  background.openPopupAfterImport = jest.fn(async () => {});
  return { service, background };
}

function sourceProfile() {
  const profile = new Config({
    name: 'Servers', active: true,
    headers: [
      { id: 'first', name: 'X-Test', value: 'first', comment: '测试服务器\n<b>备用</b>' },
      { id: 'second', name: 'x-test', value: 'winner', comment: '生产服务器 🟢' }
    ],
    filters: [{ expression: '*.example.com', enabled: true },
      { expression: 'localhost:3000', enabled: false }]
  });
  profile.headers = [...profile.headers].reverse();
  return profile;
}

test.each([
  ['replaces the only empty Profile', false, undefined],
  ['adds to an existing Profile', true, undefined],
  ['preserves explicitly hidden Comments', false, false],
  ['preserves already visible Comments', true, true]
])('share/import roundtrip %s without losing notes, natural order, or the last-enabled-wins behavior', async (_label, nonempty, showComments) => {
  const source = sourceProfile();
  const payload = clone(share(source));
  const existing = new Config({ headers: nonempty ? [{ name: 'X-Keep', value: 'keep' }] : [] });
  const { service, background } = receiver(existing, showComments);
  const imported = await background.importSharedProfile(payload);
  expect(service.configs).toHaveLength(nonempty ? 2 : 1);
  expect(imported.id === existing.id).toBe(!nonempty);
  if (nonempty) expect(service.configs[0].headers[0].value).toBe('keep');

  const restored = new ConfigService();
  restored.storage = service.storage;
  await restored.init();
  const profile = restored.getConfigById(imported.id);
  expect(profile.headers.map(header => header.value)).toEqual(['winner', 'first']);
  expect(profile.headers.map(header => header.comment)).toEqual(payload.c);
  expect(profile.primaryRule.actions.map(action => action.value)).toEqual(['winner', 'first']);
  expect(restored.getProfileState().showComments).toBe(showComments !== false);
  expect(profile.active).toBe(true);
  expect(share(profile)).toEqual(payload);
  expect(restored.enabledHeaderActions(profile.primaryRule)).toEqual(
    restored.enabledHeaderActions(source.primaryRule)
  );
  expect(restored.buildDnrRules([profile])[0].action.requestHeaders).toEqual([
    { header: 'X-Test', operation: 'set', value: 'first' }
  ]);
});

test('normalizes multiline shared comments before storing and sharing them again', async () => {
  const payload = {
    v: 2, n: 'Servers', h: [['X-Test', 'keep']], f: [],
    c: ['Staging\r\n\r\nBackup\n<b>QA</b> 🟢']
  };
  const { service, background } = receiver();
  const imported = await background.importSharedProfile(payload);
  const expected = 'Staging Backup <b>QA</b> 🟢';
  expect(imported.headers[0].comment).toBe(expected);
  expect((await service.storage.get('configs'))[0].rules[0].actions[0].comment).toBe(expected);
  expect(share(imported)).toEqual({ ...payload, c: [expected] });
  expect(service.buildDnrRules([imported])[0].action.requestHeaders).toEqual([
    { header: 'X-Test', operation: 'set', value: 'keep' }
  ]);
});

test('omitting comments keeps the same reordered v2 headers, filters, and effective value', async () => {
  const source = sourceProfile();
  const { c, ...oldPayload } = share(source);
  expect(c).toEqual(['生产服务器 🟢', '测试服务器 <b>备用</b>']);
  expect(oldPayload).toEqual({
    v: 2, n: 'Servers', h: [['x-test', 'winner'], ['X-Test', 'first']],
    f: [['*.example.com', true], ['localhost:3000', false]]
  });
  const { service, background } = receiver();
  const imported = await background.importSharedProfile(oldPayload);
  expect(imported.headers.map(header => header.value)).toEqual(['winner', 'first']);
  expect(imported.headers.every(header => header.comment === '')).toBe(true);
  expect(service.enabledHeaderActions(imported.primaryRule)).toEqual(
    service.enabledHeaderActions(source.primaryRule)
  );
  expect(share(imported)).toEqual(oldPayload);
  expect(service.getProfileState().showComments).toBe(false);
});

test.each([undefined, false, true])('legacy Header pair imports keep their order and the local display preference: %s', async showComments => {
  const { service, background } = receiver(undefined, showComments);
  const respond = jest.fn();
  await background.handleMessage({
    action: 'importSharedKV', data: { h: [['X-Test', 'first'], ['x-test', 'winner']] }
  }, {}, respond);
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  expect(service.configs[0].headers.map(header => [header.value, header.comment]))
    .toEqual([['first', ''], ['winner', '']]);
  expect(service.getProfileState().showComments).toBe(showComments === true);
});

test.each([['', ''], [' \t', '\n\u3000']])('blank comments do not reveal Comments or consume the first useful import: %j / %j', async (first, second) => {
  const { service, background } = receiver();
  await background.importSharedProfile({ ...share(sourceProfile()), c: [first, second] });
  expect(service.getProfileState().showComments).toBe(false);
  await background.importSharedProfile(share(sourceProfile()));
  expect(service.getProfileState().showComments).toBe(true);
});

test('turning Comments off after automatic disclosure survives worker reload and later imports', async () => {
  const { service, background } = receiver();
  await background.importSharedProfile(share(sourceProfile()));
  expect(service.getProfileState().showComments).toBe(true);
  await service.setShowComments(false);

  const restored = new ConfigService();
  restored.storage = service.storage;
  restored.updateNetworkRules = jest.fn(async () => {});
  await restored.init();
  const nextBackground = new BackgroundService(restored);
  nextBackground.updateActionState = jest.fn(async () => {});
  const imported = await nextBackground.importSharedProfile(share(sourceProfile()));
  expect(restored.getProfileState().showComments).toBe(false);
  expect(imported.headers.map(header => header.comment)).toEqual(share(sourceProfile()).c);
});

test.each([
  ['no prior Comments setting', {}, true],
  ['an older saved off choice', { showComments: false }, false],
  ['an older saved on choice', { showComments: true }, true],
  ['the new untouched default', { showComments: false, commentsPreferenceSet: false }, true]
])('migrates %s without overriding a saved choice', async (_label, popupState, expected) => {
  const { service, background } = receiver();
  await service.storage.set('popupState', popupState);
  await service.loadPopupState();
  expect(service.getProfileState().showComments).toBe(popupState.showComments === true);
  await background.importSharedProfile(share(sourceProfile()));
  expect(service.getProfileState().showComments).toBe(expected);
});

test.each(['profile storage', 'network rules', 'profile selection', 'Comments storage'])('an import failure at %s does not reveal Comments', async stage => {
  const { service, background } = receiver();
  const write = service.storage.set.getMockImplementation();
  service.storage.set.mockImplementation(async (key, value) => {
    if ((stage === 'profile storage' && key === 'configs')
      || (stage === 'Comments storage' && key === 'popupState' && value.showComments)) {
      throw new Error('Import failed');
    }
    return write(key, value);
  });
  if (stage === 'network rules') service.updateNetworkRules.mockRejectedValue(new Error('Import failed'));
  if (stage === 'profile selection') {
    jest.spyOn(service, 'selectProfile').mockRejectedValue(new Error('Import failed'));
  }
  await expect(background.importSharedProfile(share(sourceProfile()))).rejects.toThrow('Import failed');
  expect(service.getProfileState().showComments).toBe(false);
  expect(service.popupState.commentsPreferenceSet).toBe(false);
  expect((await service.storage.get('popupState'))?.showComments).not.toBe(true);
});

test('sharing keeps comments aligned with reordered rows after omitting disabled and invalid drafts', () => {
  const profile = new Config({ headers: [
    { id: 'a', name: 'X-A', value: '1', comment: 'A' },
    { id: 'off', name: 'X-Off', value: 'off', enabled: false, comment: 'Private draft' },
    { id: 'empty', name: '', value: '', comment: 'Unfinished' },
    { id: 'bad', name: 'X-Bad', value: 'invalid\nvalue' },
    { id: 'b', name: 'X-B', value: '2', comment: 'B' }
  ] });
  profile.headers = [...profile.headers].reverse();
  expect(share(profile)).toEqual({
    v: 2, n: profile.name, h: [['X-B', '2'], ['X-A', '1']], f: [],
    c: ['B', 'A']
  });
});

test('order alone is shared and plain profiles retain the exact old v2 structure', () => {
  const profile = new Config({ name: 'Plain', headers: [
    { name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }
  ] });
  expect(share(profile)).toEqual({ v: 2, n: 'Plain', h: [['X-A', '1'], ['X-B', '2']], f: [] });
  profile.headers = [...profile.headers].reverse();
  expect(share(profile)).toEqual({ v: 2, n: 'Plain', h: [['X-B', '2'], ['X-A', '1']], f: [] });
});

test.each([
  null,
  {},
  'Server note',
  ['', 1],
  ['', null],
  [''],
  ['', '', '']
].map(comments => [comments]))('rejects malformed comments before writing storage: %j', async comments => {
  const { service, background } = receiver();
  await expect(background.importSharedProfile({ ...share(sourceProfile()), c: comments }))
    .rejects.toThrow('Invalid shared Profile comments');
  expect(service.storage.set).not.toHaveBeenCalled();
  expect(service.updateNetworkRules).not.toHaveBeenCalled();
  expect(service.getProfileState().showComments).toBe(false);
});

test('comments count toward the existing payload size limit', async () => {
  const { service, background } = receiver();
  const payload = share(sourceProfile());
  payload.c[0] = '备注'.repeat(30_000);
  await expect(background.importSharedProfile(payload)).rejects.toThrow('128KB');
  expect(service.storage.set).not.toHaveBeenCalled();
});
