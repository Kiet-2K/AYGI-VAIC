"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { deleteViolations, exportViolations, fetchViolations } from "@/lib/violations";
import { VEHICLE_CLASSES } from "@/lib/sim/vehicleClasses";
import type { ViolationEvent } from "@/types/traffic";

const labels: Record<string, string> = {
  RED_LIGHT: "Vượt đèn đỏ",
  WRONG_WAY: "Đi sai chiều"
};

export default function ViolationsPage() {
  const [events, setEvents] = useState<ViolationEvent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<ViolationEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setEvents(await fetchViolations());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể tải dữ liệu.");
    }
  };
  useEffect(() => { void load(); }, []);

  const allSelected = events.length > 0 && selected.size === events.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(events.map((event) => event.id).filter((id): id is string => Boolean(id))));
  const toggle = (id?: string) => {
    if (!id) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const remove = async (ids?: string[]) => {
    const target = ids ?? [...selected];
    if (target.length === 0) return;
    if (!window.confirm(`Xác nhận xóa ${target.length} bản ghi vi phạm? Biển số liên quan sẽ được gỡ blacklist.`)) return;
    try {
      await deleteViolations(target);
      setSelected(new Set());
      setDetail(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể xóa dữ liệu.");
    }
  };
  const removeAll = async () => {
    if (events.length === 0 || !window.confirm(`Xác nhận xóa toàn bộ ${events.length} bản ghi vi phạm?`)) return;
    try {
      await deleteViolations();
      setSelected(new Set());
      setDetail(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể xóa dữ liệu.");
    }
  };

  const illustration = useMemo(() => detail ? VEHICLE_CLASSES[detail.vehicleClass as keyof typeof VEHICLE_CLASSES] : null, [detail]);

  return (
    <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><Link href="/" className="text-sm text-cyan-300">← Quay lại mô phỏng</Link><h1 className="mt-2 text-2xl font-black">Nhật ký vi phạm</h1></div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => exportViolations(events, "csv")} className="rounded border border-slate-600 px-3 py-2 text-xs">CSV</button>
            <button onClick={() => exportViolations(events, "json")} className="rounded border border-slate-600 px-3 py-2 text-xs">JSON</button>
            <button onClick={() => exportViolations(events, "pdf")} className="rounded border border-slate-600 px-3 py-2 text-xs">PDF</button>
            <button onClick={() => exportViolations(events, "xlsx")} className="rounded border border-slate-600 px-3 py-2 text-xs">XLSX</button>
            <button onClick={() => void load()} className="rounded border border-cyan-500/50 px-3 py-2 text-xs">Làm mới</button>
          </div>
        </div>
        {error && <p className="mt-4 rounded border border-red-500/40 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={toggleAll} className="rounded bg-slate-800 px-3 py-2 text-xs">{allSelected ? "Bỏ chọn tất cả" : "Chọn tất cả"}</button>
          <button onClick={() => void remove()} disabled={selected.size === 0} className="rounded bg-red-700 px-3 py-2 text-xs disabled:opacity-40">Xóa đã chọn ({selected.size})</button>
          <button onClick={() => void removeAll()} className="rounded bg-red-950 px-3 py-2 text-xs">Xóa tất cả</button>
        </div>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
          <table className="w-full min-w-[850px] text-left text-sm"><thead className="bg-slate-800 text-xs uppercase text-slate-300"><tr><th className="p-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th><th className="p-3">Xe</th><th className="p-3">Biển số</th><th className="p-3">Vi phạm</th><th className="p-3">Hướng / chuyển động</th><th className="p-3">Thời gian</th><th className="p-3" /></tr></thead><tbody>
            {events.map((event) => <tr key={event.id ?? `${event.trackId}-${event.timestampMs}`} className="border-t border-slate-800 hover:bg-slate-800/70"><td className="p-3"><input type="checkbox" checked={Boolean(event.id && selected.has(event.id))} onChange={() => toggle(event.id)} /></td><td className="p-3"><button onClick={() => setDetail(event)} className="text-left text-cyan-200">{event.vehicleClass}</button></td><td className="p-3 font-mono font-bold">{event.licensePlate}</td><td className="p-3 text-red-300">{labels[event.violation] ?? event.violation}</td><td className="p-3">{event.direction} · {event.movement}</td><td className="p-3 text-slate-400">{new Date(event.timestampMs).toLocaleString("vi-VN")}</td><td className="p-3"><button onClick={() => void remove(event.id ? [event.id] : [])} className="text-xs text-red-300">Xóa</button></td></tr>)}
          </tbody></table>
          {events.length === 0 && <p className="p-8 text-center text-slate-400">Chưa có vi phạm.</p>}
        </div>
      </div>
      {detail && <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4" onClick={() => setDetail(null)}><section className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl border border-slate-700 bg-slate-900 p-5" onClick={(event) => event.stopPropagation()}><div className="flex justify-between"><h2 className="text-xl font-black">Chi tiết vi phạm · {detail.licensePlate}</h2><button onClick={() => setDetail(null)}>Đóng</button></div><div className="mt-4 grid gap-4 md:grid-cols-2"><div><p className="mb-1 text-xs text-slate-400">Minh họa loại xe</p><div className="flex h-48 items-center justify-center rounded-lg bg-slate-800 text-7xl" style={{ color: illustration?.color }}>🚗</div><p className="mt-2 text-center text-sm font-bold text-slate-200">{detail.vehicleClass}</p></div><div className="space-y-2 text-sm"><p><b>Loại xe:</b> {detail.vehicleClass}</p><p><b>Biển số:</b> {detail.licensePlate}</p><p><b>Lý do:</b> {labels[detail.violation] ?? detail.violation}</p><p><b>Hướng:</b> {detail.direction} · {detail.movement}</p><p><b>Tín hiệu:</b> {detail.signal}</p><p><b>Tốc độ:</b> {detail.evidence.speed.toFixed(1)} m/s</p><p><b>Làn:</b> {detail.evidence.laneId}</p><p><b>Nút giao:</b> {detail.intersection}</p></div></div></section></div>}
    </main>
  );
}
