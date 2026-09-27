import WebSocket from 'ws';

// One reusable connection owns its heartbeat, reconnect timer and generation.
// Closing a connection invalidates books before a replacement can receive data.
export class LiveSocket {
  constructor({ url, heartbeatText, onOpen = () => {}, onMessage, onDisconnect = () => {}, onHealth = () => {}, onStatus = () => {}, retryMs = 500, heartbeatMs = 10000, staleMs = 25000 }) {
    Object.assign(this, { url, heartbeatText, onOpen, onMessage, onDisconnect, onHealth, onStatus, retryMs, heartbeatMs, staleMs });
    this.status = { status: 'connecting', messages: 0, reconnects: 0, lastMessageAt: null, connectedAt: null };
    this.attempt = 0;
    this.stopped = false;
  }
  start() { this.connect(); return this; }
  emitStatus() { this.onStatus({ ...this.status }); }
  send(value) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(typeof value === 'string' ? value : JSON.stringify(value)); }
  connect() {
    if (this.stopped) return;
    this.status.status = 'connecting'; this.emitStatus();
    const socket = this.socket = new WebSocket(this.url, { handshakeTimeout: 8000, perMessageDeflate: false });
    socket.on('open', () => {
      if (socket !== this.socket || this.stopped) return;
      this.status.status = 'connected'; this.status.connectedAt = Date.now();
      this.status.lastMessageAt = Date.now(); delete this.status.error;
      this.emitStatus();
      this.onOpen(this);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.status.lastMessageAt > this.staleMs) return this.reconnect('Stream heartbeat timed out');
        this.pingAt = performance.now();
        if (this.heartbeatText) this.send(this.heartbeatText); else socket.ping();
      }, this.heartbeatMs);
    });
    const healthy = () => {
      this.status.lastMessageAt = Date.now();
      this.attempt = 0;
      this.onHealth(this.status.lastMessageAt);
    };
    socket.on('ping', healthy); // ws sends the required protocol pong automatically.
    const pong = () => {
      if (this.pingAt != null) this.status.roundTripMs = performance.now() - this.pingAt;
      healthy();
    };
    socket.on('pong', pong);
    socket.on('message', raw => {
      if (socket !== this.socket || this.stopped) return;
      healthy();
      const text = raw.toString();
      if (text === 'PONG') { pong(); return; }
      this.status.messages++;
      try { this.onMessage(JSON.parse(text), this.status.lastMessageAt); }
      catch (error) { this.reconnect(`Stream resync: ${error.message}`); }
    });
    socket.on('error', error => { this.status.error = error.message; });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      clearInterval(this.heartbeat);
      this.onDisconnect();
      this.status.status = this.stopped ? 'stopped' : 'reconnecting';
      this.emitStatus();
      if (!this.stopped) {
        this.status.reconnects++;
        const delay = Math.min(30000, this.retryMs * 2 ** Math.min(this.attempt++, 6)) + Math.random() * this.retryMs;
        this.retry = setTimeout(() => this.connect(), delay);
      }
    });
  }
  reconnect(reason) {
    this.status.error = reason;
    this.onDisconnect();
    this.status.status = 'reconnecting'; this.emitStatus();
    this.socket?.terminate();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry); clearInterval(this.heartbeat);
    this.onDisconnect();
    this.socket?.terminate();
  }
}

export const POLYMARKET_STREAM = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
export const BINANCE_STREAM = 'wss://stream.binance.com:443/ws/btcusdt@bookTicker';
