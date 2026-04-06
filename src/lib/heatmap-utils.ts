/**
 * Heatmap Utility Functions
 *
 * Pure functions for aggregating activity data into monthly buckets
 * used by the activity heatmap component.
 */

import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { ActivityFingerprint } from "../types";

export interface MonthBucket {
  year: number;
  month: number; // 0-11
  transactions: ActivityImport[];
  existingCount: number;
}

export interface HeatmapData {
  buckets: MonthBucket[];
  years: number[];
  totalNew: number;
  totalExisting: number;
}

export interface MonthBreakdown {
  buys: number;
  sells: number;
  dividends: number;
  deposits: number;
  withdrawals: number;
  fees: number;
  other: number;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function getMonthName(month: number): string {
  return MONTH_NAMES[month] ?? "";
}

/**
 * Extract year and month from a date string or Date object.
 */
function extractYearMonth(date: string | Date | undefined): { year: number; month: number } | null {
  if (!date) return null;
  const str = typeof date === "object" && date instanceof Date
    ? date.toISOString()
    : String(date);
  const parts = str.split(/[-T/]/);
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // 0-indexed
  if (isNaN(year) || isNaN(month) || month < 0 || month > 11) return null;
  return { year, month };
}

/**
 * Build heatmap data from new transactions and existing activities.
 */
export function buildHeatmapData(
  transactions: ActivityImport[],
  existingActivities: ActivityFingerprint[] = []
): HeatmapData {
  const bucketMap = new Map<string, MonthBucket>();

  // Helper to get or create bucket
  const getBucket = (year: number, month: number): MonthBucket => {
    const key = `${year}-${month}`;
    let bucket = bucketMap.get(key);
    if (!bucket) {
      bucket = { year, month, transactions: [], existingCount: 0 };
      bucketMap.set(key, bucket);
    }
    return bucket;
  };

  // Populate from new transactions
  for (const txn of transactions) {
    const ym = extractYearMonth(txn.date);
    if (!ym) continue;
    const bucket = getBucket(ym.year, ym.month);
    bucket.transactions.push(txn);
  }

  // Count existing activities per month
  for (const existing of existingActivities) {
    const ym = extractYearMonth(existing.activityDate);
    if (!ym) continue;
    const bucket = getBucket(ym.year, ym.month);
    bucket.existingCount++;
  }

  const buckets = Array.from(bucketMap.values()).sort(
    (a, b) => a.year - b.year || a.month - b.month
  );

  const yearsSet = new Set<number>();
  for (const b of buckets) yearsSet.add(b.year);
  const years = Array.from(yearsSet).sort();

  const totalNew = transactions.length;
  const totalExisting = existingActivities.length;

  return { buckets, years, totalNew, totalExisting };
}

/**
 * Get the transaction breakdown for a specific month bucket.
 */
export function getMonthBreakdown(transactions: ActivityImport[]): MonthBreakdown {
  const breakdown: MonthBreakdown = {
    buys: 0, sells: 0, dividends: 0, deposits: 0, withdrawals: 0, fees: 0, other: 0,
  };
  for (const txn of transactions) {
    switch (txn.activityType) {
      case "BUY": breakdown.buys++; break;
      case "SELL": breakdown.sells++; break;
      case "DIVIDEND": breakdown.dividends++; break;
      case "DEPOSIT":
      case "TRANSFER_IN": breakdown.deposits++; break;
      case "WITHDRAWAL":
      case "TRANSFER_OUT": breakdown.withdrawals++; break;
      case "FEE":
      case "TAX": breakdown.fees++; break;
      default: breakdown.other++; break;
    }
  }
  return breakdown;
}

/**
 * Map a transaction count to a density level (0-4) for color intensity.
 */
export function getDensityLevel(count: number): number {
  if (count === 0) return 0;
  if (count <= 3) return 1;
  if (count <= 10) return 2;
  if (count <= 25) return 3;
  return 4;
}
