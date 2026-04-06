/**
 * Position Reconciler
 *
 * Compares IBKR open positions (from a Flex Query) against Wealthfolio's
 * computed positions to identify discrepancies in quantity or cost basis.
 */

import { debug } from "./debug-logger";
import { parseFlexQueryCSV } from "./flex-csv-parser";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IBKRPosition {
  symbol: string;
  isin?: string;
  quantity: number;
  costBasis: number;
  costPrice: number;
  markPrice: number;
  unrealizedPnL: number;
  currency: string;
  listingExchange?: string;
}

export interface WealthfolioPosition {
  symbol: string;
  quantity: number;
  costBasis: number;
  costPrice: number;
  currency: string;
  accountId: string;
  accountName: string;
}

export type ReconciliationStatus =
  | "match"
  | "quantity_mismatch"
  | "cost_mismatch"
  | "both_mismatch"
  | "ibkr_only"
  | "wealthfolio_only";

export interface ReconciliationRow {
  symbol: string;
  isin?: string;
  currency: string;
  ibkr: { quantity: number; costBasis: number; costPrice: number } | null;
  wealthfolio: { quantity: number; costBasis: number; costPrice: number } | null;
  quantityDiff: number;
  costBasisDiff: number;
  status: ReconciliationStatus;
}

export interface ReconciliationResult {
  rows: ReconciliationRow[];
  summary: {
    matched: number;
    mismatched: number;
    ibkrOnly: number;
    wealthfolioOnly: number;
    total: number;
  };
}

// ── IBKR Positions CSV Parser ───────────────────────────────────────────────

/**
 * Parse IBKR Open Positions Flex Query CSV into structured positions.
 *
 * IBKR positions CSV columns typically include:
 *   Symbol, ISIN, Quantity, CostBasisPrice, CostBasisMoney, MarkPrice,
 *   FifoPnlUnrealized, CurrencyPrimary, ListingExchange, ...
 *
 * The exact column names depend on how the user configures their Flex Query.
 * We attempt to match common column name patterns.
 */
export function parseIBKRPositionsCSV(csvContent: string): IBKRPosition[] {
  const parsed = parseFlexQueryCSV(csvContent);
  if (parsed.errors.length > 0) {
    debug.warn("[Reconciler] CSV parse errors:", parsed.errors);
  }

  const positions: IBKRPosition[] = [];

  for (const row of parsed.rows) {
    // Skip summary/header rows
    const levelOfDetail = row.LevelOfDetail?.trim();
    if (levelOfDetail === "Currency" || levelOfDetail === "SUMMARY" || levelOfDetail === "BaseCurrency") {
      continue;
    }

    const symbol = row.Symbol?.trim();
    if (!symbol) continue;

    // Parse quantity — try multiple column names
    const quantity = parseNum(row.Quantity || row.Position || row.OpenQuantity);
    if (quantity === 0) continue; // Skip zero-position rows

    // Parse cost basis — try multiple column names
    const costBasis = Math.abs(parseNum(
      row.CostBasisMoney || row.CostBasis || row.CostBasisInBase
    ));
    const costPrice = Math.abs(parseNum(
      row.CostBasisPrice || row.CostPrice || row.CostBasisDollarsPerShare
    ));
    const markPrice = parseNum(row.MarkPrice || row.ClosePrice || row.CurrentPrice);
    const unrealizedPnL = parseNum(
      row.FifoPnlUnrealized || row.UnrealizedPnL || row.UnrealizedPL
    );

    const currency = row.CurrencyPrimary?.trim() || row.Currency?.trim() || "USD";

    positions.push({
      symbol,
      isin: row.ISIN?.trim() || undefined,
      quantity: Math.abs(quantity), // short positions will be negative — normalize
      costBasis,
      costPrice,
      markPrice,
      unrealizedPnL,
      currency,
      listingExchange: row.ListingExchange?.trim() || undefined,
    });
  }

  debug.log(`[Reconciler] Parsed ${positions.length} IBKR positions from CSV`);
  return positions;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export interface ReconciliationTolerances {
  /** Absolute tolerance for quantity comparison (default: 0.001) */
  quantity: number;
  /** Absolute tolerance for cost basis comparison (default: 0.01) */
  costBasis: number;
}

const DEFAULT_TOLERANCES: ReconciliationTolerances = {
  quantity: 0.001,
  costBasis: 0.01,
};

/**
 * Reconcile IBKR positions against Wealthfolio positions.
 *
 * Matching is done by symbol (case-insensitive).
 * Returns a row for each unique symbol found in either source.
 */
export function reconcilePositions(
  ibkrPositions: IBKRPosition[],
  wfPositions: WealthfolioPosition[],
  tolerances: ReconciliationTolerances = DEFAULT_TOLERANCES
): ReconciliationResult {
  // Build maps by symbol (uppercase)
  const ibkrMap = new Map<string, IBKRPosition>();
  for (const pos of ibkrPositions) {
    const key = pos.symbol.toUpperCase();
    // Merge if multiple rows for same symbol (e.g., different lots)
    const existing = ibkrMap.get(key);
    if (existing) {
      existing.quantity += pos.quantity;
      existing.costBasis += pos.costBasis;
      existing.costPrice = existing.costBasis / (existing.quantity || 1);
    } else {
      ibkrMap.set(key, { ...pos });
    }
  }

  const wfMap = new Map<string, WealthfolioPosition>();
  for (const pos of wfPositions) {
    const key = pos.symbol.toUpperCase();
    const existing = wfMap.get(key);
    if (existing) {
      existing.quantity += pos.quantity;
      existing.costBasis += pos.costBasis;
      existing.costPrice = existing.costBasis / (existing.quantity || 1);
    } else {
      wfMap.set(key, { ...pos });
    }
  }

  // Collect all unique symbols
  const allSymbols = new Set<string>([...ibkrMap.keys(), ...wfMap.keys()]);
  const rows: ReconciliationRow[] = [];
  let matched = 0;
  let mismatched = 0;
  let ibkrOnly = 0;
  let wealthfolioOnly = 0;

  for (const symbol of allSymbols) {
    const ibkr = ibkrMap.get(symbol);
    const wf = wfMap.get(symbol);

    if (ibkr && wf) {
      const qtyMatch = Math.abs(ibkr.quantity - wf.quantity) <= tolerances.quantity;
      const costMatch = Math.abs(ibkr.costBasis - wf.costBasis) <= tolerances.costBasis;

      let status: ReconciliationStatus;
      if (qtyMatch && costMatch) {
        status = "match";
        matched++;
      } else if (!qtyMatch && !costMatch) {
        status = "both_mismatch";
        mismatched++;
      } else if (!qtyMatch) {
        status = "quantity_mismatch";
        mismatched++;
      } else {
        status = "cost_mismatch";
        mismatched++;
      }

      rows.push({
        symbol,
        isin: ibkr.isin,
        currency: ibkr.currency,
        ibkr: { quantity: ibkr.quantity, costBasis: ibkr.costBasis, costPrice: ibkr.costPrice },
        wealthfolio: { quantity: wf.quantity, costBasis: wf.costBasis, costPrice: wf.costPrice },
        quantityDiff: ibkr.quantity - wf.quantity,
        costBasisDiff: ibkr.costBasis - wf.costBasis,
        status,
      });
    } else if (ibkr) {
      ibkrOnly++;
      rows.push({
        symbol,
        isin: ibkr.isin,
        currency: ibkr.currency,
        ibkr: { quantity: ibkr.quantity, costBasis: ibkr.costBasis, costPrice: ibkr.costPrice },
        wealthfolio: null,
        quantityDiff: ibkr.quantity,
        costBasisDiff: ibkr.costBasis,
        status: "ibkr_only",
      });
    } else if (wf) {
      wealthfolioOnly++;
      rows.push({
        symbol,
        currency: wf.currency,
        ibkr: null,
        wealthfolio: { quantity: wf.quantity, costBasis: wf.costBasis, costPrice: wf.costPrice },
        quantityDiff: -wf.quantity,
        costBasisDiff: -wf.costBasis,
        status: "wealthfolio_only",
      });
    }
  }

  // Sort: mismatches first, then ibkr-only, then wf-only, then matched
  const statusOrder: Record<ReconciliationStatus, number> = {
    both_mismatch: 0,
    quantity_mismatch: 1,
    cost_mismatch: 2,
    ibkr_only: 3,
    wealthfolio_only: 4,
    match: 5,
  };
  rows.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return {
    rows,
    summary: {
      matched,
      mismatched,
      ibkrOnly,
      wealthfolioOnly,
      total: rows.length,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseNum(value: string | undefined): number {
  if (!value) return 0;
  const str = String(value).replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(str);
  return isNaN(parsed) ? 0 : parsed;
}
