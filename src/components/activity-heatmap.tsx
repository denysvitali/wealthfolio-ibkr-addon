/**
 * Activity Heatmap Component
 *
 * Displays a monthly heatmap grid showing transaction density per month.
 * Months with existing Wealthfolio data show a diagonal stripe pattern overlay.
 */

import React, { useState, useCallback } from "react";
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { ActivityFingerprint } from "../types";
import {
  buildHeatmapData,
  getMonthBreakdown,
  getMonthName,
  getDensityLevel,
} from "../lib/heatmap-utils";

interface ActivityHeatmapProps {
  transactions: ActivityImport[];
  existingActivities?: ActivityFingerprint[];
  currency: string;
}

interface TooltipData {
  x: number;
  y: number;
  year: number;
  month: number;
  newCount: number;
  existingCount: number;
  breakdown: ReturnType<typeof getMonthBreakdown>;
}

const DENSITY_COLORS = [
  "bg-muted/20",           // 0: empty
  "bg-emerald-200 dark:bg-emerald-900",  // 1: low (1-3)
  "bg-emerald-400 dark:bg-emerald-700",  // 2: medium (4-10)
  "bg-emerald-500 dark:bg-emerald-600",  // 3: high (11-25)
  "bg-emerald-700 dark:bg-emerald-400",  // 4: very high (25+)
];

export const ActivityHeatmap: React.FC<ActivityHeatmapProps> = ({
  transactions,
  existingActivities = [],
}) => {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  const heatmapData = buildHeatmapData(transactions, existingActivities);

  const handleCellHover = useCallback(
    (e: React.MouseEvent, year: number, month: number) => {
      const bucket = heatmapData.buckets.find(
        (b) => b.year === year && b.month === month
      );
      if (!bucket && !existingActivities.length) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const parentRect = e.currentTarget.closest(".heatmap-container")?.getBoundingClientRect();
      const x = rect.left - (parentRect?.left ?? 0) + rect.width / 2;
      const y = rect.top - (parentRect?.top ?? 0) - 8;

      setTooltip({
        x,
        y,
        year,
        month,
        newCount: bucket?.transactions.length ?? 0,
        existingCount: bucket?.existingCount ?? 0,
        breakdown: getMonthBreakdown(bucket?.transactions ?? []),
      });
    },
    [heatmapData.buckets, existingActivities.length]
  );

  const handleCellLeave = useCallback(() => setTooltip(null), []);

  if (heatmapData.years.length === 0) {
    return (
      <div className="text-muted-foreground py-4 text-center text-sm">
        No transaction dates available for heatmap.
      </div>
    );
  }

  return (
    <div className="heatmap-container relative space-y-2">
      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rounded-sm bg-emerald-400 dark:bg-emerald-700" />
          <span>New</span>
        </div>
        <div className="flex items-center gap-1">
          <div
            className="h-3 w-3 rounded-sm bg-emerald-400 dark:bg-emerald-700"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 4px)",
            }}
          />
          <span>Overlap</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rounded-sm bg-muted/40 border border-border" />
          <span>No data</span>
        </div>
      </div>

      {/* Grid: rows = years, columns = months */}
      <div className="overflow-x-auto">
        <div className="min-w-[400px]">
          {/* Month headers */}
          <div className="grid grid-cols-[3rem_repeat(12,1fr)] gap-1 mb-1">
            <div /> {/* Year label spacer */}
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="text-center text-[10px] text-muted-foreground font-medium">
                {getMonthName(i)}
              </div>
            ))}
          </div>

          {/* Year rows */}
          {heatmapData.years.map((year) => (
            <div key={year} className="grid grid-cols-[3rem_repeat(12,1fr)] gap-1 mb-1">
              <div className="flex items-center text-xs text-muted-foreground font-medium pr-1 justify-end">
                {year}
              </div>
              {Array.from({ length: 12 }, (_, month) => {
                const bucket = heatmapData.buckets.find(
                  (b) => b.year === year && b.month === month
                );
                const count = bucket?.transactions.length ?? 0;
                const hasExisting = (bucket?.existingCount ?? 0) > 0;
                const density = getDensityLevel(count);

                return (
                  <div
                    key={month}
                    className={`h-6 rounded-sm cursor-default transition-opacity hover:opacity-80 ${DENSITY_COLORS[density]}`}
                    style={
                      hasExisting && count > 0
                        ? {
                            backgroundImage:
                              "repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(0,0,0,0.12) 2px, rgba(0,0,0,0.12) 4px)",
                          }
                        : undefined
                    }
                    onMouseEnter={(e) => handleCellHover(e, year, month)}
                    onMouseLeave={handleCellLeave}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute z-50 rounded-md border bg-popover px-3 py-2 text-xs shadow-md pointer-events-none"
          style={{
            left: `${tooltip.x}px`,
            top: `${tooltip.y}px`,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="font-medium mb-1">
            {getMonthName(tooltip.month)} {tooltip.year}
          </div>
          {tooltip.newCount > 0 && (
            <div className="space-y-0.5 text-muted-foreground">
              {tooltip.breakdown.buys > 0 && <div>{tooltip.breakdown.buys} buy(s)</div>}
              {tooltip.breakdown.sells > 0 && <div>{tooltip.breakdown.sells} sell(s)</div>}
              {tooltip.breakdown.dividends > 0 && <div>{tooltip.breakdown.dividends} dividend(s)</div>}
              {tooltip.breakdown.deposits > 0 && <div>{tooltip.breakdown.deposits} deposit(s)</div>}
              {tooltip.breakdown.withdrawals > 0 && <div>{tooltip.breakdown.withdrawals} withdrawal(s)</div>}
              {tooltip.breakdown.fees > 0 && <div>{tooltip.breakdown.fees} fee(s)</div>}
              {tooltip.breakdown.other > 0 && <div>{tooltip.breakdown.other} other</div>}
            </div>
          )}
          {tooltip.newCount === 0 && tooltip.existingCount === 0 && (
            <div className="text-muted-foreground">No data</div>
          )}
          {tooltip.existingCount > 0 && (
            <div className="text-muted-foreground mt-0.5 pt-0.5 border-t border-border">
              {tooltip.existingCount} already imported
            </div>
          )}
        </div>
      )}
    </div>
  );
};
