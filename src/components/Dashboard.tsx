"use client";
import { useLedger } from "@/store/ledger";
import { useScopedData } from "@/store/derived";
import { Panel } from "./Panel";
import { Hero } from "./Hero";
import { TopBar } from "./TopBar";
import { LiveSync } from "./LiveSync";
import { Feed } from "./widgets/Feed";
import { Anomalies } from "./widgets/Anomalies";
import { Forecast } from "./widgets/Forecast";
import { Pacing } from "./widgets/Pacing";
import { Copilot } from "./widgets/Copilot";
import { Accounts } from "./widgets/Accounts";
import { Holdings } from "./widgets/Holdings";
import { Spending } from "./widgets/Spending";
import { Recurring } from "./widgets/Recurring";
import type { WidgetId } from "@/lib/layout";
import type { ComponentType } from "react";

const REGISTRY: Record<WidgetId, ComponentType> = {
  feed: Feed, anomalies: Anomalies, forecast: Forecast, pacing: Pacing, copilot: Copilot,
  accounts: Accounts, holdings: Holdings, spending: Spending, recurring: Recurring,
};

export function Dashboard() {
  const { status, error, layout, editing } = useLedger();
  const scoped = useScopedData();
  const noAccounts = status === "ready" && scoped != null && scoped.accounts.length === 0;
  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-10 md:px-6">
      <LiveSync />
      <TopBar />
      {status === "loading" && <div className="py-24 text-center text-muted">Loading ledger…</div>}
      {status === "error" && <div className="my-6 border border-accent px-4 py-3 text-accent">Could not load ledger: {error}</div>}
      {status === "ready" && (
        <main className="mt-5 flex flex-col gap-5">
          {noAccounts && (
            <p className="border border-dashed border-line px-4 py-3 text-[13px] text-muted">
              No accounts on this dashboard yet. Open the dashboard that has them, click <span className="text-ink">Edit layout</span>, and use <span className="text-ink">Move to</span> in the Accounts panel.
            </p>
          )}
          <Hero />
          {editing && <p className="text-[12px] text-muted">Each dashboard has its own layout. In the Accounts panel, <span className="text-ink">Move to</span> puts an account on another dashboard.</p>}
          {editing && <p className="text-[12px] text-muted">Drag panels to reorder. Use the width and height controls to resize. Layout saves automatically.</p>}
          <div className="dash-grid grid grid-cols-1 gap-4 md:grid-cols-12" style={{ gridAutoRows: "170px", gridAutoFlow: "row dense" }}>
            {layout.map((item) => {
              const W = REGISTRY[item.i];
              return <Panel key={item.i} item={item}><W /></Panel>;
            })}
          </div>
          {!layout.length && <div className="border border-dashed border-line py-16 text-center text-muted">All widgets removed. Use <span className="text-ink">Edit layout → Add widget</span>.</div>}
        </main>
      )}
    </div>
  );
}
