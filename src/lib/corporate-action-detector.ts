/**
 * Corporate Action Detection & Position Adjustment
 *
 * Detects corporate actions (splits, mergers, spin-offs) from IBKR CSV rows
 * that would otherwise be classified as UNKNOWN, and applies position adjustments
 * to prior BUY/SELL activities so that buildPositionHistory produces correct
 * post-adjustment positions.
 */

import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { CsvRowData } from "../presets/types";
import { debug } from "./debug-logger";

// ── Types ───────────────────────────────────────────────────────────────────

export type CorporateActionType =
  | "SPLIT"
  | "REVERSE_SPLIT"
  | "SPIN_OFF"
  | "MERGER"
  | "STOCK_DIVIDEND"
  | "SYMBOL_CHANGE";

export interface CorporateActionEvent {
  type: CorporateActionType;
  date: string;
  sourceSymbol: string;
  sourceISIN?: string;
  targetSymbol?: string;
  targetISIN?: string;
  /** e.g. 4.0 for a 4-for-1 split, 0.5 for a 1-for-2 reverse split */
  ratio: number;
  cashInLieu?: number;
  description: string;
  rawActivityCode: string;
}

export interface PositionAdjustment {
  affectedSymbol: string;
  quantityMultiplier: number;
  priceMultiplier: number;
  newSymbol?: string;
  effectiveDate: string;
}

// ── Description Parsers ─────────────────────────────────────────────────────

/**
 * Parse a stock split description.
 * Examples:
 *   "AAPL(US0378331005) SPLIT 4 FOR 1 (AAPL, APPLE INC, US0378331005)"
 *   "NVDA(US67066G1040) SPLIT 10 FOR 1"
 */
export function parseSplitDescription(
  desc: string
): { ratio: number; symbol: string; isin?: string } | null {
  // Match "SYMBOL(ISIN) SPLIT X FOR Y"
  const match = /^([A-Za-z0-9.]+)\(([A-Z0-9]+)\)\s+SPLIT\s+(\d+(?:\.\d+)?)\s+FOR\s+(\d+(?:\.\d+)?)/i.exec(desc);
  if (match) {
    const newShares = parseFloat(match[3]);
    const oldShares = parseFloat(match[4]);
    if (oldShares > 0) {
      return {
        ratio: newShares / oldShares,
        symbol: match[1].toUpperCase(),
        isin: match[2],
      };
    }
  }

  // Simpler pattern: "SPLIT X FOR Y"
  const simpleMatch = /SPLIT\s+(\d+(?:\.\d+)?)\s+FOR\s+(\d+(?:\.\d+)?)/i.exec(desc);
  if (simpleMatch) {
    const newShares = parseFloat(simpleMatch[1]);
    const oldShares = parseFloat(simpleMatch[2]);
    if (oldShares > 0) {
      return { ratio: newShares / oldShares, symbol: "" };
    }
  }

  return null;
}

/**
 * Parse a spin-off description.
 * Examples:
 *   "PARENT(ISIN) SPINOFF 0.25 SHARES OF CHILD(ISIN) PER SHARE"
 *   "GE(US3696043013) SPIN-OFF 1 FOR 8 (VERNOVA, ...)"
 */
export function parseSpinOffDescription(
  desc: string
): { ratio: number; parentSymbol: string; childSymbol?: string; childISIN?: string } | null {
  // "SYMBOL(ISIN) SPINOFF X SHARES OF CHILD(ISIN) PER SHARE"
  const match = /^([A-Za-z0-9.]+)\(([A-Z0-9]+)\)\s+SPIN[-\s]?OFF\s+([\d.]+)\s+SHARES?\s+OF\s+([A-Za-z0-9.]+)\(([A-Z0-9]+)\)/i.exec(desc);
  if (match) {
    return {
      ratio: parseFloat(match[3]),
      parentSymbol: match[1].toUpperCase(),
      childSymbol: match[4].toUpperCase(),
      childISIN: match[5],
    };
  }

  // "SYMBOL(ISIN) SPIN-OFF X FOR Y"
  const ratioMatch = /^([A-Za-z0-9.]+)\(([A-Z0-9]+)\)\s+SPIN[-\s]?OFF\s+(\d+(?:\.\d+)?)\s+FOR\s+(\d+(?:\.\d+)?)/i.exec(desc);
  if (ratioMatch) {
    const newShares = parseFloat(ratioMatch[3]);
    const oldShares = parseFloat(ratioMatch[4]);
    if (oldShares > 0) {
      return {
        ratio: newShares / oldShares,
        parentSymbol: ratioMatch[1].toUpperCase(),
      };
    }
  }

  return null;
}

/**
 * Parse a merger/acquisition description.
 * Examples:
 *   "XYZ(US1234567890) MERGED(Acquisition) FOR USD 45.00 PER SHARE"
 *   "XYZ(ISIN) MERGED FOR CASH AND STOCK"
 */
export function parseMergerDescription(
  desc: string
): { cashPerShare?: number; symbol: string; isin?: string } | null {
  const match = /^([A-Za-z0-9.]+)\(([A-Z0-9]+)\)\s+MERG/i.exec(desc);
  if (match) {
    const cashMatch = /(?:USD|EUR|GBP|CHF|CAD|AUD|JPY)\s+([\d.]+)\s+PER\s+SHARE/i.exec(desc);
    return {
      symbol: match[1].toUpperCase(),
      isin: match[2],
      cashPerShare: cashMatch ? parseFloat(cashMatch[1]) : undefined,
    };
  }
  return null;
}

// ── Known IBKR Corporate Action Activity Codes ──────────────────────────────

const CORPORATE_ACTION_CODES = new Set([
  "SOFF",   // Spin-off
  "STKD",   // Stock dividend / stock split
  "ACQU",   // Acquisition / merger
  "CA",     // Generic corporate action
]);

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Detect corporate actions from raw CSV rows.
 * Scans for known ActivityCode values and parses descriptions to extract
 * ratios and symbols.
 */
export function detectCorporateActions(rows: CsvRowData[]): CorporateActionEvent[] {
  const events: CorporateActionEvent[] = [];

  for (const row of rows) {
    const activityCode = row.ActivityCode?.trim();
    const description = row.Description?.trim() ?? row.ActivityDescription?.trim() ?? "";
    const symbol = row.Symbol?.trim()?.toUpperCase() ?? "";
    const isin = row.ISIN?.trim();
    const date = row.TradeDate?.trim() || row.ReportDate?.trim() || row.DateTime?.trim() || "";

    if (!activityCode) continue;

    // Check for explicit SPLIT in description regardless of activity code
    const isSplitDescription = /SPLIT\s+\d/i.test(description);

    if (!CORPORATE_ACTION_CODES.has(activityCode) && !isSplitDescription) continue;

    // Try to identify the type from the description
    const splitInfo = parseSplitDescription(description);
    if (splitInfo) {
      const type: CorporateActionType = splitInfo.ratio < 1 ? "REVERSE_SPLIT" : "SPLIT";
      events.push({
        type,
        date,
        sourceSymbol: splitInfo.symbol || symbol,
        sourceISIN: splitInfo.isin || isin,
        ratio: splitInfo.ratio,
        description,
        rawActivityCode: activityCode,
      });
      continue;
    }

    const spinOffInfo = parseSpinOffDescription(description);
    if (spinOffInfo) {
      events.push({
        type: "SPIN_OFF",
        date,
        sourceSymbol: spinOffInfo.parentSymbol || symbol,
        sourceISIN: isin,
        targetSymbol: spinOffInfo.childSymbol,
        targetISIN: spinOffInfo.childISIN,
        ratio: spinOffInfo.ratio,
        description,
        rawActivityCode: activityCode,
      });
      continue;
    }

    const mergerInfo = parseMergerDescription(description);
    if (mergerInfo) {
      events.push({
        type: "MERGER",
        date,
        sourceSymbol: mergerInfo.symbol || symbol,
        sourceISIN: mergerInfo.isin || isin,
        cashInLieu: mergerInfo.cashPerShare,
        ratio: 0, // Mergers remove the position
        description,
        rawActivityCode: activityCode,
      });
      continue;
    }

    // Fallback: classify by activity code
    if (activityCode === "SOFF") {
      events.push({
        type: "SPIN_OFF",
        date,
        sourceSymbol: symbol,
        sourceISIN: isin,
        ratio: 1,
        description,
        rawActivityCode: activityCode,
      });
    } else if (activityCode === "STKD") {
      // Stock dividend — often a fractional share issuance
      events.push({
        type: "STOCK_DIVIDEND",
        date,
        sourceSymbol: symbol,
        sourceISIN: isin,
        ratio: 1,
        description,
        rawActivityCode: activityCode,
      });
    } else if (activityCode === "ACQU") {
      events.push({
        type: "MERGER",
        date,
        sourceSymbol: symbol,
        sourceISIN: isin,
        ratio: 0,
        description,
        rawActivityCode: activityCode,
      });
    } else if (activityCode === "CA") {
      // Generic CA — log but still capture
      events.push({
        type: "SYMBOL_CHANGE",
        date,
        sourceSymbol: symbol,
        sourceISIN: isin,
        ratio: 1,
        description,
        rawActivityCode: activityCode,
      });
    }
  }

  debug.log(`[Corporate Actions] Detected ${events.length} corporate action(s):`,
    events.map(e => `${e.type}: ${e.sourceSymbol} on ${e.date} (ratio=${e.ratio})`));

  return events;
}

// ── Adjustment Computation ──────────────────────────────────────────────────

/**
 * Convert corporate action events into concrete position adjustments.
 * Only splits and reverse splits produce meaningful adjustments —
 * spin-offs and mergers are logged as warnings but don't auto-adjust.
 */
export function computePositionAdjustments(events: CorporateActionEvent[]): PositionAdjustment[] {
  const adjustments: PositionAdjustment[] = [];

  for (const event of events) {
    if (
      (event.type === "SPLIT" || event.type === "REVERSE_SPLIT") &&
      event.ratio > 0 &&
      event.ratio !== 1
    ) {
      adjustments.push({
        affectedSymbol: event.sourceSymbol,
        quantityMultiplier: event.ratio,
        priceMultiplier: 1 / event.ratio,
        effectiveDate: event.date,
      });
    }
    // Spin-offs, mergers, symbol changes: log but don't auto-adjust
    // (would need external data about the new positions)
  }

  return adjustments;
}

// ── Apply Adjustments ───────────────────────────────────────────────────────

/**
 * Apply position adjustments to activities.
 * Retroactively modifies quantity and unitPrice of BUY/SELL activities
 * for affected symbols dated before the corporate action's effective date.
 */
export function applyAdjustmentsToActivities(
  activities: ActivityImport[],
  adjustments: PositionAdjustment[]
): ActivityImport[] {
  if (adjustments.length === 0) return activities;

  return activities.map((activity) => {
    // Only adjust BUY/SELL trade activities
    if (activity.activityType !== "BUY" && activity.activityType !== "SELL") {
      return activity;
    }

    let adjusted = { ...activity };
    for (const adj of adjustments) {
      // Match by symbol (case-insensitive)
      const actSymbol = (activity.symbol || "").toUpperCase();
      const adjSymbol = adj.affectedSymbol.toUpperCase();
      if (actSymbol !== adjSymbol) continue;

      // Only adjust activities BEFORE the corporate action date
      const actDate = String(activity.date || "").split("T")[0];
      const adjDate = adj.effectiveDate.split("T")[0];
      if (actDate >= adjDate) continue;

      // Apply the adjustment
      const oldQty = adjusted.quantity ?? 0;
      const oldPrice = adjusted.unitPrice ?? 0;
      adjusted = {
        ...adjusted,
        quantity: roundTo8(oldQty * adj.quantityMultiplier),
        unitPrice: roundTo8(oldPrice * adj.priceMultiplier),
      };

      debug.log(
        `[Corporate Action] Adjusted ${actSymbol} on ${actDate}: ` +
        `qty ${oldQty} → ${adjusted.quantity}, price ${oldPrice} → ${adjusted.unitPrice}`
      );
    }
    return adjusted;
  });
}

/**
 * Round to 8 decimal places to avoid floating-point drift.
 */
function roundTo8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
