# Dynamic `import()`

## What it is

JavaScript's `import("./module")` syntax returns a `Promise` that resolves
to the module namespace. Unlike static `import x from "./module"`,
the bundler treats it as a **runtime decision**, not a compile-time
edge in the dependency graph.

Two consequences:

1. **Code splitting.** The bundler emits the dynamically-imported module
   as a separate chunk loaded on demand.
2. **Tree-shaking exclusion.** A dynamic import gated by a runtime check
   (`if (process.env.X) await import(...)`) is *not followed* when the
   bundler walks the graph for other runtimes.

## Why we use it here

[`instrumentation.ts`](../instrumentation.ts) needs to call
`ensureSchema()` on server cold boot. The schema lives in
[`src/db.js`](../src/db.js), which `require`s `pg`. `pg` is
Node-native — it imports `fs` and `path`.

Next.js's `register()` hook is invoked across **all runtimes**, including
Edge. If `instrumentation.ts` statically imports `src/db.js`, webpack
walks that path while bundling for Edge and panics:

```
Module not found: Can't resolve 'path'
Module not found: Can't resolve 'fs'
```

The fix:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
```

Now:
- The Edge bundle contains only the shell `register()` and the runtime
  check. Webpack never follows the import for Edge.
- The Node bundle gets the full graph: `instrumentation-node` →
  `src/db` → `pg`.

## Tradeoffs vs alternatives

| Approach | Pro | Con |
|---|---|---|
| Static `import` | Tree-shaking sees everything; predictable | Breaks for multi-runtime files |
| `require()` inside an `if` | Same effect in CommonJS | Doesn't help in ESM; less idiomatic in TS |
| **Dynamic `import()`** | Runtime-conditional, idiomatic, bundler-aware | Promise; slightly more ceremony |
| Marker file like `pg.node.js` | Some bundlers respect naming conventions | Webpack/Next don't; fragile |

## Where it shows up

- [`instrumentation.ts`](../instrumentation.ts) — single dynamic import
  to load the Node-only body.

We use **static** `import` everywhere else in the project — there's no
other runtime split. PDF handling via `pdfjs-dist` is kept in
`serverExternalPackages` of [`next.config.js`](../next.config.js) so
webpack treats it as external rather than bundling its worker file.

## Related glossary

- [`instrumentation.md`](instrumentation.md) — the consumer of this
  pattern.

## External sources

- [MDN — `import()` expression](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import)
- [Next.js docs — Edge runtime](https://nextjs.org/docs/app/api-reference/edge)
- [V8 blog — Dynamic import](https://v8.dev/features/dynamic-import)
