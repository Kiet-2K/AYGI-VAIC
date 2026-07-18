"use client";

import type { EngineSnapshot } from "@/lib/sim/engine";
import {
  DIRECTIONS,
  ROAD_NAMES,
  type BackendConnectionState,
  type ControlAction,
  type DirectionTrafficCounts,
  type SignalColor
} from "@/types/traffic";

const signalLabel: Record<SignalColor, string> = { GREEN: "XANH", YELLOW: "VÀNG", RED: "ĐỎ" };
const signalStyle: Record<SignalColor, string> = {
  GREEN: "bg-emerald-400 text-emerald-950",
  YELLOW: "bg-amber-300 text-amber-950",
  RED: "bg-red-500 text-white"
};
const stateLabel: Record<string, string> = {
  FREE: "THÔNG THOÁNG",
  BUSY: "ĐÔNG",
  CONGESTED: "ÙN TẮC",
  GRIDLOCK: "KẸT CỨNG"
};
const stateStyle: Record<string, string> = {
  FREE: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  BUSY: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  CONGESTED: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  GRIDLOCK: "bg-red-500/25 text-red-300 border-red-500/50"
};
const phaseLabel: Record<string, string> = {
  NS_LEFT: "Bắc–Nam rẽ trái",
  NS_STRAIGHT_RIGHT: "Bắc–Nam đi thẳng và rẽ phải",
  EW_LEFT: "Đông–Tây rẽ trái",
  EW_STRAIGHT_RIGHT: "Đông–Tây đi thẳng và rẽ phải"
};

function ControlButton({
  label,
  onClick,
  disabled,
  tone = "default",
  active = false
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  tone?: "default" | "danger" | "warn";
  active?: boolean;
}) {
  const toneStyle =
    tone === "danger"
      ? "border-red-500/50 bg-red-500/15 text-red-200 hover:bg-red-500/25"
      : tone === "warn"
        ? "border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
        : "border-slate-600 bg-slate-800/70 text-slate-200 hover:bg-slate-700/70";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide transition ${toneStyle} ${active ? "ring-2 ring-cyan-400/70" : ""} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

export interface DashboardControls {
  onAuto: () => void;
  onManual: () => void;
  onRequestNext: () => void;
  onEmergency: () => void;
  onClearEmergency: () => void;
  onReset: () => void;
}

function connectionText(state: BackendConnectionState, latencyMs: number | null): string {
  if (state === "CONNECTED") return `Backend đã kết nối${latencyMs === null ? "" : ` · ${latencyMs} ms`}`;
  if (state === "CONNECTING") return "Backend đang kết nối";
  if (state === "STALE") return "Dữ liệu backend quá hạn";
  return "Mất kết nối backend";
}

export function TrafficDashboard({
  counts,
  snapshot,
  connectionState,
  latencyMs,
  pendingCommand,
  backendError,
  fps,
  controls
}: {
  counts: DirectionTrafficCounts;
  snapshot: EngineSnapshot;
  connectionState: BackendConnectionState;
  latencyMs: number | null;
  pendingCommand: ControlAction | null;
  backendError: string | null;
  fps: number;
  controls: DashboardControls;
}) {
  const controlsDisabled = connectionState !== "CONNECTED" || pendingCommand !== null;

  return (
    <aside className="absolute left-4 top-4 z-10 w-80 rounded-2xl border border-slate-600/80 bg-slate-950/85 p-4 text-slate-100 shadow-panel backdrop-blur-md">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Bản sao số giao thông</p>
          <h1 className="mt-1 text-lg font-bold">Ngã tư thông minh</h1>
        </div>
        <span
          className={`mt-1 h-3 w-3 rounded-full ${connectionState === "CONNECTED" ? "bg-emerald-400 shadow-[0_0_10px_#4ade80]" : connectionState === "STALE" ? "bg-amber-400" : "bg-red-500"}`}
          title={connectionText(connectionState, latencyMs)}
        />
      </div>

      <div className="mt-4 rounded-xl border border-cyan-400/25 bg-cyan-950/35 p-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-200">Điều tiết hiện tại</p>
        <p className="text-sm font-semibold text-cyan-50">{phaseLabel[snapshot.phaseLabel.split("_").slice(0, -1).join("_")] ?? phaseLabel[snapshot.phaseLabel] ?? "Giữ toàn đỏ"}</p>
        <p className="mt-1 text-[10px] text-slate-400">Pha dự kiến: {phaseLabel[snapshot.nextLabel] ?? snapshot.nextLabel}</p>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className={`rounded-md border px-2 py-1 text-[10px] font-black ${stateStyle[snapshot.state] ?? stateStyle.FREE}`}>
          {stateLabel[snapshot.state] ?? snapshot.state}
        </span>
        <span className="rounded-md border border-slate-600 bg-slate-800/70 px-2 py-1 text-[10px] font-bold text-slate-300">
          {snapshot.manual ? "THỦ CÔNG" : "TỰ ĐỘNG"}
        </span>
      </div>

      {snapshot.preempted && (
        <div className="mt-3 rounded-lg border border-fuchsia-500/50 bg-fuchsia-500/15 px-2 py-1.5 text-[10px] font-black uppercase tracking-wide text-fuchsia-200">
          Ưu tiên xe khẩn cấp · {snapshot.preemptTarget ? phaseLabel[snapshot.preemptTarget] : "đang xác định"}
        </div>
      )}

      <p className="mt-2 rounded-lg bg-slate-900/60 p-2 text-[10px] leading-snug text-slate-300">
        <span className="font-bold text-slate-400">Lý do: </span>{snapshot.reason}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {DIRECTIONS.map((direction) => {
          const signal = snapshot.signals[direction];
          const count = counts[direction];
          return (
            <div key={direction} className="rounded-lg bg-slate-800/80 p-2">
              <div className="flex items-start justify-between gap-1 text-[10px] text-slate-300">
                <span>{ROAD_NAMES[direction]}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-black ${signalStyle[signal]}`}>{signalLabel[signal]}</span>
              </div>
              <p className="mt-1 text-sm font-bold">Tổng xe: {count.total}</p>
              <p className="text-xs text-amber-200">Xe đang chờ: {count.waiting}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <ControlButton label="Tự động" onClick={controls.onAuto} active={!snapshot.manual} disabled={controlsDisabled} />
        <ControlButton label="Thủ công" onClick={controls.onManual} active={snapshot.manual} disabled={controlsDisabled} />
        <ControlButton label="Chuyển pha an toàn" onClick={controls.onRequestNext} tone="warn" disabled={controlsDisabled} />
        <ControlButton label="Giữ toàn đỏ" onClick={controls.onEmergency} tone="danger" disabled={controlsDisabled} />
        <ControlButton label="Bỏ giữ toàn đỏ" onClick={controls.onClearEmergency} disabled={controlsDisabled} />
        <ControlButton label="Khởi động lại" onClick={controls.onReset} disabled={controlsDisabled} />
      </div>

      {pendingCommand && <p className="mt-2 text-[10px] text-cyan-300">Đang chờ backend xác nhận lệnh {pendingCommand}…</p>}
      {backendError && <p className="mt-2 text-[10px] text-red-300">{backendError}</p>}

      <div className="mt-3 flex items-center justify-between border-t border-slate-700 pt-3 text-xs text-slate-400">
        <span>{connectionText(connectionState, latencyMs)}</span>
        <span className="font-mono text-slate-200">{fps} FPS</span>
      </div>
    </aside>
  );
}
