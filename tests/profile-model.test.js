import { Config } from '../src/shared/models/Config.js';
import { ConfigService } from '../src/shared/services/ConfigService.js';
import {
  buildRequestCondition,
  isAllRequestsMatch,
  normalizeRequestMatch,
  parseRequestExpression,
  RequestFilterLimits,
  requestMatchMatchesUrl
} from '../src/shared/utils/requestFilters.js';

describe('Profile model migration', () => {
  test('migrates the flat config to Profile → Rule → Match → Action storage', () => {
    const profile = new Config({
      id: 'legacy',
      name: 'Legacy',
      enabled: true,
      scope: { type: 'domain', value: 'example.com' },
      headers: [
        {
          name: 'X-Request',
          value: 'request',
          type: 'request',
          enabled: true
        },
        {
          name: 'X-Response',
          value: 'response',
          type: 'response',
          enabled: true
        }
      ]
    });

    const stored = profile.toJSON();
    expect(stored.active).toBe(true);
    expect(stored).not.toHaveProperty('enabled');
    expect(stored).not.toHaveProperty('headers');
    expect(stored.rules).toHaveLength(1);
    expect(stored.rules[0].requestMatches[0].expression).toBe('*.example.com');
    expect(stored.rules[0].actions.map(action => action.type)).toEqual([
      'requestHeader',
      'responseHeader'
    ]);
  });

  test('uses allRequests until an enabled valid Filter has entered content', () => {
    const profile = new Config({ headers: [] });
    expect(isAllRequestsMatch(profile.primaryRule.requestMatches[0])).toBe(true);

    profile.filters = [{ expression: '', enabled: true }];
    expect(profile.filters).toHaveLength(1);
    expect(profile.primaryRule.requestMatches.some(isAllRequestsMatch)).toBe(true);

    profile.filters = [{ expression: '/^(a+)+$/', enabled: true }];
    expect(profile.filters).toHaveLength(1);
    expect(profile.primaryRule.requestMatches.some(isAllRequestsMatch)).toBe(true);

    profile.filters = [
      { expression: '', enabled: true },
      { expression: 'api.example.com', enabled: false }
    ];
    expect(profile.primaryRule.requestMatches).toHaveLength(3);
    expect(profile.primaryRule.requestMatches.some(isAllRequestsMatch)).toBe(true);

    profile.filters = [
      { expression: 'api.example.com', enabled: false },
      { expression: 'staging.example.com', enabled: true }
    ];
    expect(profile.primaryRule.requestMatches).toHaveLength(2);
    expect(profile.primaryRule.requestMatches.some(isAllRequestsMatch)).toBe(false);

    profile.filters = [];
    expect(profile.primaryRule.requestMatches).toHaveLength(1);
    expect(isAllRequestsMatch(profile.primaryRule.requestMatches[0])).toBe(true);
  });

  test('duplicates nested IDs and keeps the duplicate active', () => {
    const source = new Config({
      name: 'Source',
      active: false,
      headers: [{ name: 'X-Test', value: '1', enabled: true }],
      filters: [{ expression: '*.example.com', enabled: true }]
    });
    const duplicate = Config.duplicate(source, 'Source copy');

    expect(duplicate.active).toBe(true);
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.primaryRule.id).not.toBe(source.primaryRule.id);
    expect(duplicate.headers[0].id).not.toBe(source.headers[0].id);
    expect(duplicate.filters[0].id).not.toBe(source.filters[0].id);
  });

  test('activates and selects newly created and duplicated Profiles', async () => {
    const service = new ConfigService();
    service.storage = { set: jest.fn(async () => {}) };
    service.configs = [new Config({
      name: 'Default',
      active: true,
      headers: [{ name: 'X-Test', value: '1', enabled: true }]
    })];
    service.popupState = {
      selectedProfileId: service.configs[0].id,
      profileModeActivated: false
    };

    const created = await service.createProfile();
    expect(service.configs[0].name).toBe('Profile 1');
    expect(created.active).toBe(true);
    expect(service.popupState.selectedProfileId).toBe(created.id);

    created.active = false;
    const duplicate = await service.duplicateConfig(created.id);
    expect(duplicate.active).toBe(true);
    expect(service.popupState.selectedProfileId).toBe(duplicate.id);
  });
});

describe('Request Filter matching and compilation', () => {
  test('keeps popup matching consistent for host, wildcard, URL, and regex filters', () => {
    const cases = [
      ['api.example.com', 'https://api.example.com/v1', true],
      ['api.example.com', 'https://www.example.com/v1', false],
      ['*.example.com', 'https://example.com/v1', true],
      ['*.example.com', 'https://api.example.com/v1', true],
      ['https://api.example.com/v1/*', 'https://api.example.com/v1/users', true],
      ['^https://api\\.example\\.com/v[0-9]+/', 'https://api.example.com/v2/users', true]
    ];

    cases.forEach(([expression, url, expected]) => {
      expect(requestMatchMatchesUrl(
        normalizeRequestMatch({ expression }),
        url
      )).toBe(expected);
    });
  });

  test('matches real-world VibeHeader and Google URL regex cases', () => {
    const cases = [
      {
        expression: '^https://([a-z0-9-]+\\.)*vibeheader\\.com(/|$)',
        matches: [
          'https://vibeheader.com/',
          'https://vibeheader.com/s',
          'https://docs.vibeheader.com/guide',
          'https://api.vibeheader.com/v1/profile'
        ],
        misses: [
          'https://vibeheader.com.evil.com/',
          'https://google.com/'
        ]
      },
      {
        expression: '^https://www\\.google\\.com/search(\\?|$)',
        matches: [
          'https://www.google.com/search?q=vibeheader',
          'https://www.google.com/search?q=chrome+extension&hl=en'
        ],
        misses: [
          'https://www.google.com/',
          'https://mail.google.com/',
          'https://www.google.com/maps'
        ]
      },
      {
        expression: '^https://www\\.google\\.(com|com\\.hk|co\\.uk)(/|$)',
        matches: [
          'https://www.google.com/',
          'https://www.google.com.hk/search?q=vibeheader',
          'https://www.google.co.uk/search?q=headers'
        ],
        misses: [
          'https://mail.google.com/',
          'https://www.google.co.jp/'
        ]
      },
      {
        expression: '^https://(www\\.)?(vibeheader\\.com|google\\.com)(/|$)',
        matches: [
          'https://vibeheader.com/',
          'https://www.vibeheader.com/',
          'https://google.com/',
          'https://www.google.com/search?q=vibeheader'
        ],
        misses: [
          'https://docs.vibeheader.com/',
          'https://mail.google.com/',
          'https://github.com/'
        ]
      },
      {
        expression: '^https://vibeheader\\.com/.*\\.(js|css|png)(\\?|$)',
        matches: [
          'https://vibeheader.com/assets/app.js',
          'https://vibeheader.com/styles/main.css',
          'https://vibeheader.com/logo.png?v=2'
        ],
        misses: [
          'https://vibeheader.com/',
          'https://vibeheader.com/api/profile',
          'https://cdn.vibeheader.com/app.js'
        ]
      }
    ];

    cases.forEach(({ expression, matches, misses }) => {
      const filter = normalizeRequestMatch({ expression });
      expect(filter.validation.valid).toBe(true);
      matches.forEach(url => {
        expect(requestMatchMatchesUrl(filter, url)).toBe(true);
      });
      misses.forEach(url => {
        expect(requestMatchMatchesUrl(filter, url)).toBe(false);
      });
    });
  });

  test('compiles enabled Filters with OR semantics and excludes disabled Filters', () => {
    const service = new ConfigService();
    const profile = new Config({
      active: true,
      headers: [{ name: 'X-Test', value: '1', enabled: true }],
      filters: [
        { expression: 'api.example.com', enabled: true },
        { expression: '*.internal.example.com', enabled: true },
        { expression: 'off.example.com', enabled: false }
      ]
    });

    const rules = service.buildDnrRules([profile]);
    expect(rules).toHaveLength(2);
    expect(rules.every(rule => rule.action.requestHeaders[0].header === 'X-Test'))
      .toBe(true);
  });

  test('applies to all requests when every Filter is disabled', () => {
    const service = new ConfigService();
    const profile = new Config({
      active: true,
      headers: [{ name: 'X-Test', value: '1', enabled: true }],
      filters: [
        { expression: 'api.example.com', enabled: false },
        { expression: '*.internal.example.com', enabled: false }
      ]
    });

    const rules = service.buildDnrRules([profile]);
    expect(rules).toHaveLength(1);
    expect(rules[0].condition).not.toHaveProperty('regexFilter');
  });

  test('keeps applying to all requests while the only Filter is blank', () => {
    const service = new ConfigService();
    const profile = new Config({
      active: true,
      headers: [{ name: 'X-Test', value: '1', enabled: true }],
      filters: [{ expression: '', enabled: true }]
    });

    const rules = service.buildDnrRules([profile]);
    expect(rules).toHaveLength(1);
    expect(rules[0].condition).not.toHaveProperty('regexFilter');
  });
});

describe('Request Filter safety limits', () => {
  test('rejects abnormal length, wildcard count, and risky regex features', () => {
    expect(parseRequestExpression(
      'a'.repeat(RequestFilterLimits.MAX_EXPRESSION_LENGTH + 1)
    )).toEqual(expect.objectContaining({
      valid: false,
      reason: expect.stringContaining('1024')
    }));

    expect(parseRequestExpression(
      `^${'a'.repeat(RequestFilterLimits.MAX_REGEX_LENGTH)}`
    )).toEqual(expect.objectContaining({
      valid: false,
      reason: expect.stringContaining('512')
    }));

    expect(parseRequestExpression(
      `api${'*x'.repeat(RequestFilterLimits.MAX_WILDCARDS + 1)}.example.com`
    )).toEqual(expect.objectContaining({
      valid: false,
      reason: expect.stringContaining('32')
    }));

    expect(parseRequestExpression('/^(a+)+$/')).toEqual(expect.objectContaining({
      valid: false,
      reason: 'Regex contains a repeated nested pattern'
    }));
    expect(parseRequestExpression('^https://(?!evil)')).toEqual(expect.objectContaining({
      valid: false,
      reason: 'Regex lookaround is not supported'
    }));
    expect(parseRequestExpression('/^(a+)\\1$/')).toEqual(expect.objectContaining({
      valid: false,
      reason: 'Regex backreferences are not supported'
    }));
  });

  test('keeps common grouped URL regex valid', () => {
    expect(parseRequestExpression(
      '^https://([a-z0-9-]+\\.)*example\\.com/'
    )).toEqual(expect.objectContaining({
      valid: true,
      kind: 'regex'
    }));
  });

  test('classifies the reviewed ReDoS regression corpus without broad false positives', () => {
    const blocked = [
      '^(a+)+$',
      '^(a*)*$',
      '^(a+)*$',
      '^(a|a)+$',
      '^(a|aa)+$',
      '^([a-zA-Z]+)*$',
      '^(([a-z])+.)+[A-Z]([a-z])+$',
      '^([a-zA-Z0-9])(([\\-.]|[_]+)?([a-zA-Z0-9]+))*'
        + '(@){1}[a-z0-9]+[.]{1}(([a-z]{2,3})|'
        + '([a-z]{2,3}[.]{1}[a-z]{2,3}))$',
      '^(a{1,100}){1,100}$',
      '(a?){50}a{50}',
      '^(([a-z])+)+$',
      '(x+x+)+y'
    ];

    blocked.forEach(expression => {
      expect(parseRequestExpression(expression)).toEqual(
        expect.objectContaining({ valid: false })
      );
    });

    expect(parseRequestExpression('^(a|ab)*c$')).toEqual(
      expect.objectContaining({
        valid: true,
        kind: 'regex'
      })
    );
  });

  test('keeps a timed-out Filter as an invalid draft and omits its rule', () => {
    const match = normalizeRequestMatch({
      expression: '^https://api\\.example\\.com/',
      runtimeValidationReason: 'Filter is too complex to test safely'
    });

    expect(match.validation).toEqual({
      valid: false,
      reason: 'Filter is too complex to test safely'
    });
    expect(buildRequestCondition(match, ['xmlhttprequest'])).toBeNull();
    expect(requestMatchMatchesUrl(match, 'https://api.example.com/users'))
      .toBe(false);
  });
});
