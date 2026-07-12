import { Config } from '../src/shared/models/Config.js';
import { ConfigService } from '../src/shared/services/ConfigService.js';

const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest'];

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
    expect(rules[0].condition).toEqual({ requestDomains: ['example.com'], resourceTypes: RESOURCE_TYPES });
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
    expect(rules[0].condition).toEqual({ urlFilter: 'https://api.example.com/v1/*', resourceTypes: RESOURCE_TYPES });
  });

  test('skips disabled headers and empty names', () => {
    const svc = new ConfigService();
    const cfg = new Config({
      name: 'mixed',
      enabled: true,
      scope: { type: 'domain', value: 'example.com' },
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
