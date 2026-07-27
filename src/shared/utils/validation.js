/**
 * Validation utilities.
 */
export class ValidationUtils {
  /**
   * Validate an HTTP header field name using the RFC token characters accepted
   * by Chrome's declarativeNetRequest API.
   */
  static validateHeaderName(name) {
    const value = String(name || '').trim();
    if (!value) return ['Header name is required'];
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) {
      return ['Header name contains invalid characters'];
    }
    return [];
  }

  /**
   * Validate an HTTP header value: reject control characters (which would allow
   * header/CRLF injection) and values over the length limit.
   */
  static validateHeaderValue(value) {
    const errors = [];

    if (value === null || value === undefined) {
      errors.push('Header value is required');
      return errors;
    }

    const stringValue = String(value);

    // Control characters are not allowed
    // eslint-disable-next-line no-control-regex -- intentional: reject control chars in header values
    const controlCharRegex = /[\x00-\x1F\x7F]/;
    if (controlCharRegex.test(stringValue)) {
      errors.push('Header value cannot contain control characters');
    }

    if (stringValue.length > 8192) {
      errors.push('Header value must be <= 8192 chars');
    }

    return errors;
  }
}
