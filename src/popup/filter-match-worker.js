import {
  normalizeRequestMatch,
  requestMatchMatchesUrl
} from '../shared/utils/requestFilters.js';

self.addEventListener('message', event => {
  const runId = event.data?.runId;
  const candidateUrl = String(event.data?.candidateUrl || '');
  const filters = Array.isArray(event.data?.filters)
    ? event.data.filters
    : [];

  filters.forEach(filterData => {
    const filter = normalizeRequestMatch(filterData);
    self.postMessage({
      type: 'started',
      runId,
      filterId: filter.id
    });
    self.postMessage({
      type: 'result',
      runId,
      filterId: filter.id,
      matches: requestMatchMatchesUrl(filter, candidateUrl)
    });
  });

  self.postMessage({ type: 'done', runId });
});
