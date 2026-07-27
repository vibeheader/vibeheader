import {
  createAllRequestsMatch,
  ensureRequestMatches,
  getUserRequestMatches,
  normalizeRequestMatch
} from '../utils/requestFilters.js';

export const PROFILE_SCHEMA_VERSION = 2;

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeHeaderAction(data = {}) {
  const responseHeader = data.type === 'response'
    || data.type === 'responseHeader';
  return {
    id: data.id || makeId('action'),
    type: responseHeader ? 'responseHeader' : 'requestHeader',
    operation: data.operation || 'set',
    name: String(data.name || ''),
    value: String(data.value ?? ''),
    enabled: data.enabled !== false
  };
}

function legacyScopeMatches(scope) {
  if (!scope || scope.type === 'all') {
    return [createAllRequestsMatch()];
  }
  if (scope.type === 'domain' && scope.value) {
    return [normalizeRequestMatch({
      expression: `*.${String(scope.value).replace(/^\*\./, '')}`,
      enabled: true
    })];
  }
  if ((scope.type === 'url_prefix' || scope.type === 'prefix') && scope.value) {
    const value = String(scope.value);
    return [normalizeRequestMatch({
      expression: value.endsWith('*') ? value : `${value}*`,
      enabled: true
    })];
  }
  return [createAllRequestsMatch()];
}

function normalizeRule(rule = {}, fallback = {}) {
  const rawActions = Array.isArray(rule.actions)
    ? rule.actions.filter(action =>
      action?.type === 'requestHeader' || action?.type === 'responseHeader'
    )
    : (fallback.headers || []);

  let rawMatches;
  if (Array.isArray(rule.requestMatches)) {
    rawMatches = rule.requestMatches;
  } else if (Array.isArray(fallback.filters) && fallback.filters.length) {
    rawMatches = fallback.filters;
  } else {
    rawMatches = legacyScopeMatches(fallback.scope);
  }

  return {
    id: rule.id || makeId('rule'),
    name: String(rule.name || ''),
    enabled: rule.enabled !== false,
    requestMatches: ensureRequestMatches(rawMatches),
    actions: rawActions.map(normalizeHeaderAction)
  };
}

/**
 * Canonical Profile model.
 *
 * The popup exposes one implicit rule as Headers + Filters, while storage keeps
 * the extensible Profile -> Rule -> Match -> Action shape.
 */
export class Config {
  constructor(data = {}) {
    this.schemaVersion = PROFILE_SCHEMA_VERSION;
    this.id = data.id || makeId('profile');
    this.name = String(data.name || 'Default');
    this.active = typeof data.active === 'boolean' ? data.active : !!data.enabled;
    this.pageMatches = Array.isArray(data.pageMatches)
      ? data.pageMatches.map(normalizeRequestMatch)
      : [];
    this.rules = Array.isArray(data.rules) && data.rules.length
      ? data.rules.map(rule => normalizeRule(rule))
      : [normalizeRule({}, data)];
    this.createdAt = data.createdAt || Date.now();
    this.updatedAt = data.updatedAt || Date.now();
  }

  get enabled() {
    return this.active;
  }

  set enabled(value) {
    this.active = !!value;
  }

  get primaryRule() {
    if (!this.rules.length) this.rules.push(normalizeRule());
    return this.rules[0];
  }

  get headers() {
    return this.primaryRule.actions
      .filter(action =>
        action.type === 'requestHeader' || action.type === 'responseHeader'
      )
      .map(action => ({
        id: action.id,
        name: action.name,
        value: action.value,
        enabled: action.enabled,
        type: action.type === 'responseHeader' ? 'response' : 'request'
      }));
  }

  set headers(headers) {
    this.primaryRule.actions = (headers || []).map(normalizeHeaderAction);
    this.updatedAt = Date.now();
  }

  get filters() {
    return getUserRequestMatches(this.primaryRule).map(match => ({ ...match }));
  }

  set filters(filters) {
    this.primaryRule.requestMatches = ensureRequestMatches(filters || []);
    this.updatedAt = Date.now();
  }

  setEnabled(enabled) {
    this.active = !!enabled;
    this.updatedAt = Date.now();
  }

  toJSON() {
    return {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      id: this.id,
      name: this.name,
      active: this.active,
      pageMatches: this.pageMatches.map(match => ({ ...match })),
      rules: this.rules.map(rule => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        requestMatches: rule.requestMatches.map(match => ({ ...match })),
        actions: rule.actions.map(action => ({ ...action }))
      })),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromJSON(data) {
    return new Config(data);
  }

  static duplicate(source, name) {
    const copy = new Config(source instanceof Config ? source.toJSON() : source);
    copy.id = makeId('profile');
    copy.name = name;
    copy.active = true;
    copy.createdAt = Date.now();
    copy.updatedAt = copy.createdAt;
    copy.pageMatches = copy.pageMatches.map(match => ({ ...match, id: makeId('match') }));
    copy.rules = copy.rules.map(rule => ({
      ...rule,
      id: makeId('rule'),
      requestMatches: rule.requestMatches.map(match => ({ ...match, id: makeId('match') })),
      actions: rule.actions.map(action => ({ ...action, id: makeId('action') }))
    }));
    return copy;
  }
}
