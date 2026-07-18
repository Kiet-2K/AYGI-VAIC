"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BackendConnectionState,
  ControlAction,
  ControlAcknowledgement,
  SignalState,
  TrafficReport
} from "@/types/traffic";

const SOCKET_URL = process.env.NEXT_PUBLIC_TRAFFIC_WS_URL ?? "ws://localhost:8000/ws/traffic";
const STALE_AFTER_MS = 2_000;

interface TrafficSocketResult {
  connectionState: BackendConnectionState;
  signalState: SignalState | null;
  latencyMs: number | null;
  pendingCommand: ControlAction | null;
  error: string | null;
  sendCommand: (action: ControlAction) => boolean;
}

export function useTrafficSocket(report: TrafficReport | null): TrafficSocketResult {
  const [connectionState, setConnectionState] = useState<BackendConnectionState>("CONNECTING");
  const [signalState, setSignalState] = useState<SignalState | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [pendingCommand, setPendingCommand] = useState<ControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reportRef = useRef(report);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastStateAtRef = useRef(0);
  const pendingCommandsRef = useRef(new Map<string, ControlAction>());

  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  const sendCommand = useCallback((action: ControlAction) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN || pendingCommandsRef.current.size > 0) return false;
    const commandId = crypto.randomUUID();
    pendingCommandsRef.current.set(commandId, action);
    setPendingCommand(action);
    setError(null);
    socket.send(JSON.stringify({ type: "control_command", commandId, action }));
    return true;
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      setConnectionState("CONNECTING");
      const socket = new WebSocket(SOCKET_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectAttemptRef.current = 0;
        setConnectionState("CONNECTED");
        setError(null);
      };

      socket.onmessage = (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          setError("Backend trả về dữ liệu không hợp lệ.");
          return;
        }
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if (message.type === "signal_state") {
          const state = message as SignalState;
          lastStateAtRef.current = performance.now();
          setSignalState((current) => (!current || state.revision >= current.revision ? state : current));
          setLatencyMs(Math.max(0, Date.now() - state.serverTimestampMs));
          setConnectionState(state.telemetryStale ? "STALE" : "CONNECTED");
        } else if (message.type === "control_ack") {
          const acknowledgement = message as ControlAcknowledgement;
          pendingCommandsRef.current.delete(acknowledgement.commandId);
          setPendingCommand(pendingCommandsRef.current.values().next().value ?? null);
        } else if (message.type === "error") {
          setError("message" in message ? String(message.message) : "Backend báo lỗi.");
        }
      };

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        pendingCommandsRef.current.clear();
        setPendingCommand(null);
        setSignalState(null);
        setConnectionState("DISCONNECTED");
        if (!disposed) {
          const delay = Math.min(10_000, 500 * 2 ** reconnectAttemptRef.current++);
          reconnectTimer = window.setTimeout(connect, delay);
        }
      };

      socket.onerror = () => undefined;
    };

    connect();
    const reportTimer = window.setInterval(() => {
      const socket = socketRef.current;
      const latest = reportRef.current;
      if (socket?.readyState === WebSocket.OPEN && latest) socket.send(JSON.stringify(latest));
    }, 100);
    const staleTimer = window.setInterval(() => {
      if (
        socketRef.current?.readyState === WebSocket.OPEN &&
        lastStateAtRef.current > 0 &&
        performance.now() - lastStateAtRef.current > STALE_AFTER_MS
      ) {
        setConnectionState("STALE");
      }
    }, 250);

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      window.clearInterval(reportTimer);
      window.clearInterval(staleTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  return { connectionState, signalState, latencyMs, pendingCommand, error, sendCommand };
}
