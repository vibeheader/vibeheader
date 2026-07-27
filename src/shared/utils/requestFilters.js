const ALL_REQUESTS = 'allRequests';

export const RequestFilterLimits = Object.freeze({
  MAX_EXPRESSION_LENGTH: 1024,
  MAX_REGEX_LENGTH: 512,
  MAX_WILDCARDS: 32,
  MAX_REGEX_GROUPS: 32,
  MAX_REGEX_NESTING_DEPTH: 8,
  MAX_FILTERS_PER_PROFILE: 100,
  MAX_TEST_URL_LENGTH: 8192,
  MAX_SHARED_PROFILE_BYTES: 128 * 1024,
  REGEX_TEST_TIMEOUT_MS: 100
});

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardRegex(value) {
  return value
    .split('*')
    .map(part => escapeRegex(part))
    .join('.*');
}

function parseRegexLiteral(value) {
  if (!value.startsWith('/')) return null;
  const lastSlash = value.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return {
    source: value.slice(1, lastSlash),
    flags: value.slice(lastSlash + 1)
  };
}

function looksLikeRegex(value) {
  return value.startsWith('^')
    || value.endsWith('$')
    || value.includes('\\')
    || /[()[\]{}|]/.test(value)
    || /(?:\.\+|[a-z0-9)\]][+?])/i.test(value);
}

function regexMetrics(source) {
  let escaped = false;
  let inCharacterClass = false;
  let depth = 0;
  let groups = 0;
  let maxDepth = 0;

  for (const character of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(') {
      groups += 1;
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    } else if (character === ')' && depth > 0) {
      depth -= 1;
    }
  }

  return { groups, maxDepth };
}

function repeatingQuantifierAt(source, index) {
  const character = source[index];
  if (character === '*' || character === '+') return true;
  if (character !== '{') return false;
  const closing = source.indexOf('}', index + 1);
  if (closing === -1) return false;
  const range = source.slice(index + 1, closing);
  const match = range.match(/^(\d+)(?:,(\d*))?$/);
  if (!match) return false;
  if (!range.includes(',')) return Number(match[1]) > 1;
  return match[2] === '' || Number(match[2]) > 1;
}

function lastQuantifier(value) {
  let escaped = false;
  let inCharacterClass = false;
  let result = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '*' || character === '+' || character === '?') {
      result = { start: index, end: index };
    } else if (character === '{' && repeatingQuantifierAt(value, index)) {
      result = {
        start: index,
        end: value.indexOf('}', index + 1)
      };
    }
  }

  return result;
}

function hasRequiredLiteralAfter(value, quantifier) {
  const suffix = value.slice(quantifier.end + 1);
  if (!suffix || suffix.includes('|')) return false;

  let escaped = false;
  for (const character of suffix) {
    if (escaped) return true;
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (!'()[]{}*+?.^$'.includes(character)) return true;
  }
  return false;
}

function topLevelAlternatives(value) {
  const alternatives = [];
  let current = '';
  let escaped = false;
  let inCharacterClass = false;
  let depth = 0;

  for (const character of value) {
    if (escaped) {
      current += `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      current += character;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      current += character;
      continue;
    }
    if (!inCharacterClass) {
      if (character === '(') depth += 1;
      if (character === ')' && depth > 0) depth -= 1;
      if (character === '|' && depth === 0) {
        alternatives.push(current);
        current = '';
        continue;
      }
    }
    current += character;
  }
  if (escaped) return null;
  alternatives.push(current);
  return alternatives.length > 1 ? alternatives : null;
}

function literalAlternative(value) {
  let result = '';
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      if (/[0-9A-Za-z]/.test(character)) return null;
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if ('.^$*+?{}[]()'.includes(character)) return null;
    result += character;
  }

  return !escaped && result ? result : null;
}

function canComposeFrom(value, alternatives) {
  const reachable = new Set([0]);
  for (let index = 0; index < value.length; index += 1) {
    if (!reachable.has(index)) continue;
    alternatives.forEach(alternative => {
      if (value.startsWith(alternative, index)) {
        reachable.add(index + alternative.length);
      }
    });
  }
  return reachable.has(value.length);
}

function ambiguousLiteralAlternatives(body) {
  const branches = topLevelAlternatives(body);
  if (!branches) return false;
  const alternatives = branches.map(literalAlternative);
  if (alternatives.some(value => !value)) return false;
  if (new Set(alternatives).size !== alternatives.length) return true;

  return alternatives.some(shorter =>
    alternatives.some(longer => {
      if (shorter === longer || !longer.startsWith(shorter)) return false;
      return canComposeFrom(longer.slice(shorter.length), alternatives);
    })
  );
}

function hasRiskyNestedQuantifier(source) {
  const stack = [];
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;

    if (character === '(') {
      stack.push(index);
      continue;
    }
    if (character !== ')' || !stack.length) continue;

    const start = stack.pop();
    if (!repeatingQuantifierAt(source, index + 1)) continue;
    const body = source.slice(start + 1, index).replace(/^\?:/, '');
    const innerQuantifier = lastQuantifier(body);
    if (innerQuantifier
      && !hasRequiredLiteralAfter(body, innerQuantifier)) {
      return true;
    }
  }

  return false;
}

function hasAmbiguousRepeatedAlternation(source) {
  const stack = [];
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;

    if (character === '(') {
      stack.push(index);
      continue;
    }
    if (character !== ')' || !stack.length) continue;

    const start = stack.pop();
    if (!repeatingQuantifierAt(source, index + 1)) continue;
    const body = source.slice(start + 1, index).replace(/^\?:/, '');
    if (ambiguousLiteralAlternatives(body)) return true;
  }

  return false;
}

function regexSafetyReason(source) {
  if (source.length > RequestFilterLimits.MAX_REGEX_LENGTH) {
    return `Regex must be ${RequestFilterLimits.MAX_REGEX_LENGTH} characters or fewer`;
  }
  if (/\\[1-9]/.test(source) || /\\k<[^>]+>/.test(source)) {
    return 'Regex backreferences are not supported';
  }
  if (/\(\?(?:[=!]|<[=!])/.test(source)) {
    return 'Regex lookaround is not supported';
  }

  const metrics = regexMetrics(source);
  if (metrics.groups > RequestFilterLimits.MAX_REGEX_GROUPS) {
    return `Regex can use up to ${RequestFilterLimits.MAX_REGEX_GROUPS} groups`;
  }
  if (metrics.maxDepth > RequestFilterLimits.MAX_REGEX_NESTING_DEPTH) {
    return `Regex nesting can be up to ${RequestFilterLimits.MAX_REGEX_NESTING_DEPTH} levels`;
  }
  if (hasRiskyNestedQuantifier(source)) {
    return 'Regex contains a repeated nested pattern';
  }
  if (hasAmbiguousRepeatedAlternation(source)) {
    return 'Regex contains an ambiguous repeated alternative';
  }
  return '';
}

function isCatchAll(value) {
  const hostLike = value.replace(/:\d+$/, '');
  if (!value.includes('/') && hostLike.includes('*') && !hostLike.replace(/[*.]/g, '')) {
    return true;
  }
  if (/^https?:\/\//i.test(value)) {
    const rest = value.replace(/^https?:\/\//i, '');
    return rest.includes('*') && !rest.replace(/[*/.:?#=&]/g, '');
  }
  return false;
}

function plausibleHost(value) {
  if (/^\[[0-9a-f:.]+\](?::\d+)?$/i.test(value)) return true;

  let host = value;
  const portMatch = value.match(/^(.*):(\d+)$/);
  if (portMatch) {
    host = portMatch[1];
    if (Number(portMatch[2]) > 65535) return false;
  } else if (value.includes(':')) {
    return false;
  }

  if (host.endsWith('.')) host = host.slice(0, -1);
  return !!host && host.split('.').every(label =>
    label && /^[a-z0-9_*-]+$/i.test(label)
  );
}

function validAbsoluteUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && plausibleHost(url.host);
  } catch (_) {
    return false;
  }
}

function parsePattern(value) {
  if (/\s/.test(value)) {
    return { valid: false, kind: 'invalid', reason: 'Spaces are not supported' };
  }
  if (isCatchAll(value)) {
    return { valid: false, kind: 'invalid', reason: 'Remove the filter to apply everywhere' };
  }

  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const hasPath = value.includes('/');
  const wildcard = value.includes('*');
  const wildcardCount = value.split('*').length - 1;

  if (wildcardCount > RequestFilterLimits.MAX_WILDCARDS) {
    return {
      valid: false,
      kind: 'invalid',
      reason: `Use ${RequestFilterLimits.MAX_WILDCARDS} wildcards or fewer`
    };
  }

  if (absolute) {
    if (!validAbsoluteUrl(value.replace(/\*/g, 'x'))) {
      return { valid: false, kind: 'invalid', reason: 'Enter a valid HTTP(S) URL' };
    }
    return { valid: true, kind: wildcard ? 'urlWildcard' : 'exactUrl' };
  }

  if (hasPath || !plausibleHost(value)) {
    return { valid: false, kind: 'invalid', reason: 'Enter a host or full HTTP(S) URL' };
  }

  return { valid: true, kind: wildcard ? 'hostWildcard' : 'exactHost' };
}

export function parseRequestExpression(expression, typeOverride = null) {
  const value = String(expression || '').trim();
  if (!value) {
    return { valid: false, kind: 'empty', reason: '' };
  }
  if (value.length > RequestFilterLimits.MAX_EXPRESSION_LENGTH) {
    return {
      valid: false,
      kind: 'invalid',
      reason: `Filter must be ${RequestFilterLimits.MAX_EXPRESSION_LENGTH} characters or fewer`
    };
  }

  const literal = parseRegexLiteral(value);
  const forcedRegex = typeOverride === 'regex';
  if (literal || forcedRegex || looksLikeRegex(value)) {
    const source = literal ? literal.source : value;
    const flags = literal ? literal.flags : '';
    if (flags && flags !== 'i') {
      return { valid: false, kind: 'regex', reason: 'Only the i flag is supported' };
    }
    if ([...source].some(character => character.charCodeAt(0) > 127)) {
      return { valid: false, kind: 'regex', reason: 'Regex must use ASCII characters' };
    }
    const safetyReason = regexSafetyReason(source);
    if (safetyReason) {
      return { valid: false, kind: 'regex', reason: safetyReason };
    }
    try {
      new RegExp(source, flags);
      return {
        valid: true,
        kind: 'regex',
        regexSource: source,
        caseSensitive: !flags.includes('i')
      };
    } catch (_) {
      return { valid: false, kind: 'regex', reason: 'Invalid regular expression' };
    }
  }

  return parsePattern(value);
}

export function createAllRequestsMatch(data = {}) {
  return {
    id: data.id || makeId('match'),
    expression: '',
    enabled: true,
    inferredType: ALL_REQUESTS,
    typeOverride: null,
    effectiveType: ALL_REQUESTS,
    validation: { valid: true, reason: '' }
  };
}

export function isAllRequestsMatch(match) {
  return match?.effectiveType === ALL_REQUESTS
    || match?.inferredType === ALL_REQUESTS;
}

export function normalizeRequestMatch(data = {}) {
  if (isAllRequestsMatch(data)) {
    return createAllRequestsMatch(data);
  }

  const expression = String(data.expression ?? data.value ?? '');
  const typeOverride = data.typeOverride || null;
  const parsed = parseRequestExpression(expression, typeOverride);
  const runtimeValidationReason = String(data.runtimeValidationReason || '');
  return {
    id: data.id || makeId('match'),
    expression,
    enabled: data.enabled !== false,
    inferredType: parsed.kind,
    typeOverride,
    effectiveType: parsed.valid ? parsed.kind : parsed.kind,
    runtimeValidationReason,
    validation: {
      valid: parsed.valid && !runtimeValidationReason,
      reason: runtimeValidationReason || parsed.reason || ''
    }
  };
}

export function getUserRequestMatches(rule) {
  return (rule?.requestMatches || []).filter(match => !isAllRequestsMatch(match));
}

export function ensureRequestMatches(matches = []) {
  const normalized = matches.map(normalizeRequestMatch);
  const userMatches = normalized.filter(match => !isAllRequestsMatch(match));
  const activeMatches = userMatches.filter(match =>
    match.enabled !== false
    && String(match.expression || '').trim()
    && match.validation?.valid
  );
  if (activeMatches.length) return userMatches;

  const allRequests = normalized.find(isAllRequestsMatch)
    || createAllRequestsMatch();
  return [allRequests, ...userMatches];
}

function regexCondition(source, caseSensitive, resourceTypes) {
  return {
    regexFilter: source,
    isUrlFilterCaseSensitive: !!caseSensitive,
    resourceTypes
  };
}

export function buildRequestCondition(match, resourceTypes) {
  if (isAllRequestsMatch(match)) {
    return { resourceTypes };
  }
  if (match?.enabled === false) return null;
  if (match?.runtimeValidationReason) return null;

  const expression = String(match?.expression || '').trim();
  const parsed = parseRequestExpression(expression, match?.typeOverride || null);
  if (!parsed.valid) return null;

  if (parsed.kind === 'regex') {
    return regexCondition(parsed.regexSource, parsed.caseSensitive, resourceTypes);
  }

  if (parsed.kind === 'exactHost') {
    const hasPort = /:\d+$/.test(expression) || /^\[[0-9a-f:.]+\]:\d+$/i.test(expression);
    const host = escapeRegex(expression.replace(/\.$/, ''));
    const port = hasPort ? '' : '(?::[0-9]+)?';
    return regexCondition(`^https?://${host}${port}(?:/|$)`, false, resourceTypes);
  }

  if (parsed.kind === 'hostWildcard') {
    let source;
    if (expression.startsWith('*.')) {
      const domain = escapeRegex(expression.slice(2).replace(/\.$/, ''));
      source = `^https?://(?:[^./:]+\\.)*${domain}(?::[0-9]+)?(?:/|$)`;
    } else {
      const optionalPort = expression.includes(':') ? '' : '(?::[0-9]+)?';
      source = `^https?://${wildcardRegex(expression)}${optionalPort}(?:/|$)`;
    }
    return regexCondition(source, false, resourceTypes);
  }

  if (parsed.kind === 'exactUrl') {
    try {
      return regexCondition(`^${escapeRegex(new URL(expression).href)}$`, false, resourceTypes);
    } catch (_) {
      return null;
    }
  }

  if (parsed.kind === 'urlWildcard') {
    return regexCondition(`^${wildcardRegex(expression)}$`, false, resourceTypes);
  }

  return null;
}

export function requestMatchMatchesUrl(match, candidateUrl) {
  if (match?.enabled === false) return false;
  if (isAllRequestsMatch(match)) return true;
  if (match?.runtimeValidationReason) return false;
  if (String(candidateUrl || '').length > RequestFilterLimits.MAX_TEST_URL_LENGTH) {
    return false;
  }

  let url;
  try {
    url = new URL(candidateUrl);
    if (!/^https?:$/.test(url.protocol)) return false;
  } catch (_) {
    return false;
  }

  const expression = String(match?.expression || '').trim();
  const parsed = parseRequestExpression(expression, match?.typeOverride || null);
  if (!parsed.valid) return false;

  if (parsed.kind === 'exactHost') {
    const target = expression.replace(/\.$/, '').toLowerCase();
    return (target.includes(':') ? url.host : url.hostname).toLowerCase() === target;
  }

  if (parsed.kind === 'hostWildcard') {
    if (expression.startsWith('*.')) {
      const domain = expression.slice(2).toLowerCase();
      const hostname = url.hostname.toLowerCase();
      return hostname === domain || hostname.endsWith(`.${domain}`);
    }
    const candidate = expression.includes(':') ? url.host : url.hostname;
    return wildcardMatches(expression, candidate);
  }

  if (parsed.kind === 'exactUrl') {
    try {
      return url.href === new URL(expression).href;
    } catch (_) {
      return false;
    }
  }

  if (parsed.kind === 'urlWildcard') {
    return wildcardMatches(expression, url.href);
  }

  if (parsed.kind === 'regex') {
    return new RegExp(parsed.regexSource, parsed.caseSensitive ? '' : 'i').test(url.href);
  }

  return false;
}

function wildcardMatches(pattern, candidate) {
  const normalizedPattern = String(pattern || '').toLowerCase();
  const normalizedCandidate = String(candidate || '').toLowerCase();
  let patternIndex = 0;
  let candidateIndex = 0;
  let starIndex = -1;
  let retryIndex = -1;

  while (candidateIndex < normalizedCandidate.length) {
    if (patternIndex < normalizedPattern.length
      && normalizedPattern[patternIndex] === normalizedCandidate[candidateIndex]) {
      patternIndex += 1;
      candidateIndex += 1;
      continue;
    }
    if (normalizedPattern[patternIndex] === '*') {
      starIndex = patternIndex;
      retryIndex = candidateIndex;
      patternIndex += 1;
      continue;
    }
    if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      retryIndex += 1;
      candidateIndex = retryIndex;
      continue;
    }
    return false;
  }

  while (normalizedPattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === normalizedPattern.length;
}

export const RequestMatchType = Object.freeze({
  ALL_REQUESTS
});

export function serializedUtf8Size(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  let bytes = 0;
  for (const character of serialized) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
