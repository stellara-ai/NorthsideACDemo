// Live updates for the app backend over a single multiplexed WebSocket.
//
// Protocol (verified against the backend server): connect to the realtime URL
// carrying the project id, authenticate with a post-connect `authentication`
// message (the browser cannot set connection headers, and the `?jwt=` query is
// ignored server-side), then `subscribe` to channels via messages. Row events
// arrive as `event` messages. The socket auto-reconnects with backoff and
// re-authenticates + resubscribes.
//
// The authentication message carries the SESSION SECRET issued at signup/login
// (stored on the session), NOT the short-lived data token — realtime rejects a
// data token (close code 1008). Without a stored secret the socket stays
// unauthenticated (public_read channels still deliver events).

import { auth } from "./auth";
import { config } from "./config";
import { apiBase, hydrateRow } from "./data";
import type { RealtimeEvent, RealtimeEventType, Unsubscribe } from "./types";

type Listener = (event: RealtimeEvent) => void;

interface WireEvent {
  events?: string[];
  channels?: string[];
  payload?: Record<string, unknown>;
}

interface WireMessage {
  type?: string;
  data?: unknown;
}

// channel -> set of callbacks
const listeners = new Map<string, Set<Listener>>();

let socket: WebSocket | null = null;
let reconnectAttempts = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closedByUs = false;
// The server accepts messages only after its own "connected" message (a message sent on open
// is refused with 1008 "Missing project context"), so authenticate and subscribe then.
let serverReady = false;

const PING_INTERVAL_MS = 20000;
const SUBSCRIPTION_ID = "app-backend-client";
/** Give up reconnecting after this many consecutive failures (avoid endless loops). */
const MAX_RECONNECT_ATTEMPTS = 60;

function realtimeAvailable(): boolean {
  return typeof WebSocket !== "undefined";
}

function tableChannel(table: string): string {
  return `tablesdb.${config.databaseId}.tables.${table}.rows`;
}

function rowChannel(table: string, id: string): string {
  return `${tableChannel(table)}.${id}`;
}

function wsUrl(): string {
  const base = apiBase().replace(/^http/i, "ws"); // http->ws, https->wss
  return `${base}/realtime?project=${encodeURIComponent(config.projectId)}`;
}

function send(message: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN && serverReady) {
    socket.send(JSON.stringify(message));
  }
}

function authenticate(): void {
  const session = auth.currentSession();
  const secret = session?.realtime_secret ?? null;
  if (secret) {
    send({ type: "authentication", data: { session: secret } });
  }
  // No stored secret (signed out, or none issued): stay unauthenticated —
  // public_read channels still deliver events.
}

function sendSubscribe(): void {
  const channels = [...listeners.keys()];
  if (channels.length === 0) return;
  send({ type: "subscribe", data: [{ subscriptionId: SUBSCRIPTION_ID, channels, queries: [] }] });
}

function startPing(): void {
  stopPing();
  pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
}

function stopPing(): void {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function backoffMs(attempt: number): number {
  if (attempt < 5) return 1000;
  if (attempt < 15) return 5000;
  if (attempt < 100) return 10000;
  return 60000;
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  if (listeners.size === 0) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn("[backend] realtime: giving up reconnecting after repeated failures.");
    return;
  }
  const delay = backoffMs(reconnectAttempts);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function eventTypeFromEvents(events: string[]): RealtimeEventType {
  const joined = events.join(" ");
  if (joined.includes(".delete")) return "delete";
  if (joined.includes(".update")) return "update";
  return "create";
}

function dispatchEvent(data: WireEvent): void {
  if (!data || !Array.isArray(data.channels)) return;
  const type = eventTypeFromEvents(data.events ?? []);
  const row = hydrateRow(data.payload ?? {});
  const delivered = new Set<Listener>();
  for (const channel of data.channels) {
    const set = listeners.get(channel);
    if (!set) continue;
    for (const callback of set) {
      if (delivered.has(callback)) continue;
      delivered.add(callback);
      callback({ type, row });
    }
  }
}

function handleMessage(raw: unknown): void {
  if (typeof raw !== "string") return;
  let message: WireMessage;
  try {
    message = JSON.parse(raw) as WireMessage;
  } catch {
    return;
  }
  switch (message.type) {
    case "event":
      dispatchEvent(message.data as WireEvent);
      break;
    case "connected":
      serverReady = true;
      authenticate();
      sendSubscribe();
      break;
    case "response":
    case "pong":
    default:
      break;
  }
}

function connect(): void {
  if (!realtimeAvailable()) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  closedByUs = false;
  serverReady = false;
  const ws = new WebSocket(wsUrl());
  socket = ws;

  // Each handler belongs to ITS socket: a replaced socket's late events change nothing.
  ws.onopen = () => {
    if (ws !== socket) return;
    reconnectAttempts = 0;
    startPing();
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (ws === socket) handleMessage(ev.data);
  };
  ws.onclose = (ev: CloseEvent) => {
    if (ws !== socket) return;
    stopPing();
    socket = null;
    serverReady = false;
    if (ev.code === 1008) {
      // Policy violation = auth rejected. Reconnecting would re-send the same bad
      // credential and tight-loop; surface it and stop instead.
      console.warn(
        "[backend] realtime auth was rejected (1008) — live updates are disabled for this session.",
      );
      return;
    }
    if (!closedByUs) scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose fires next and drives reconnect.
  };
}

function ensureConnection(): void {
  if (!socket) connect();
  else if (socket.readyState === WebSocket.OPEN && serverReady) sendSubscribe();
}

function teardownIfIdle(): void {
  if (listeners.size > 0) return;
  closedByUs = true;
  stopPing();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
}

function addListener(channel: string, callback: Listener): Unsubscribe {
  if (!realtimeAvailable()) return () => undefined;
  let set = listeners.get(channel);
  if (!set) {
    set = new Set<Listener>();
    listeners.set(channel, set);
  }
  set.add(callback);
  ensureConnection();

  return () => {
    const current = listeners.get(channel);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) {
      listeners.delete(channel);
      send({ type: "unsubscribe", data: [{ subscriptionId: SUBSCRIPTION_ID, channels: [channel] }] });
    }
    teardownIfIdle();
  };
}

/** Subscribe to all row changes on a table. Returns an unsubscribe function. */
export function subscribeToTable(table: string, callback: Listener): Unsubscribe {
  return addListener(tableChannel(table), callback);
}

/** Subscribe to changes on a single row. Returns an unsubscribe function. */
export function subscribeToRow(table: string, id: string, callback: Listener): Unsubscribe {
  return addListener(rowChannel(table, id), callback);
}
