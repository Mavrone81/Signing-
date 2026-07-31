"use client";

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { buttonClasses } from "@/components/ui/Button";

// Adapted from "enshrine HRms"'s onboarding signature pad
// (app/onboard/[token]/signature-pad.tsx): hi-dpi pointer-events canvas,
// pointer capture, and toDataURL('image/png')-on-stroke-end. Stripped of
// next-intl (this app has no i18n) and restyled to this app's Bevora design tokens
// (border-edge/text-muted, not VO's border-line/text-muted-2/text-action).
// Emits a PNG data URL with a transparent background on stroke end, or
// null when cleared.
export function SignaturePad({
  onChange,
}: {
  onChange: (dataUrl: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);

  const ctxOf = () => canvasRef.current!.getContext("2d")!;

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a1f2b";
  }, []);

  useEffect(() => {
    setup();
    // The pad mounts fresh each time the modal's Draw tab becomes active, so
    // this also satisfies "focus the active tab's control on open".
    canvasRef.current?.focus();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
  }, [setup]);

  function point(e: ReactPointerEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(e: ReactPointerEvent) {
    drawing.current = true;
    canvasRef.current!.setPointerCapture(e.pointerId);
    const { x, y } = point(e);
    const ctx = ctxOf();
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(e: ReactPointerEvent) {
    if (!drawing.current) return;
    e.preventDefault();
    const { x, y } = point(e);
    const ctx = ctxOf();
    ctx.lineTo(x, y);
    ctx.stroke();
    inked.current = true;
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current) onChange(canvasRef.current!.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current!;
    ctxOf().clearRect(0, 0, canvas.width, canvas.height);
    inked.current = false;
    onChange(null);
  }

  return (
    <div>
      <div className="relative rounded-lg border border-edge bg-white">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label="Draw your signature"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerLeave={up}
          className="h-40 w-full touch-none rounded-lg"
          style={{ touchAction: "none" }}
        />
        <span className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-muted">
          Sign above
        </span>
      </div>
      <button
        type="button"
        onClick={clear}
        className={buttonClasses("secondary", "sm", "mt-2")}
      >
        Clear
      </button>
    </div>
  );
}
