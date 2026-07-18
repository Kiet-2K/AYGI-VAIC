"use client";

import { useState } from "react";

import { MAX_WAIT_CAP_SECONDS } from "@/lib/sim/adaptiveController";
import type { AiDebugSnapshot } from "@/lib/sim/engine";
import type { GreenPhase } from "@/lib/sim/signalController";
import { DIRECTIONS, type Direction } from "@/types/traffic";

/**
 * Live AI debug panel (Task G, in-app half). Reads the read-only
 * {@link AiDebugSnapshot} that the engine already ships on every 10 Hz snapshot
 * and renders what the adaptive brain is "seeing" and "thinking" right now:
 *   - per-phase PCU demand scores with the chosen-next phase highlighted,
 *   - the coarse traffic state + the human reason for the last decision,
 *   - per-direction queue / wait so a starving movement is visible at a glance.
 *
 * It is a pure presentational component (no engine access, no timers of its own):
 * the parent throttles updates via the snapshot channel, so this never adds RAF
 * work. Collapsed by default to stay out of the way; toggled by a corner button.
 */

const phaseLabel: Record<GreenPhase, string> = {
  NS_LEFT: "Bắc-Nam ←",
  NS_STRAIGHT_RIGHT: "Bắc-Nam ↑→",
  EW_LEFT: "Đông-Tây ←",
  EW_STRAIGHT_RIGHT: "Đông-Tây ↑→"
};

const directionLabel: Record<Direction, string> = {
  north: "Bắc",
  south: "Nam",
  east: "Đông",
  west: "Tây"
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

function DemandBar({ demand, max, chosen }: { demand: number; max: number; chosen: boolean }) {
  // Starvation adds a +1000 bonus; clamp the bar so one starved phase doesn't
  // flatten the others to invisibility — cap the visual scale at the max non-huge
  // score or the true max, whichever keeps the bars readable.
  const pct = max > 0 ? Math.min(100, (demand / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <div
        className={`h-full rounded-full ${chosen ? "bg-cyan-400" : "bg-slate-500"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function AiDebugPanel({ ai }: { ai: AiDebugSnapshot }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute right-4 top-4 z-10 rounded-lg border border-cyan-400/40 bg-slate-950/85 px-3 py-1.5 text-[10px] font-black uppercase tracking-wide text-cyan-300 shadow-panel backdrop-blur-md transition hover:bg-slate-900/90"
      >
        Phân tích điều tiết
      </button>
    );
  }

  const maxDemand = Math.max(1, ...ai.phaseDemands.map((r) => r.demand));

  return (
    <aside className="absolute right-4 top-4 z-10 w-72 rounded-2xl border border-cyan-500/40 bg-slate-950/90 p-4 text-slate-100 shadow-panel backdrop-blur-md">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300">Bộ điều khiển AI</p>
          <h2 className="mt-0.5 text-sm font-bold">Bộ não thích ứng</h2>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-slate-600 bg-slate-800/70 px-2 py-1 text-[10px] font-bold text-slate-300 transition hover:bg-slate-700/70"
        >
          Đóng
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className={`rounded-md border px-2 py-1 text-[10px] font-black ${stateStyle[ai.state] ?? stateStyle.FREE}`}>
          {stateLabel[ai.state] ?? ai.state}
        </span>
        {ai.preempted && (
          <span className="rounded-md border border-fuchsia-500/50 bg-fuchsia-500/15 px-2 py-1 text-[10px] font-black text-fuchsia-200">
            ƯU TIÊN
          </span>
        )}
      </div>

      <div className="mt-3 space-y-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Điểm nhu cầu / pha</p>
        {ai.phaseDemands.map((row) => {
          const isCurrent = row.phase === ai.currentGreen;
          return (
            <div key={row.phase}>
              <div className="flex items-center justify-between text-[10px]">
                <span className={row.chosen ? "font-bold text-cyan-300" : "text-slate-300"}>
                  {phaseLabel[row.phase]}
                  {isCurrent && <span className="ml-1 text-emerald-400">●</span>}
                  {row.chosen && <span className="ml-1 text-cyan-400">→ tiếp</span>}
                </span>
                <span className="font-mono text-slate-200">{row.demand.toFixed(1)}</span>
              </div>
              <div className="mt-0.5">
                <DemandBar demand={row.demand} max={maxDemand} chosen={row.chosen} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Hàng chờ / thời gian chờ</p>
        <div className="grid grid-cols-2 gap-1.5">
          {DIRECTIONS.map((d) => {
            const s = ai.stats[d];
            const starved = s.maxWaitingTime >= MAX_WAIT_CAP_SECONDS;
            return (
              <div key={d} className="rounded-lg bg-slate-800/70 p-1.5">
                <div className="flex items-center justify-between text-[10px] text-slate-300">
                  <span>{directionLabel[d]}</span>
                  <span className="font-mono">{s.queueLength} xe</span>
                </div>
                <p className={`font-mono text-xs font-bold ${starved ? "text-red-400" : "text-slate-200"}`}>
                  {Math.round(s.maxWaitingTime)}s
                  <span className="ml-1 text-[9px] font-normal text-slate-500">chờ tối đa</span>
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-3 rounded-lg bg-slate-900/60 p-2 text-[10px] leading-snug text-slate-300">
        <span className="font-bold text-slate-400">Quyết định: </span>
        {ai.reason}
      </p>
    </aside>
  );
}
