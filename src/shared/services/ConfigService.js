import { Config } from '../models/Config.js';
import { StorageService } from '../utils/storage.js';

/** Resource types that commonly need injected request headers. */
const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'xmlhttprequest',
  'websocket',
  'other',
  'ping'
];

/**
 * Manages configs and syncs them to declarativeNetRequest rules.
 *
 * URL patterns match the browser tab address (including hash routes).
 * When a tab matches, that tab's headers are applied to requests from that tab
 * via session rules + tabIds (not by filtering the API request URL).
 */
export class ConfigService {
  constructor() {
    this.storage = new StorageService();
    this.configs = [];
    this._ruleUpdatePromise = Promise.resolve();
  }

  async init() {
    await this.loadConfigs();
  }

  async loadConfigs() {
    try {
      const data = await this.storage.get('configs');
      this.configs = (data || []).map(configData => Config.fromJSON(configData));
    } catch (error) {
      console.error('Failed to load configs:', error);
      this.configs = [];
    }
  }

  async saveConfigs() {
    try {
      const configsData = this.configs.map(config => config.toJSON());
      await this.storage.set('configs', configsData);
    } catch (error) {
      console.error('Failed to save configs:', error);
      throw error;
    }
  }

  getAllConfigs() {
    return this.configs;
  }

  getConfigById(id) {
    return this.configs.find(config => config.id === id);
  }

  async addConfig(configData) {
    const config = new Config(configData);
    this.configs.push(config);
    await this.saveConfigs();
    return config;
  }

  async updateConfig(id, configData) {
    const configIndex = this.configs.findIndex(config => config.id === id);
    if (configIndex === -1) {
      throw new Error('Config not found');
    }

    const updatedConfig = new Config({ ...this.configs[configIndex].toJSON(), ...configData });
    this.configs[configIndex] = updatedConfig;
    await this.saveConfigs();
    return updatedConfig;
  }

  async toggleConfig(id, enabled) {
    const config = this.getConfigById(id);
    if (!config) {
      throw new Error('Config not found');
    }

    // Global pause/resume: every URL-pattern tab shares one enabled flag
    await this.setGlobalEnabled(enabled);
    return this.getConfigById(id);
  }

  /**
   * Enable or disable all URL-pattern tabs together (single Pause/Resume control).
   */
  async setGlobalEnabled(enabled) {
    for (const config of this.configs) {
      config.setEnabled(enabled);
    }
    await this.saveConfigs();
    await this.updateNetworkRules();
  }

  async deleteConfig(id) {
    const before = this.configs.length;
    this.configs = this.configs.filter(config => config.id !== id);
    if (this.configs.length === before) {
      throw new Error('Config not found');
    }
    if (this.configs.length === 0) {
      throw new Error('Cannot delete the last config');
    }
    await this.saveConfigs();
    await this.updateNetworkRules();
    return true;
  }

  getEnabledConfigs() {
    return this.configs.filter(config => config.enabled);
  }

  /**
   * True when the scope matches every browser tab ("*" / empty / type "all").
   */
  isMatchAllScope(scope) {
    if (!scope || scope.type === 'all') return true;
    if (scope.type === 'regex') {
      const pattern = (scope.value || '').trim();
      return !pattern || pattern === '*';
    }
    return false;
  }

  /**
   * Normalize a tab URL for matching: drop hash (SPA routes) and trailing slash noise.
   */
  normalizeTabUrl(url) {
    if (!url) return '';
    // Hash is part of the address bar but never sent on HTTP requests; match both forms.
    const noHash = String(url).split('#')[0];
    return noHash;
  }

  /**
   * Variant patterns so "…/default/" also matches "…/default" and "…/default#/…".
   */
  patternVariants(pattern) {
    const p = (pattern || '').trim();
    if (!p) return [];
    const out = new Set([p]);
    if (p.endsWith('/')) out.add(p.slice(0, -1));
    else out.add(p + '/');
    return [...out];
  }

  /**
   * Match a browser tab URL against a config scope (supports hash SPA routes).
   * Users usually paste an address-bar prefix; we treat that as startsWith, and
   * also try it as a RegExp for advanced patterns.
   */
  isUrlMatchingScope(url, scope) {
    try {
      if (!url) return false;
      if (this.isMatchAllScope(scope)) return true;

      if (scope.type === 'regex') {
        const pattern = (scope.value || '').trim();
        const full = String(url);
        const noHash = this.normalizeTabUrl(full);
        const candidates = [full, noHash];

        for (const p of this.patternVariants(pattern)) {
          // Prefix match (typical when pasting http://host/path/)
          if (candidates.some(c => c === p || c.startsWith(p))) return true;

          // Regex match against full URL and hash-stripped URL
          try {
            const re = new RegExp(p);
            if (candidates.some(c => re.test(c))) return true;
          } catch (_) {
            // invalid regex variant — ignore and keep trying others
          }
        }
        return false;
      }

      const urlObj = new URL(url);
      const noHash = this.normalizeTabUrl(url);

      if (scope.type === 'domain') {
        return urlObj.hostname === scope.value || urlObj.hostname.endsWith('.' + scope.value);
      }

      if (scope.type === 'url_prefix' || scope.type === 'prefix') {
        const prefix = scope.value || '';
        return this.patternVariants(prefix).some(p => noHash.startsWith(p) || url.startsWith(p));
      }

      return false;
    } catch (_) {
      // Invalid URL or invalid regex → no match
      return false;
    }
  }

  /**
   * Rebuild DNR rules from enabled configs and currently open tabs.
   * - Match-all ("*") → persistent dynamic rules (all tabs)
   * - Patterned tabs → session rules scoped to matching tabIds
   */
  async updateNetworkRules() {
    // Serialize DNR updates to avoid concurrent add/remove races that cause duplicate IDs
    this._ruleUpdatePromise = this._ruleUpdatePromise.then(async () => {
      try {
        const enabledConfigs = this.getEnabledConfigs();
        const globalConfigs = [];
        const patternedConfigs = [];

        enabledConfigs.forEach(config => {
          if (this.isMatchAllScope(config.scope)) globalConfigs.push(config);
          else patternedConfigs.push(config);
        });

        // Collect open tabs so patterned rules can target the browser address bar URL
        let tabs = [];
        try {
          tabs = await chrome.tabs.query({});
        } catch (e) {
          console.warn('tabs.query failed; patterned rules may be empty:', e?.message || e);
        }

        // Sequential IDs avoid rare hash collisions that would reject the whole update
        let nextId = 1;
        const assignIds = (rules) => rules.map(rule => ({ ...rule, id: nextId++ }));

        const dynamicRules = assignIds(this.buildDnrRules(globalConfigs));

        const sessionRules = [];
        patternedConfigs.forEach(config => {
          const matched = tabs.filter(
            t => typeof t.id === 'number' && this.isUrlMatchingScope(t.url, config.scope)
          );
          const tabIds = matched.map(t => t.id);
          if (tabIds.length === 0) {
            console.log(
              '[VibeHeader] No open tab matches pattern',
              config.scope?.value || config.name,
              '| sample tab urls:',
              tabs.slice(0, 5).map(t => t.url || '(no url)')
            );
            return;
          }
          console.log(
            '[VibeHeader] Pattern matched tabs',
            config.scope?.value,
            '→',
            matched.map(t => ({ id: t.id, url: t.url }))
          );
          sessionRules.push(...this.buildDnrRules([config], { tabIds }));
        });
        const sessionRulesWithIds = assignIds(sessionRules);

        // Replace dynamic rules (match-all)
        const existingDynamic = await chrome.declarativeNetRequest.getDynamicRules();
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existingDynamic.map(rule => rule.id),
          addRules: dynamicRules
        });

        // Replace session rules (tab-address patterns); tabIds are only valid here
        const existingSession = await chrome.declarativeNetRequest.getSessionRules();
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: existingSession.map(rule => rule.id),
          addRules: sessionRulesWithIds
        });

        console.log(
          '[VibeHeader] Rules updated:',
          dynamicRules.length,
          'dynamic,',
          sessionRulesWithIds.length,
          'session'
        );
      } catch (error) {
        console.error('Failed to update network rules:', error);
        throw error;
      }
    });
    return this._ruleUpdatePromise;
  }

  /**
   * Build DNR modifyHeaders rules. Pure helper for unit tests.
   * @param {object[]} enabledConfigs
   * @param {{ tabIds?: number[] }} [options] - when set, rules only apply to those tabs
   */
  buildDnrRules(enabledConfigs, options = {}) {
    const tabIds = options.tabIds;
    const rules = [];

    enabledConfigs.forEach(config => {
      (config.headers || []).forEach((header, idx) => {
        if (!header || header.enabled === false) return;
        if (!header.name || !header.name.trim()) return; // skip empty names

        // Default to request headers when type is missing (older stored configs)
        const isResponse = header.type === 'response';

        const condition = {
          resourceTypes: RESOURCE_TYPES
        };
        // Session rules may restrict by browser tab; request URL is intentionally not filtered
        // so SPA API calls from a matching page still receive headers.
        if (Array.isArray(tabIds) && tabIds.length > 0) {
          condition.tabIds = tabIds;
        }

        const action = { type: 'modifyHeaders' };
        if (isResponse) {
          action.responseHeaders = [
            { header: header.name, operation: 'set', value: header.value ?? '' }
          ];
        } else {
          action.requestHeaders = [
            { header: header.name, operation: 'set', value: header.value ?? '' }
          ];
        }

        rules.push({
          // Placeholder id; updateNetworkRules assigns unique sequential ids
          id: idx + 1,
          priority: 1,
          action,
          condition
        });
      });
    });
    return rules;
  }
}

export { RESOURCE_TYPES };
