import { Config } from '../src/shared/models/Config.js';
import { ConfigService, RESOURCE_TYPES } from '../src/shared/services/ConfigService.js';

describe('ConfigService scope matching (browser tab address)', () => {
  const svc = new ConfigService();

  test('match-all scopes', () => {
    expect(svc.isMatchAllScope({ type: 'all', value: '' })).toBe(true);
    expect(svc.isMatchAllScope({ type: 'regex', value: '*' })).toBe(true);
    expect(svc.isMatchAllScope({ type: 'regex', value: '' })).toBe(true);
    expect(svc.isMatchAllScope({ type: 'regex', value: 'http://localhost' })).toBe(false);
  });

  test('prefix matches SPA tab URL with slash before hash', () => {
    const tabUrl = 'http://localhost:8080/e-static/iov/default/#/iov_dev/iovSimCardManager/iovSimCardInfo';
    const scope = { type: 'regex', value: 'http://localhost:8080/e-static/iov/default/' };
    expect(svc.isUrlMatchingScope(tabUrl, scope)).toBe(true);
  });

  test('prefix matches SPA tab URL without slash before hash', () => {
    // Common SPA form: .../default#/route (no slash before #)
    const tabUrl = 'http://localhost:8080/e-static/iov/default#/iov_dev/iovSimCardManager/iovSimCardInfo';
    const scope = { type: 'regex', value: 'http://localhost:8080/e-static/iov/default/' };
    expect(svc.isUrlMatchingScope(tabUrl, scope)).toBe(true);
  });

  test('prefix without trailing slash still matches', () => {
    const tabUrl = 'http://localhost:8080/e-static/iov/default/#/x';
    const scope = { type: 'regex', value: 'http://localhost:8080/e-static/iov/default' };
    expect(svc.isUrlMatchingScope(tabUrl, scope)).toBe(true);
  });

  test('does not match unrelated paths', () => {
    const scope = { type: 'regex', value: 'http://localhost:8080/e-static/iov/default/' };
    expect(svc.isUrlMatchingScope('http://localhost:8080/other/', scope)).toBe(false);
  });
});

describe('ConfigService buildDnrRules', () => {
  test('match-all rules have no tabIds (apply globally)', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      name: '*',
      enabled: true,
      scope: { type: 'all', value: '' },
      headers: [{ name: 'Authorization', value: 'Bearer 123', type: 'request', enabled: true }]
    });

    const rules = svc.buildDnrRules([cfg]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action.requestHeaders[0]).toEqual({
      header: 'Authorization',
      operation: 'set',
      value: 'Bearer 123'
    });
    expect(rules[0].condition).toEqual({ resourceTypes: RESOURCE_TYPES });
    expect(rules[0].condition.tabIds).toBeUndefined();
    expect(rules[0].action.responseHeaders).toBeUndefined();
  });

  test('patterned rules include tabIds so SPA API calls from that tab get headers', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      name: 'localhost',
      enabled: true,
      scope: { type: 'regex', value: 'http://localhost:8080/e-static/' },
      headers: [{ name: 'X-Token', value: 'abc', type: 'request', enabled: true }]
    });

    const rules = svc.buildDnrRules([cfg], { tabIds: [42, 7] });
    expect(rules).toHaveLength(1);
    expect(rules[0].condition).toEqual({
      resourceTypes: RESOURCE_TYPES,
      tabIds: [42, 7]
    });
    expect(rules[0].condition.regexFilter).toBeUndefined();
    expect(rules[0].condition.urlFilter).toBeUndefined();
  });

  test('defaults missing header type to request', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      name: 'legacy',
      enabled: true,
      scope: { type: 'all', value: '' },
      headers: [{ name: 'X-A', value: '1', enabled: true }]
    });

    const rules = svc.buildDnrRules([cfg]);
    expect(rules[0].action.requestHeaders[0].header).toBe('X-A');
    expect(rules[0].action.responseHeaders).toBeUndefined();
  });

  test('skips disabled headers and empty names', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      name: 'mixed',
      enabled: true,
      scope: { type: 'all', value: '' },
      headers: [
        { name: 'A', value: 'a', type: 'request', enabled: false },
        { name: '', value: 'x', type: 'request', enabled: true },
        { name: 'B', value: 'b', type: 'request', enabled: true }
      ]
    });

    const rules = svc.buildDnrRules([cfg]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action.requestHeaders[0]).toEqual({ header: 'B', operation: 'set', value: 'b' });
  });
});
