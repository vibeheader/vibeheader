import { Config } from '../models/Config.js';
import { StorageService } from '../utils/storage.js';

/**
 * Manages configs and syncs them to declarativeNetRequest dynamic rules.
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

    config.setEnabled(enabled);
    await this.saveConfigs();
    await this.updateNetworkRules();
    return config;
  }

  getEnabledConfigs() {
    return this.configs.filter(config => config.enabled);
  }

  /**
   * Rebuild the dynamic DNR rules from the currently enabled configs.
   */
  async updateNetworkRules() {
    // Serialize DNR updates to avoid concurrent add/remove races that cause duplicate IDs
    this._ruleUpdatePromise = this._ruleUpdatePromise.then(async () => {
      try {
        const enabledConfigs = this.getEnabledConfigs();

        // Remove existing dynamic rules first
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const ruleIds = existingRules.map(rule => rule.id);
        if (ruleIds.length > 0) {
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds });
        }

        // Build and add new rules
        const newRules = this.buildDnrRules(enabledConfigs);
        if (newRules.length > 0) {
          await chrome.declarativeNetRequest.updateDynamicRules({ addRules: newRules });
        }
      } catch (error) {
        console.error('Failed to update network rules:', error);
        throw error;
      }
    });
    return this._ruleUpdatePromise;
  }

  /**
   * Build DNR rules from the enabled configs. Pure function, kept easy to unit test.
   */
  buildDnrRules(enabledConfigs) {
    const rules = [];
    enabledConfigs.forEach(config => {
      (config.headers || []).forEach((header, idx) => {
        if (!header || !header.enabled) return;
        if (!header.name || !header.name.trim()) return; // skip empty names
        const rule = {
          id: this.generateRuleId(config.id, idx),
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: header.type === 'request' ? [
              { header: header.name, operation: 'set', value: header.value }
            ] : undefined,
            responseHeaders: header.type === 'response' ? [
              { header: header.name, operation: 'set', value: header.value }
            ] : undefined
          },
          condition: this.buildRuleCondition(config.scope)
        };
        rules.push(rule);
      });
    });
    return rules;
  }

  /**
   * Generate a stable, unique positive rule ID from configId + header index.
   */
  generateRuleId(configId, headerIndex) {
    const hash = this.hashString(configId);
    // mix index, ensure positive and non-zero, clamp to 31-bit (Chrome requirement)
    let id = (hash ^ ((headerIndex + 1) * 2654435761)) & 0x7fffffff;
    if (id === 0) id = 1;
    return id;
  }

  hashString(str) {
    // simple DJB2 hash
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h |= 0; // to 32-bit
    }
    return h & 0x7fffffff;
  }

  buildRuleCondition(scope) {
    const condition = {};

    if (!scope || scope.type === 'all') {
      // match all; explicitly include only valid DNR types (subset we care about)
      condition.resourceTypes = ['main_frame', 'sub_frame', 'xmlhttprequest'];
      return condition;
    }

    if (scope.type === 'domain') {
      condition.requestDomains = [scope.value];
      condition.resourceTypes = ['main_frame', 'sub_frame', 'xmlhttprequest'];
    } else if (scope.type === 'url_prefix' || scope.type === 'prefix') {
      condition.urlFilter = scope.value + '*';
      condition.resourceTypes = ['main_frame', 'sub_frame', 'xmlhttprequest'];
    }

    return condition;
  }
}
