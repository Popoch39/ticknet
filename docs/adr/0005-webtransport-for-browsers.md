# Browsers will be reached through WebTransport

Browsers cannot open UDP sockets, so a browser Client needs another Transport. We plan for WebTransport datagrams, once Bun supports WebTransport natively, rather than WebRTC data channels or a WebSocket fallback: WebTransport gives unreliable datagrams with far less setup than WebRTC, while WebSocket would put every Delivery mode behind TCP's head-of-line blocking. v1 ships no browser Client; it only guarantees that core has no Bun dependency and that the Transport interface is the single thing a browser adapter has to implement.
