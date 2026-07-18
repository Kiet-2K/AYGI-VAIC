import { useEffect, useState } from "react";

import { DIRECTIONS, ROAD_NAMES, type DetectionBox } from "@/types/traffic";

export type DetectionSink = (boxes: DetectionBox[]) => void;

const classLabel: Record<string, string> = {
  MOTORBIKE: "xe máy",
  CAR: "ô tô",
  BUS: "xe buýt",
  TRUCK: "xe tải",
  HEAVY_TRUCK: "xe tải nặng",
  AMBULANCE: "xe cứu thương",
  FIRE_TRUCK: "xe cứu hỏa",
  POLICE: "xe công an",
  MILITARY: "xe quân sự"
};

export function FakeYoloOverlay({ registerSink }: { registerSink: (sink: DetectionSink) => void }) {
  const [boxes, setBoxes] = useState<DetectionBox[]>([]);

  useEffect(() => {
    registerSink(setBoxes);
    return () => registerSink(() => undefined);
  }, [registerSink]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="Lớp nhận diện xe mô phỏng">
      <div className="absolute right-4 top-4 rounded-lg bg-slate-950/75 px-3 py-2 text-[10px] text-slate-200 backdrop-blur-sm">
        <p className="font-bold text-cyan-300">Đang phát hiện: {boxes.length} xe</p>
        {DIRECTIONS.map((direction) => (
          <p key={direction}>{ROAD_NAMES[direction]}: {boxes.filter((box) => box.direction === direction).length}</p>
        ))}
      </div>
      {boxes.map((box) => {
        const violation = box.wrongWay || box.redLightViolation;
        const borderColor = violation ? "#f87171" : box.emergency ? "#e879f9" : box.stopped ? "#fbbf24" : "#45f596";
        const label = classLabel[box.vehicleClass] ?? box.vehicleClass.toLowerCase();
        return (
          <div
            key={box.id}
            className="absolute border-2"
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
              borderColor,
              boxShadow: `0 0 10px ${borderColor}99`
            }}
          >
            <span
              className="absolute -top-6 left-0 flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-slate-950"
              style={{ backgroundColor: borderColor }}
            >
              #{box.trackId} {label} {box.confidence.toFixed(2)} · {box.speed.toFixed(1)} m/s
              {box.emergency && <span className="rounded bg-fuchsia-900 px-1 text-fuchsia-100">KHẨN CẤP</span>}
            </span>
            {violation && (
              <span className="absolute left-0 top-full mt-1 whitespace-nowrap rounded bg-red-950/95 px-1.5 py-1 text-[9px] font-bold text-red-100">
                BIỂN SỐ: {box.licensePlate}
                {box.redLightViolation && <span className="ml-1 text-red-300">VƯỢT ĐÈN ĐỎ</span>}
                {box.wrongWay && <span className="ml-1 text-amber-300">ĐI SAI CHIỀU</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
