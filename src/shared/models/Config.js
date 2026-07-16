/**
 * Config data model.
 */
export class Config {
  constructor(data = {}) {
    this.id = data.id || this.generateId();
    // Optional display alias shown on the popup tab chip (empty = show URL pattern)
    this.name = data.name || '';
    this.enabled = data.enabled || false;
    this.headers = data.headers || [];
    // scope.type: 'all' | 'regex' | 'domain' | 'url_prefix'
    // - all: match every browser tab (UI shows "*")
    // - regex: JS regex matched against the tab address (incl. hash); headers apply to that tab's requests
    this.scope = data.scope || { type: 'all', value: '' };
    this.createdAt = data.createdAt || Date.now();
    this.updatedAt = data.updatedAt || Date.now();
  }

  generateId() {
    return 'config_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.updatedAt = Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      headers: this.headers,
      scope: this.scope,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromJSON(data) {
    return new Config(data);
  }
}
