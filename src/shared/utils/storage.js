/**
 * Storage service — thin wrapper over chrome.storage.local with a localStorage
 * fallback. The constructor is guarded so it can be imported in a plain Node
 * context (e.g. unit tests) without a `chrome` global.
 */
export class StorageService {
  constructor() {
    this.storage = (typeof chrome !== 'undefined' && chrome.storage) ? chrome.storage.local : null;
  }

  async set(key, value) {
    try {
      if (this.storage) {
        return new Promise((resolve, reject) => {
          this.storage.set({ [key]: value }, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve();
            }
          });
        });
      } else {
        localStorage.setItem(key, JSON.stringify(value));
        return Promise.resolve();
      }
    } catch (error) {
      console.error('Failed to write storage:', error);
      throw error;
    }
  }

  async get(key) {
    try {
      if (this.storage) {
        return new Promise((resolve, reject) => {
          this.storage.get([key], (result) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(result[key]);
            }
          });
        });
      } else {
        const data = localStorage.getItem(key);
        return Promise.resolve(data ? JSON.parse(data) : null);
      }
    } catch (error) {
      console.error('Failed to read storage:', error);
      return null;
    }
  }
}
