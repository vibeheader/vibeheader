import { Config } from '../models/Config.js';
import { StorageService } from '../utils/storage.js';
import {
  buildRequestCondition,
  createAllRequestsMatch,
  isAllRequestsMatch,
  RequestFilterLimits,
  normalizeRequestMatch
} from '../utils/requestFilters.js';
import { ValidationUtils } from '../utils/validation.js';

const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest'];
const DEFAULT_POPUP_STATE = {
  selectedProfileId: '',
  profileModeActivated: false
};

function stableRuleId(parts, usedIds) {
  const value = parts.join('\u0000');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  let id = (hash >>> 0) & 0x7fffffff;
  if (id === 0) id = 1;
  while (usedIds.has(id)) {
    id = id === 0x7fffffff ? 1 : id + 1;
  }
  usedIds.add(id);
  return id;
}

function sameRule(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Owns Profile persistence and compiles the implicit Rule in each Profile to
 * declarativeNetRequest rules.
 */
export class ConfigService {
  constructor() {
    this.storage = new StorageService();
    this.configs = [];
    this.popupState = { ...DEFAULT_POPUP_STATE };
    this._ruleUpdatePromise = Promise.resolve();
  }

  async init() {
    await Promise.all([this.loadConfigs(), this.loadPopupState()]);
    await this.ensurePopupState();
  }

  async loadConfigs() {
    try {
      const data = await this.storage.get('configs');
      this.configs = (Array.isArray(data) ? data : []).map(configData =>
        Config.fromJSON(configData)
      );
      // Loading legacy configs is also the migration boundary. The next write
      // persists the canonical Profile -> Rule -> Match -> Action structure.
    } catch (error) {
      console.error('Failed to load profiles:', error);
      this.configs = [];
    }
  }

  async loadPopupState() {
    try {
      const state = await this.storage.get('popupState');
      this.popupState = {
        ...DEFAULT_POPUP_STATE,
        ...(state && typeof state === 'object' ? state : {})
      };
    } catch (error) {
      console.error('Failed to load popup state:', error);
      this.popupState = { ...DEFAULT_POPUP_STATE };
    }
  }

  async ensurePopupState() {
    if (!this.configs.length) {
      this.popupState.selectedProfileId = '';
      return;
    }
    if (!this.getConfigById(this.popupState.selectedProfileId)) {
      this.popupState.selectedProfileId = this.configs[0].id;
      await this.savePopupState();
    }
    if (this.configs.length > 1 && !this.popupState.profileModeActivated) {
      this.popupState.profileModeActivated = true;
      await this.savePopupState();
    }
  }

  async saveConfigs() {
    const configsData = this.configs.map(config => config.toJSON());
    await this.storage.set('configs', configsData);
  }

  async savePopupState() {
    await this.storage.set('popupState', { ...this.popupState });
  }

  getAllConfigs() {
    return this.configs;
  }

  getProfileState() {
    return {
      profiles: this.configs,
      selectedProfileId: this.popupState.selectedProfileId,
      profileModeActivated: !!this.popupState.profileModeActivated
    };
  }

  getConfigById(id) {
    return this.configs.find(config => config.id === id);
  }

  assertProfileFilterLimit(config) {
    const count = (config.rules || []).reduce((total, rule) =>
      total + (rule.requestMatches || []).filter(match =>
        !isAllRequestsMatch(match)
      ).length, 0);
    if (count > RequestFilterLimits.MAX_FILTERS_PER_PROFILE) {
      throw new Error(
        `A Profile can use up to ${RequestFilterLimits.MAX_FILTERS_PER_PROFILE} filters`
      );
    }
  }

  async addConfig(configData) {
    const config = new Config(configData);
    this.assertProfileFilterLimit(config);
    this.configs.push(config);
    if (!this.popupState.selectedProfileId) {
      this.popupState.selectedProfileId = config.id;
    }
    if (this.configs.length > 1) {
      this.popupState.profileModeActivated = true;
    }
    await Promise.all([this.saveConfigs(), this.savePopupState()]);
    return config;
  }

  replaceableEmptyProfile() {
    if (this.configs.length !== 1) return null;

    const profile = this.configs[0];
    const hasHeaderContent = (profile.rules || []).some(rule =>
      (rule.actions || []).some(action =>
        String(action?.name || '').trim()
        || String(action?.value || '')
      )
    );
    const hasFilterContent = (profile.rules || []).some(rule =>
      (rule.requestMatches || []).some(match =>
        !isAllRequestsMatch(match)
        && String(match?.expression || '').trim()
      )
    );
    const hasPageMatchContent = (profile.pageMatches || []).some(match =>
      String(match?.expression || '').trim()
    );

    return hasHeaderContent || hasFilterContent || hasPageMatchContent
      ? null
      : profile;
  }

  async importConfig(configData) {
    const replaceable = this.replaceableEmptyProfile();
    if (!replaceable) return this.addConfig(configData);

    const imported = await this.updateConfig(replaceable.id, configData);
    this.popupState.selectedProfileId = imported.id;
    await this.savePopupState();
    return imported;
  }

  async updateConfig(id, configData) {
    const configIndex = this.configs.findIndex(config => config.id === id);
    if (configIndex === -1) throw new Error('Profile not found');

    const current = this.configs[configIndex];
    const merged = new Config({
      ...current.toJSON(),
      ...configData,
      id: current.id,
      active: typeof configData.active === 'boolean'
        ? configData.active
        : (typeof configData.enabled === 'boolean' ? configData.enabled : current.active)
    });

    // Compatibility for callers that still patch the old flat fields.
    if (Array.isArray(configData.headers)) merged.headers = configData.headers;
    if (Array.isArray(configData.filters)) merged.filters = configData.filters;

    this.assertProfileFilterLimit(merged);
    merged.updatedAt = Date.now();
    this.configs[configIndex] = merged;
    await this.saveConfigs();
    return merged;
  }

  async toggleConfig(id, active) {
    const config = this.getConfigById(id);
    if (!config) throw new Error('Profile not found');

    config.setEnabled(active);
    await this.saveConfigs();
    return config;
  }

  nextProfileName() {
    const existing = new Set(this.configs.map(config => config.name.trim().toLowerCase()));
    let index = 1;
    while (existing.has(`profile ${index}`)) index += 1;
    return `Profile ${index}`;
  }

  duplicateName(sourceName) {
    const existing = new Set(this.configs.map(config => config.name.trim().toLowerCase()));
    const base = `${sourceName} copy`;
    if (!existing.has(base.toLowerCase())) return base;
    let index = 2;
    while (existing.has(`${base} ${index}`.toLowerCase())) index += 1;
    return `${base} ${index}`;
  }

  async createProfile() {
    if (this.configs.length === 1
      && !this.popupState.profileModeActivated
      && this.configs[0].name === 'Default') {
      this.configs[0].name = 'Profile 1';
    }

    const profile = new Config({
      name: this.nextProfileName(),
      active: true,
      rules: [{
        name: '',
        enabled: true,
        requestMatches: [createAllRequestsMatch()],
        actions: []
      }]
    });
    this.configs.push(profile);
    this.popupState.selectedProfileId = profile.id;
    this.popupState.profileModeActivated = true;
    await Promise.all([this.saveConfigs(), this.savePopupState()]);
    return profile;
  }

  async duplicateConfig(id) {
    const source = this.getConfigById(id);
    if (!source) throw new Error('Profile not found');

    if (this.configs.length === 1
      && !this.popupState.profileModeActivated
      && source.name === 'Default') {
      source.name = 'Profile 1';
    }

    const profile = Config.duplicate(source, this.duplicateName(source.name));
    this.configs.push(profile);
    this.popupState.selectedProfileId = profile.id;
    this.popupState.profileModeActivated = true;
    await Promise.all([this.saveConfigs(), this.savePopupState()]);
    return profile;
  }

  async deleteConfig(id) {
    const index = this.configs.findIndex(config => config.id === id);
    if (index === -1) throw new Error('Profile not found');

    const [deleted] = this.configs.splice(index, 1);
    if (!this.configs.length) {
      const replacement = new Config({
        name: 'Default',
        active: false,
        rules: [{
          name: '',
          enabled: true,
          requestMatches: [createAllRequestsMatch()],
          actions: []
        }]
      });
      this.configs.push(replacement);
      this.popupState.selectedProfileId = replacement.id;
      this.popupState.profileModeActivated = false;
    } else if (this.popupState.selectedProfileId === id) {
      this.popupState.selectedProfileId =
        this.configs[Math.min(index, this.configs.length - 1)].id;
    }

    await Promise.all([this.saveConfigs(), this.savePopupState()]);
    return deleted;
  }

  async selectProfile(id) {
    if (!this.getConfigById(id)) throw new Error('Profile not found');
    this.popupState.selectedProfileId = id;
    await this.savePopupState();
    return this.getProfileState();
  }

  getEnabledConfigs() {
    return this.configs.filter(config => config.active);
  }

  enabledHeaderActions(rule) {
    const requestByName = new Map();
    const responseByName = new Map();
    (rule.actions || []).forEach(action => {
      if (!['requestHeader', 'responseHeader'].includes(action?.type)
        || action.enabled === false) return;
      const name = String(action.name || '').trim();
      const value = String(action.value ?? '');
      if (ValidationUtils.validateHeaderName(name).length
        || ValidationUtils.validateHeaderValue(value).length) return;
      const target = action.type === 'responseHeader'
        ? responseByName
        : requestByName;
      target.set(name.toLowerCase(), {
        header: name,
        operation: action.operation || 'set',
        value
      });
    });
    return {
      requestHeaders: [...requestByName.values()],
      responseHeaders: [...responseByName.values()]
    };
  }

  /**
   * Build one DNR rule per Profile/Request Match. All Header actions in the
   * implicit Rule share that match, which gives multiple filters OR semantics.
   */
  buildDnrRules(enabledConfigs) {
    const rules = [];
    const usedRuleIds = new Set();

    enabledConfigs.forEach((profile, profileIndex) => {
      let profileFilterCount = 0;
      (profile.rules || []).forEach(rule => {
        if (rule?.enabled === false) return;
        const headerActions = this.enabledHeaderActions(rule);
        if (!headerActions.requestHeaders.length
          && !headerActions.responseHeaders.length) return;

        (rule.requestMatches || []).forEach(match => {
          if (match?.enabled === false) return;
          if (!isAllRequestsMatch(match)) {
            profileFilterCount += 1;
            if (profileFilterCount > RequestFilterLimits.MAX_FILTERS_PER_PROFILE) {
              return;
            }
          }
          const condition = buildRequestCondition(match, RESOURCE_TYPES);
          if (!condition) return;

          rules.push({
            id: stableRuleId([
              String(profile.id || ''),
              String(rule.id || ''),
              String(match.id || '')
            ], usedRuleIds),
            // Later Profiles are newer and deterministically win if two active
            // Profiles set the same Header on the same request.
            priority: profileIndex + 1,
            action: {
              type: 'modifyHeaders',
              ...(headerActions.requestHeaders.length
                ? { requestHeaders: headerActions.requestHeaders }
                : {}),
              ...(headerActions.responseHeaders.length
                ? { responseHeaders: headerActions.responseHeaders }
                : {})
            },
            condition
          });
        });
      });
    });
    return rules;
  }

  async supportedRules(rules) {
    const check = globalThis.chrome?.declarativeNetRequest?.isRegexSupported
      ?.bind(globalThis.chrome.declarativeNetRequest);
    if (typeof check !== 'function') return rules;

    const result = [];
    for (const rule of rules) {
      const regex = rule.condition?.regexFilter;
      if (!regex) {
        result.push(rule);
        continue;
      }
      try {
        const support = await check({
          regex,
          isCaseSensitive: !!rule.condition.isUrlFilterCaseSensitive
        });
        if (support?.isSupported) result.push(rule);
      } catch (_) {
        // If capability probing itself is unavailable, let updateDynamicRules
        // remain the final validator.
        result.push(rule);
      }
    }
    return result;
  }

  async assertRequestMatchesSupported(matches = []) {
    const check = globalThis.chrome?.declarativeNetRequest?.isRegexSupported
      ?.bind(globalThis.chrome.declarativeNetRequest);
    if (typeof check !== 'function') return;

    for (const match of matches) {
      if (match?.enabled === false) continue;
      const condition = buildRequestCondition(
        normalizeRequestMatch(match),
        RESOURCE_TYPES
      );
      const regex = condition?.regexFilter;
      if (!regex) continue;

      const support = await check({
        regex,
        isCaseSensitive: !!condition.isUrlFilterCaseSensitive
      });
      if (!support?.isSupported) {
        const reason = support?.reason === 'memoryLimitExceeded'
          ? 'Regex is too complex'
          : 'Regex is not supported by Chrome';
        throw new Error(reason);
      }
    }
  }

  async updateNetworkRules() {
    // A rejected update must not poison the queue forever; later edits should
    // still be able to repair the runtime rules.
    this._ruleUpdatePromise = this._ruleUpdatePromise.catch(() => {}).then(async () => {
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      const compiled = this.buildDnrRules(this.getEnabledConfigs());
      const addRules = await this.supportedRules(compiled);
      const existingById = new Map(existingRules.map(rule => [rule.id, rule]));
      const desiredById = new Map(addRules.map(rule => [rule.id, rule]));
      const removeRuleIds = existingRules
        .filter(rule => {
          const desired = desiredById.get(rule.id);
          return !desired || !sameRule(rule, desired);
        })
        .map(rule => rule.id);
      const changedRules = addRules.filter(rule => {
        const existing = existingById.get(rule.id);
        return !existing || !sameRule(existing, rule);
      });

      if (!removeRuleIds.length && !changedRules.length) return;

      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds,
          addRules: changedRules
        });
      } catch (error) {
        // Atomic replacement keeps old rules on failure. Remove only rules that
        // changed or disappeared so stale scope cannot remain active while
        // unrelated Profiles continue working.
        if (removeRuleIds.length) {
          try {
            await chrome.declarativeNetRequest.updateDynamicRules({
              removeRuleIds
            });
          } catch (_) {}
        }
        throw error;
      }
    });
    return this._ruleUpdatePromise;
  }

  buildRuleCondition(scope) {
    if (!scope || scope.type === 'all') {
      return buildRequestCondition(createAllRequestsMatch(), RESOURCE_TYPES);
    }
    if (scope.type === 'domain') {
      return buildRequestCondition(normalizeRequestMatch({
        expression: `*.${String(scope.value || '').replace(/^\*\./, '')}`
      }), RESOURCE_TYPES);
    }
    if (scope.type === 'url_prefix' || scope.type === 'prefix') {
      const value = String(scope.value || '');
      return buildRequestCondition(normalizeRequestMatch({
        expression: value.endsWith('*') ? value : `${value}*`
      }), RESOURCE_TYPES);
    }
    return { resourceTypes: RESOURCE_TYPES };
  }
}
