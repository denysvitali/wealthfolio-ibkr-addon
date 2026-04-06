/**
 * Heatmap Utility Functions Tests
 */

import { describe, it, expect } from "vitest";
import {
  buildHeatmapData,
  getMonthBreakdown,
  getMonthName,
  getDensityLevel,
} from "../lib/heatmap-utils";
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { ActivityFingerprint } from "../types";

function makeActivity(date: string, type: string = "BUY"): ActivityImport {
  return {
    symbol: "AAPL",
    date,
    activityType: type as ActivityImport["activityType"],
    quantity: 10,
    unitPrice: 150,
    currency: "USD",
    fee: 0,
    isDraft: false,
  };
}

function makeFingerprint(date: string): ActivityFingerprint {
  return {
    activityDate: date,
    assetId: "AAPL",
    activityType: "BUY",
    quantity: 10,
    unitPrice: 150,
    fee: 0,
    currency: "USD",
  };
}

describe("getMonthName", () => {
  it("should return correct month names", () => {
    expect(getMonthName(0)).toBe("Jan");
    expect(getMonthName(5)).toBe("Jun");
    expect(getMonthName(11)).toBe("Dec");
  });

  it("should return empty string for invalid month", () => {
    expect(getMonthName(-1)).toBe("");
    expect(getMonthName(12)).toBe("");
  });
});

describe("getDensityLevel", () => {
  it("should return 0 for no transactions", () => {
    expect(getDensityLevel(0)).toBe(0);
  });

  it("should return 1 for 1-3 transactions", () => {
    expect(getDensityLevel(1)).toBe(1);
    expect(getDensityLevel(3)).toBe(1);
  });

  it("should return 2 for 4-10 transactions", () => {
    expect(getDensityLevel(4)).toBe(2);
    expect(getDensityLevel(10)).toBe(2);
  });

  it("should return 3 for 11-25 transactions", () => {
    expect(getDensityLevel(11)).toBe(3);
    expect(getDensityLevel(25)).toBe(3);
  });

  it("should return 4 for 26+ transactions", () => {
    expect(getDensityLevel(26)).toBe(4);
    expect(getDensityLevel(100)).toBe(4);
  });
});

describe("buildHeatmapData", () => {
  it("should bucket transactions by year-month", () => {
    const transactions = [
      makeActivity("2024-01-15"),
      makeActivity("2024-01-20"),
      makeActivity("2024-03-10"),
      makeActivity("2024-12-01"),
    ];
    const result = buildHeatmapData(transactions);
    expect(result.years).toEqual([2024]);
    expect(result.totalNew).toBe(4);
    expect(result.totalExisting).toBe(0);

    const janBucket = result.buckets.find(b => b.year === 2024 && b.month === 0);
    expect(janBucket?.transactions).toHaveLength(2);

    const marBucket = result.buckets.find(b => b.year === 2024 && b.month === 2);
    expect(marBucket?.transactions).toHaveLength(1);

    const decBucket = result.buckets.find(b => b.year === 2024 && b.month === 11);
    expect(decBucket?.transactions).toHaveLength(1);
  });

  it("should handle multiple years", () => {
    const transactions = [
      makeActivity("2023-06-15"),
      makeActivity("2024-06-15"),
      makeActivity("2025-01-01"),
    ];
    const result = buildHeatmapData(transactions);
    expect(result.years).toEqual([2023, 2024, 2025]);
  });

  it("should count existing activities per month", () => {
    const transactions = [makeActivity("2024-03-15")];
    const existing = [
      makeFingerprint("2024-03-01"),
      makeFingerprint("2024-03-20"),
      makeFingerprint("2024-04-01"),
    ];
    const result = buildHeatmapData(transactions, existing);
    const marBucket = result.buckets.find(b => b.year === 2024 && b.month === 2);
    expect(marBucket?.transactions).toHaveLength(1);
    expect(marBucket?.existingCount).toBe(2);

    const aprBucket = result.buckets.find(b => b.year === 2024 && b.month === 3);
    expect(aprBucket?.transactions).toHaveLength(0);
    expect(aprBucket?.existingCount).toBe(1);
  });

  it("should handle empty inputs", () => {
    const result = buildHeatmapData([]);
    expect(result.buckets).toHaveLength(0);
    expect(result.years).toHaveLength(0);
    expect(result.totalNew).toBe(0);
  });

  it("should handle transactions with ISO datetime strings", () => {
    const transactions = [makeActivity("2024-03-15T10:30:00Z")];
    const result = buildHeatmapData(transactions);
    const bucket = result.buckets.find(b => b.year === 2024 && b.month === 2);
    expect(bucket?.transactions).toHaveLength(1);
  });

  it("should skip transactions without valid dates", () => {
    const transactions = [
      makeActivity("invalid-date"),
      makeActivity(""),
    ];
    const result = buildHeatmapData(transactions);
    expect(result.buckets).toHaveLength(0);
  });
});

describe("getMonthBreakdown", () => {
  it("should count each activity type", () => {
    const transactions = [
      makeActivity("2024-01-01", "BUY"),
      makeActivity("2024-01-02", "BUY"),
      makeActivity("2024-01-03", "SELL"),
      makeActivity("2024-01-04", "DIVIDEND"),
      makeActivity("2024-01-05", "DEPOSIT"),
      makeActivity("2024-01-06", "TRANSFER_IN"),
      makeActivity("2024-01-07", "WITHDRAWAL"),
      makeActivity("2024-01-08", "FEE"),
      makeActivity("2024-01-09", "TAX"),
    ];
    const breakdown = getMonthBreakdown(transactions);
    expect(breakdown.buys).toBe(2);
    expect(breakdown.sells).toBe(1);
    expect(breakdown.dividends).toBe(1);
    expect(breakdown.deposits).toBe(2); // DEPOSIT + TRANSFER_IN
    expect(breakdown.withdrawals).toBe(1);
    expect(breakdown.fees).toBe(2); // FEE + TAX
  });

  it("should handle empty array", () => {
    const breakdown = getMonthBreakdown([]);
    expect(breakdown.buys).toBe(0);
    expect(breakdown.sells).toBe(0);
    expect(breakdown.dividends).toBe(0);
  });
});
