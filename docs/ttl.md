# TTL — Time To Live

**TL;DR.** An expiration time attached to something — a cache entry, a
cookie, a DNS record. After the TTL, the system treats the value as
gone (or stale, depending on the system). We set TTLs on the retrieval
cache (5 minutes) and the session cookie (7 days).

## What it is

Originally a networking concept: the TTL in an IP packet's header
controls how many hops it can survive before routers drop it. Today
"TTL" generally means "how long this thing is valid for."

The pattern is the same in every system that uses it:

- Something gets created/cached with a `created_at` timestamp.
- Read paths check `now() - created_at < ttl`. If true, use it. If
  false, the value is stale → either drop it, refresh it, or refuse to
  return it.

The lifetime is set when the value is stored. Nobody has to remember to
clean up — the TTL does it.

## Where TTLs live in this codebase

| What | TTL | Why |
|---|---|---|
| Session cookie | 7 days | User can come back next week without re-logging |
| Retrieval cache (`lru-cache`) | 5 minutes | Repeat queries are cheap; corpus rarely changes mid-session |
| Anthropic prompt cache | 5 minutes (`ephemeral`) | Fixed by Anthropic — see [`prompt-caching.md`](prompt-caching.md) |
| Memory recall recency boost | 14-day half-life (decay, not hard TTL) | Newer memories matter more, but old ones still exist |

## How the retrieval cache TTL is enforced

We use the `lru-cache` npm package, which has built-in TTL support:

```js
const cache = new LRUCache({
  max: 500,            // up to 500 entries
  ttl: 300_000,        // 5 minutes in milliseconds
});

cache.set(key, value);  // expires in 5 min
cache.get(key);         // returns undefined if expired, otherwise value
```

The library tracks the creation time per entry. On `get`, if the entry
is past its TTL, it returns `undefined` and (lazily) evicts the entry.
We don't have to write any cleanup loop.

## How the cookie TTL is enforced

The cookie carries a `Max-Age` directive. The browser drops the cookie
from its store when the time expires:

```
Set-Cookie: pasha_session=ok; Max-Age=604800; httpOnly; sameSite=lax
```

Browser cookie storage handles the cleanup. The server doesn't need to
track which sessions are "expired" — once the cookie is gone, the
middleware redirects to `/login` and the user signs in again.

Unlike server-side sessions (e.g. a `sessions` row with an
`expires_at` column), our auth cookie carries the expiration in itself.
Stateless. No database lookup per request.

## TTL pitfalls worth knowing

- **TTL too long** → stale data. A 1-hour cache means corpus updates
  take 1 hour to propagate to users.
- **TTL too short** → cache stampede. A 1-second cache means every
  request re-hits the source.
- **Wall clock vs monotonic time** — `Date.now()` can jump backward
  if the system clock is adjusted. For short-lived caches this rarely
  matters; for long-lived ones use a monotonic source.
- **Lazy vs proactive eviction** — `lru-cache` is lazy (entries
  evicted on next access). Memory stays held until something asks for
  it. For long-running processes you might want proactive sweeping.

## Where in this codebase

- Retrieval cache TTL: [`src/retriever.js`](../src/retriever.js) →
  `config.retrieval.cacheTtlMs` (env `RAG_CACHE_TTL_MS`, default
  300000)
- Cookie max-age: [`app/api/auth/login/route.ts`](../app/api/auth/login/route.ts) →
  `COOKIE_MAX_AGE = 60 * 60 * 24 * 7`
- Memory recency decay (not strict TTL): [`src/memory.js`](../src/memory.js) →
  `RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000`

## Read more

- [MDN — Cookie `Max-Age`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie#max-agenumber)
- [`lru-cache` README — TTL section](https://github.com/isaacs/node-lru-cache#options)
