import { ConfigService } from '../shared/services/ConfigService.js';
import { ValidationUtils } from '../shared/utils/validation.js';

// Background Service Worker
export class BackgroundService {
  constructor(configService = new ConfigService()) {
    this.configService = configService;
    this.isInitialized = false;
    this.readyPromise = null;
    this._configTaskTail = Promise.resolve();
  }

  enqueueConfigTask(task) {
    const result = this._configTaskTail.then(task);
    this._configTaskTail = result.catch(() => {});
    return result;
  }

  // Init
  async init() {
    try {
      // Register listeners synchronously. A Manifest V3 worker can be started
      // by the very message it needs to handle; waiting for storage first
      // creates a window where Chrome sees no receiving end.
      this.readyPromise = this.configService.init();
      this.setupEventListeners();
      await this.readyPromise;
      // Sync enabled configs to DNR rules on startup
      try {
        await this.configService.updateNetworkRules();
      } catch (e) {
        console.warn('Initial rule sync failed (will retry on changes):', e?.message || e);
      }
      await this.updateActionState();
      this.isInitialized = true;
      console.log('VibeHeader background started');
    } catch (error) {
      console.error('Background init failed:', error);
    }
  }

  // Events
  setupEventListeners() {
    // onInstalled
    chrome.runtime.onInstalled.addListener((details) => {
      this.handleInstall(details);
    });

    // messaging
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // keep channel open
    });

    // storage changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.configs) {
        this.enqueueConfigTask(() => this.handleConfigsChanged())
          .catch(error => console.error('Handle config change failed:', error));
      }
    });

    // tabs updated
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.url) {
        this.handleTabUpdated(tab);
      }
    });
  }

  // Install/update
  async handleInstall(details) {
    if (this.readyPromise) {
      await this.readyPromise.catch(() => {});
    }
    if (details.reason === 'install') {
      console.log('VibeHeader first install');
      // create default config
      try {
        await this.enqueueConfigTask(() => this.createDefaultConfig());
      } catch (error) {
        console.error('Failed to create default config:', error);
      }

    } else if (details.reason === 'update') {
      console.log('VibeHeader updated to version:', chrome.runtime.getManifest().version);
    }
  }

  // Default config
  async createDefaultConfig() {
    const defaultConfig = {
      name: 'Default',
      enabled: false,
      headers: [],
      scope: { type: 'all', value: '' }
    };

    await this.configService.addConfig(defaultConfig);
  }

  // Messaging handler
  async handleMessage(message, sender, sendResponse) {
    try {
      // ensure configs are loaded before serving messages like getConfigs
      if (this.readyPromise) {
        await this.readyPromise.catch(() => {});
      }
      const { action, data } = message;

      switch (action) {
      case 'getConfigs': {
        const configs = await this.enqueueConfigTask(() => this.configService.getAllConfigs());
        sendResponse({
          success: true,
          data: configs
        });
        break;
      }

      case 'addConfig': {
        const newConfig = await this.enqueueConfigTask(() => this.configService.addConfig(data));
        sendResponse({
          success: true,
          data: newConfig
        });
        break;
      }

      case 'updateConfig': {
        const updatedConfig = await this.enqueueConfigTask(async () => {
          const updated = await this.configService.updateConfig(data.id, data.config);
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          return updated;
        });
        sendResponse({
          success: true,
          data: updatedConfig
        });
        break;
      }

      case 'toggleConfig': {
        const toggledConfig = await this.enqueueConfigTask(async () => {
          const toggled = await this.configService.toggleConfig(data.id, data.enabled);
          await this.updateActionState();
          return toggled;
        });
        sendResponse({
          success: true,
          data: toggledConfig
        });
        break;
      }

      case 'importSharedKV': {
        const list = Array.isArray(data?.h) ? data.h : [];
        const candidate = list
          .filter(it => Array.isArray(it) && String(it[0] || '').trim())
          .map(([n, v]) => ({ name: String(n).trim(), value: String(v ?? ''), enabled: true, type: 'request' }));

        if (candidate.length === 0) {
          sendResponse({ success: false, error: 'No valid headers in shared link' });
          break;
        }

        // S3: security validation before anything is persisted. Block header/CRLF
        // injection and malformed names. We intentionally do NOT enforce the full
        // RESTRICTED_HEADERS UX list here — that would reject legitimate shares
        // (e.g. User-Agent) that the manual editor accepts, and DNR enforces its
        // own restrictions at rule time anyway.
        const bad = [];
        candidate.forEach((h, i) => {
          if (!/^[a-zA-Z0-9!#$&'*+.^_`|~-]+$/.test(h.name)) {
            bad.push(`#${i + 1} "${h.name}": invalid header name`);
          }
          const valErrs = ValidationUtils.validateHeaderValue(h.value);
          if (valErrs.length) bad.push(`#${i + 1} "${h.name}": ${valErrs.join(', ')}`);
        });
        if (bad.length) {
          sendResponse({ success: false, error: 'Rejected unsafe headers: ' + bad.join('; ') });
          break;
        }

        // Apply to the single active config (one-click UX): replace its headers
        // and enable. Only reached after the S3 validation gate above.
        const updated = await this.enqueueConfigTask(async () => {
          let configs = this.configService.getAllConfigs();
          if (!configs || configs.length === 0) {
            await this.configService.addConfig({ name: 'Default', enabled: false, headers: [], scope: { type: 'all', value: '' } });
            configs = this.configService.getAllConfigs();
          }
          const first = configs[0];
          const result = await this.configService.updateConfig(first.id, { headers: candidate, enabled: true });
          await this.configService.updateNetworkRules();
          await this.updateActionState();
          return result;
        });
        sendResponse({ success: true, data: updated });
        break;
      }

      default:
        sendResponse({
          success: false,
          error: `Unknown action: ${action}`
        });
      }

    } catch (error) {
      console.error('Handle message failed:', error);
      sendResponse({
        success: false,
        error: error.message
      });
    }
  }

  // On configs changed
  async handleConfigsChanged() {
    try {
      // reload configs
      await this.configService.loadConfigs();
      // sync rules
      try {
        await this.configService.updateNetworkRules();
      } catch (e) {
        console.warn('Rule update after change failed:', e?.message || e);
      }
      await this.updateActionState();
    } catch (error) {
      console.error('Handle config change failed:', error);
    }
  }

  // Tab updated
  handleTabUpdated(tab) {
    // Example: check scope match
    const enabledConfigs = this.configService.getEnabledConfigs();
    const matchingConfigs = enabledConfigs.filter(config => {
      return this.isUrlMatchingScope(tab.url, config.scope);
    });

    if (matchingConfigs.length > 0) {
      this.updateBadge(tab.id, matchingConfigs.length);
    }
  }

  // URL match helper
  isUrlMatchingScope(url, scope) {
    try {
      const urlObj = new URL(url);

      if (scope.type === 'domain') {
        return urlObj.hostname === scope.value || urlObj.hostname.endsWith('.' + scope.value);
      } else if (scope.type === 'url_prefix') {
        return url.startsWith(scope.value);
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  // Badge
  updateBadge(tabId, count) {
    if (count > 0) {
      chrome.action.setBadgeText({
        text: count.toString(),
        tabId: tabId
      });
      chrome.action.setBadgeBackgroundColor({
        color: '#4CAF50',
        tabId: tabId
      });
    } else {
      chrome.action.setBadgeText({
        text: '',
        tabId: tabId
      });
    }
  }

  // Update toolbar icon and title to reflect active/paused state
  async updateActionState() {
    try {
      const configs = this.configService.getAllConfigs();
      const enabledHeadersCount = configs
        .filter(c => c.enabled)
        .flatMap(c => c.headers || [])
        .filter(h => h && h.enabled !== false && (h.name || '').trim()).length;

      const isActive = enabledHeadersCount > 0;
      const title = isActive
        ? `VibeHeader — Active (${enabledHeadersCount} headers)`
        : 'VibeHeader — Ready (add a header)';
      await chrome.action.setTitle({ title });

      const basePath = 'icons';
      const paths = isActive
        ? { 16: `${basePath}/icon16.png`, 32: `${basePath}/icon32.png`, 48: `${basePath}/icon48.png`, 128: `${basePath}/icon128.png` }
        : { 16: `${basePath}/icon16_gray.png`, 32: `${basePath}/icon32_gray.png`, 48: `${basePath}/icon48_gray.png`, 128: `${basePath}/icon128_gray.png` };
      await chrome.action.setIcon({ path: paths });
    } catch (e) {
      console.warn('updateActionState failed:', e?.message || e);
    }
  }
}
