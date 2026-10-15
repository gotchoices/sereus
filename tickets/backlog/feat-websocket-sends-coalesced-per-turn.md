description: `@libp2p/websockets` sends each chunk of a write as its own WebSocket message, about half of them 16 bytes or less (Noise length prefixes, yamux headers). Joining the chunks one turn produces into one message cut a Galaxy S7's sends by 62% under NativeScript; React Native pays one base64 `sendBinary` native call per chunk the same way (GitHub #45, point 4).
files: packages/cadre-rn/polyfills/hermes.js (the WebSocket `bufferedAmount` getter ~384-408 is where a send wrapper would sit), packages/reference-app-ns/src/polyfills/websocket.ts
tradeoffs: libp2p reads a WebSocket as a byte stream, so message boundaries carry no meaning and joining is safe; the cost is one microtask of latency per write and a buffer copy. Measure on RN before shipping it in the kit.
----

# Coalesce WebSocket sends per turn

kjeib measured it under NativeScript (gotchoices/sereus#45): a `WebSocket.prototype.send` wrapper that joins the chunks of one turn into one message cut the S7's sends by 62%, both joining and idle. The same pattern applies to React Native, where each `send()` is a native bridge call.

Plan: a wrapper in the kit's polyfills (and the NativeScript app's) that queues sends and flushes on a microtask, preserving order and `bufferedAmount`; measure the RN send count and a join's CPU on a device before and after. Receiving is the relay's `@libp2p/websockets` and out of scope here; report it upstream with the numbers if the send side pays off.
