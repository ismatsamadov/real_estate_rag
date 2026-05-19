# Next.js instrumentation

## What it is

Next.js exposes a top-level hook called `register()` exported from
`instrumentation.ts` (or `.js`) at the project root. The hook runs **once
per server cold boot**, before any request is handled. It's the only
officially-supported lifecycle hook in App Router. Source: [Next.js docs —
Instrumentation](https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation).

A single `register()` is invoked across all runtimes a server uses (Node,
Edge). To do Node-only work, you gate on `process.env.NEXT_RUNTIME` and
**dynamic-import** the Node-only body — this keeps Node packages out of
the Edge bundle so webpack doesn't try to resolve `fs`/`path` for the
Edge runtime.

## Why we use it here

We had a CLI `scripts/migrate.js` whose only job was `await
db.ensureSchema()`. That meant operators had to remember to run
`npm run migrate` before `npm run start` on a fresh deploy. It also
meant Vercel cold boots couldn't self-bootstrap.

Moving the schema bootstrap into `instrumentation.ts` makes the app
self-sufficient: a fresh `next start` on a fresh Neon database is
sufficient to create every table, index, FK, and the pgvector extension.

`ensureSchema()` is idempotent (every `CREATE` is `IF NOT EXISTS`; FK
adds are guarded by `information_schema` lookups), so it's safe to run
on every cold boot.

## Where it shows up

- [`instrumentation.ts`](../instrumentation.ts) — the gated wrapper
  ```ts
  export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") {
      await import("./instrumentation-node");
    }
  }
  ```
- [`instrumentation-node.ts`](../instrumentation-node.ts) — the Node-only
  body that requires `./src/db` and calls `ensureSchema()`.
- [`src/db.js`](../src/db.js) — `ensureSchema()` itself.

On every boot you should see in the server log:

```
[instrumentation] schema ready
```

## Why two files?

If `instrumentation.ts` directly required `./src/db`, webpack would
statically follow that import and try to bundle `pg` (a Node-native
package using `fs` and `path`) into the Edge bundle. The build would
fail with:

```
Module not found: Can't resolve 'path'
Module not found: Can't resolve 'fs'
```

Splitting into a separate file with a **dynamic** `import()` lets the
bundler skip Node-only modules for the Edge runtime. The Edge bundle
contains nothing more than the `register()` shell; the heavy DB code
only loads on Node.

## Tradeoffs vs alternatives

| Approach | Pro | Con |
|---|---|---|
| `scripts/migrate.js` (CLI) | Explicit, runs once | Easy to forget; not Vercel-friendly |
| First-request lazy migration in every route | No CLI step | Per-request `IF NOT EXISTS` overhead; race conditions on concurrent first requests |
| **`instrumentation.ts`** | Self-bootstrapping; runs once; no race | Requires the dynamic-import trick to keep `pg` out of Edge bundles |

## Related glossary

- [`dynamic-import.md`](dynamic-import.md) — why `await import(...)` is
  the answer to runtime-conditional bundling.
- [`idempotency.md`](idempotency.md) — why running `ensureSchema()` on
  every boot is safe.

## External sources

- [Next.js docs — Instrumentation](https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation)
- [Next.js docs — `NEXT_RUNTIME`](https://nextjs.org/docs/app/api-reference/edge#runtime-environment-variables)
