import jsPDF from "jspdf";
import * as XLSX from "xlsx";

import type { ViolationEvent } from "@/types/traffic";

const API_URL = process.env.NEXT_PUBLIC_TRAFFIC_API_URL ?? "http://127.0.0.1:8000";

export async function fetchViolations(): Promise<ViolationEvent[]> {
  const response = await fetch(`${API_URL}/api/violations`, { cache: "no-store" });
  if (!response.ok) throw new Error("Không thể tải nhật ký vi phạm.");
  const payload = await response.json() as { violations: ViolationEvent[] };
  return payload.violations;
}

export async function deleteViolations(ids?: string[]): Promise<number> {
  const response = ids
    ? await fetch(`${API_URL}/api/violations/delete-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids })
      })
    : await fetch(`${API_URL}/api/violations`, { method: "DELETE" });
  if (!response.ok) throw new Error("Không thể xóa bản ghi vi phạm.");
  return ((await response.json()) as { deleted: number }).deleted;
}

function rows(events: ViolationEvent[]) {
  return events.map((event) => ({
    "Biển số": event.licensePlate,
    "Loại xe": event.vehicleClass,
    "Hướng": event.direction,
    "Chuyển động": event.movement,
    "Vi phạm": event.violation,
    "Tín hiệu": event.signal,
    "Tốc độ (m/s)": event.evidence.speed,
    "Làn": event.evidence.laneId,
    "Thời gian": new Date(event.timestampMs).toLocaleString("vi-VN"),
    "Nút giao": event.intersection
  }));
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportViolations(events: ViolationEvent[], format: "csv" | "json" | "pdf" | "xlsx"): void {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    download(new Blob([JSON.stringify(events, null, 2)], { type: "application/json" }), `vi-pham-${stamp}.json`);
    return;
  }
  const data = rows(events);
  if (format === "csv") {
    const sheet = XLSX.utils.json_to_sheet(data);
    const csv = XLSX.utils.sheet_to_csv(sheet);
    download(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), `vi-pham-${stamp}.csv`);
    return;
  }
  if (format === "xlsx") {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), "Vi phạm");
    XLSX.writeFile(workbook, `vi-pham-${stamp}.xlsx`);
    return;
  }
  const document = new jsPDF();
  document.setFontSize(16);
  document.text("VIOLATION REPORT", 14, 16);
  document.setFontSize(9);
  let y = 26;
  data.forEach((row, index) => {
    if (y > 280) {
      document.addPage();
      y = 18;
    }
    document.text(`${index + 1}. ${row["Biển số"]} | ${row["Loại xe"]} | ${row["Vi phạm"]} | ${row["Thời gian"]}`, 14, y);
    y += 8;
  });
  document.save(`vi-pham-${stamp}.pdf`);
}

export function evidenceUrl(path?: string): string | null {
  return path ? `${API_URL}${path}` : null;
}
