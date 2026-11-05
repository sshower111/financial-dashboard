"use client";
import { GripVertical, Minus, Plus, X, MoveHorizontal } from "lucide-react";
import { useLedger } from "@/store/ledger";
import { WIDGETS, WIDTHS, type LayoutItem } from "@/lib/layout";
import { useState, type ReactNode } from "react";
import type React from "react";

export function Panel({ item, right, children }: { item: LayoutItem; right?: ReactNode; children: ReactNode }) {
  const editing = useLedger((s) => s.editing);
  const { moveWidget, resizeWidget, removeWidget } = useLedger.getState();
  const [over, setOver] = useState(false);
  const meta = WIDGETS[item.i];
  const allowed = WIDTHS.filter((w) => w >= meta.minW);
  const nextW = allowed[(allowed.indexOf(item.w) + 1) % allowed.length];

  return (
    <section
      className={`panel flex min-h-0 min-w-0 flex-col border bg-bg ${over ? "border-accent" : "border-line"}`}
      style={{ "--w": item.w, "--h": item.h } as React.CSSProperties}
      draggable={editing}
      onDragStart={(e) => { e.dataTransfer.setData("text/widget", item.i); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => { if (editing) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); const from = e.dataTransfer.getData("text/widget"); if (from) moveWidget(from as LayoutItem["i"], item.i); }}
      aria-label={meta.title}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        {editing && <GripVertical size={14} className="cursor-grab text-muted" aria-hidden />}
        <h2 className="text-[12px] font-medium text-ink">{meta.title}</h2>
        <div className="ml-auto flex items-center gap-3">
          {editing ? (
            <div className="flex items-center gap-1 text-muted">
              <button className="flex h-6 items-center gap-1 border border-line px-1.5 hover:text-ink" onClick={() => resizeWidget(item.i, { w: nextW })} title="Change width">
                <MoveHorizontal size={12} /><span className="num text-[11px]">{item.w}/12</span>
              </button>
              <button className="grid h-6 w-6 place-items-center border border-line hover:text-ink disabled:opacity-30" disabled={item.h <= 1} onClick={() => resizeWidget(item.i, { h: (item.h - 1) as LayoutItem["h"] })} title="Shorter"><Minus size={12} /></button>
              <button className="grid h-6 w-6 place-items-center border border-line hover:text-ink disabled:opacity-30" disabled={item.h >= 4} onClick={() => resizeWidget(item.i, { h: (item.h + 1) as LayoutItem["h"] })} title="Taller"><Plus size={12} /></button>
              <button className="grid h-6 w-6 place-items-center border border-line hover:border-accent hover:text-accent" onClick={() => removeWidget(item.i)} title="Remove widget"><X size={12} /></button>
            </div>
          ) : right}
        </div>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="grid h-full min-h-24 place-items-center px-6 text-center text-muted">{children}</div>;
}
