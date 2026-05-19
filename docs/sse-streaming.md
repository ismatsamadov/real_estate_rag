# SSE — Server-Sent Events streaming

**TL;DR.** A simple HTTP-native protocol for streaming data from server
to client. Just `Content-Type: text/event-stream` and lines that look
like `data: {...}\n\n`. No WebSocket complexity, no second protocol to
operate. Built into every browser via `EventSource` (we use raw `fetch`
+ `ReadableStream` for finer control).

## What it is

SSE is a one-way streaming protocol on top of regular HTTP. The server
holds an HTTP response open and writes "events" as they happen; the
client reads them as a stream.

The wire format is plain text:

```
data: {"type":"sources","sources":[...]}\n
\n
data: {"type":"delta","text":"##"}\n
\n
data: {"type":"delta","text":" Available"}\n
\n
data: {"type":"done","stop_reason":"end_turn"}\n
\n
```

Each event is `data: <JSON>` followed by two newlines. That's it. Lines
beginning with `:` are comments (we use them for 15-second heartbeats
so proxies don't kill an idle connection).

## Why SSE, not WebSocket, not polling?

For one-way server-to-client streaming (which is what RAG is), SSE is
the simplest fit:

| | Polling | WebSocket | SSE |
|---|---|---|---|
| Direction | Client pull | Bidirectional | Server push |
| Protocol | Standard HTTP | Custom (RFC 6455) | Standard HTTP |
| Reconnect | Manual | Manual | **Built-in** (`EventSource` auto-reconnects with `Last-Event-ID`) |
| Proxy / CDN friendly | Yes | Often awkward | Yes |
| Browser support | Universal | Universal | Universal |
| Server complexity | Trivial | Higher (handshake, ping/pong) | Trivial (just write text) |

For RAG, we **only ever push** (sources → model name → tokens → done).
We never need the client to send something mid-stream. SSE is the right
abstraction.

## Why we use raw `fetch` instead of `EventSource`

The browser's built-in `EventSource` API:
- Forces GET requests (no POST body)
- Doesn't let you set custom headers (no auth cookies on cross-origin)
- Auto-reconnects on connection loss (which is good but harder to
  control for a one-shot RAG response)

We use `fetch()` with a POST body, then read `response.body` as a
`ReadableStream`. Same wire format, more control:

```js
const resp = await fetch("/api/ask/stream", {
  method: "POST",
  body: JSON.stringify({ question, sessionId }),
});
const reader = resp.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  // parse "data: {...}" events from the buffer
}
```

See [`app/components/ChatView.tsx`](../app/components/ChatView.tsx)
for the full client-side parser.

## Vercel + SSE notes

Vercel Functions support SSE on the Node.js runtime. The key gotchas:

- **`runtime = "nodejs"`** (not Edge — Edge has a 25-second
  first-byte requirement that's fragile for retrieval-then-stream)
- **`maxDuration`** must be set generously — `maxDuration = 300` in our
  case so a slow Claude stream can finish
- **`X-Accel-Buffering: no`** header — disables nginx-style response
  buffering that would otherwise wait until the response completes
  before sending anything

All three are set in [`app/api/ask/stream/route.ts`](../app/api/ask/stream/route.ts).

## Where in this codebase

- Server: [`app/api/ask/stream/route.ts`](../app/api/ask/stream/route.ts) —
  `ReadableStream` enqueues `data: ...\n\n` lines
- Client: [`app/components/ChatView.tsx`](../app/components/ChatView.tsx) —
  `fetch` + `getReader` + manual parser

## Read more

- [MDN — Server-Sent Events spec](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Vercel docs — Streaming with Functions](https://vercel.com/docs/functions/streaming-functions)
- [Why HTTP streaming is more useful than people think](https://hpbn.co/server-sent-events-sse/)
