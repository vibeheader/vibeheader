// Optional c entries are comments for the corresponding h tuples.
// Header order is carried by h itself, including when c is omitted.
export function validateSharedProfileComments(data) {
  const invalid = () => { throw new Error('Invalid shared Profile comments'); };
  if (!data || Object.keys(data).sort().join(',') !== 'c,f,h,n,v'
    || data.v !== 2 || typeof data.n !== 'string'
    || !Array.isArray(data.h) || !data.h.length || !Array.isArray(data.f)) invalid();
  for (const header of data.h) {
    if (!Array.isArray(header) || header.length !== 2
      || typeof header[0] !== 'string' || !header[0].trim()
      || typeof header[1] !== 'string') invalid();
  }
  for (const filter of data.f) {
    if (!Array.isArray(filter) || filter.length !== 2
      || typeof filter[0] !== 'string' || typeof filter[1] !== 'boolean') invalid();
  }
  if (!Array.isArray(data.c) || data.c.length !== data.h.length) invalid();
  for (const comment of data.c) if (typeof comment !== 'string') invalid();
}
