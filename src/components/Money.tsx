import { money } from "@/lib/format";

/** Right-aligned mono amount with a muted currency code. Spend (+) shows as negative cash. */
export function Money({ value, ccy, sign, className = "", dp, accent, compact }: { value: number; ccy?: string; sign?: boolean; className?: string; dp?: number; accent?: boolean; compact?: boolean }) {
  return (
    <span className={`num whitespace-nowrap ${accent ? "text-accent" : ""} ${className}`}>
      {ccy && <span className="text-muted mr-1 text-[0.85em]">{ccy}</span>}
      {money(value, { sign, dp, compact })}
    </span>
  );
}
