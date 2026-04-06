/**
 * Corporate Action Detection & Position Adjustment Tests
 */

import { describe, it, expect } from "vitest";
import {
  detectCorporateActions,
  computePositionAdjustments,
  applyAdjustmentsToActivities,
  parseSplitDescription,
  parseSpinOffDescription,
  parseMergerDescription,
} from "../lib/corporate-action-detector";
import { preprocessIBKRData } from "../lib/ibkr-preprocessor";
import type { CsvRowData } from "../presets/types";
import type { ActivityImport } from "@wealthfolio/addon-sdk";

// ── Description Parser Tests ────────────────────────────────────────────────

describe("parseSplitDescription", () => {
  it("should parse a standard 4-for-1 split", () => {
    const result = parseSplitDescription(
      "AAPL(US0378331005) SPLIT 4 FOR 1 (AAPL, APPLE INC, US0378331005)"
    );
    expect(result).toEqual({ ratio: 4, symbol: "AAPL", isin: "US0378331005" });
  });

  it("should parse a 10-for-1 split", () => {
    const result = parseSplitDescription("NVDA(US67066G1040) SPLIT 10 FOR 1");
    expect(result).toEqual({ ratio: 10, symbol: "NVDA", isin: "US67066G1040" });
  });

  it("should parse a reverse split (1 for 4)", () => {
    const result = parseSplitDescription("XYZ(US1234567890) SPLIT 1 FOR 4");
    expect(result).toEqual({ ratio: 0.25, symbol: "XYZ", isin: "US1234567890" });
  });

  it("should parse a fractional split ratio", () => {
    const result = parseSplitDescription("ABC(US0000000001) SPLIT 3.5 FOR 1");
    expect(result).toEqual({ ratio: 3.5, symbol: "ABC", isin: "US0000000001" });
  });

  it("should parse a simple split without symbol prefix", () => {
    const result = parseSplitDescription("Some description SPLIT 2 FOR 1 more text");
    expect(result).toEqual({ ratio: 2, symbol: "" });
  });

  it("should return null for non-split descriptions", () => {
    expect(parseSplitDescription("AAPL CASH DIVIDEND USD 0.24 PER SHARE")).toBeNull();
    expect(parseSplitDescription("")).toBeNull();
    expect(parseSplitDescription("SPLIT without numbers")).toBeNull();
  });
});

describe("parseSpinOffDescription", () => {
  it("should parse a spin-off with child symbol and ISIN", () => {
    const result = parseSpinOffDescription(
      "GE(US3696043013) SPINOFF 0.25 SHARES OF GEV(US36828A1016) PER SHARE"
    );
    expect(result).toEqual({
      ratio: 0.25,
      parentSymbol: "GE",
      childSymbol: "GEV",
      childISIN: "US36828A1016",
    });
  });

  it("should parse spin-off with ratio format", () => {
    const result = parseSpinOffDescription(
      "PARENT(US1111111111) SPIN-OFF 1 FOR 8 (CHILD)"
    );
    expect(result).toEqual({
      ratio: 0.125,
      parentSymbol: "PARENT",
    });
  });

  it("should return null for non-spin-off descriptions", () => {
    expect(parseSpinOffDescription("AAPL CASH DIVIDEND")).toBeNull();
    expect(parseSpinOffDescription("")).toBeNull();
  });
});

describe("parseMergerDescription", () => {
  it("should parse a merger with cash per share", () => {
    const result = parseMergerDescription(
      "XYZ(US1234567890) MERGED(Acquisition) FOR USD 45.00 PER SHARE"
    );
    expect(result).toEqual({
      symbol: "XYZ",
      isin: "US1234567890",
      cashPerShare: 45.0,
    });
  });

  it("should parse a merger without cash amount", () => {
    const result = parseMergerDescription(
      "ABC(US0000000001) MERGED FOR CASH AND STOCK"
    );
    expect(result).toEqual({
      symbol: "ABC",
      isin: "US0000000001",
      cashPerShare: undefined,
    });
  });

  it("should return null for non-merger descriptions", () => {
    expect(parseMergerDescription("AAPL SPLIT 4 FOR 1")).toBeNull();
    expect(parseMergerDescription("")).toBeNull();
  });
});

// ── Detection Tests ─────────────────────────────────────────────────────────

describe("detectCorporateActions", () => {
  it("should detect a split from STKD activity code", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "STKD",
        Description: "AAPL(US0378331005) SPLIT 4 FOR 1 (AAPL, APPLE INC)",
        Symbol: "AAPL",
        ISIN: "US0378331005",
        TradeDate: "2020-08-31",
      },
    ];
    const events = detectCorporateActions(rows);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SPLIT");
    expect(events[0].sourceSymbol).toBe("AAPL");
    expect(events[0].ratio).toBe(4);
  });

  it("should detect a reverse split", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "STKD",
        Description: "XYZ(US1234567890) SPLIT 1 FOR 10",
        Symbol: "XYZ",
        TradeDate: "2024-01-15",
      },
    ];
    const events = detectCorporateActions(rows);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("REVERSE_SPLIT");
    expect(events[0].ratio).toBe(0.1);
  });

  it("should detect a spin-off", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "SOFF",
        Description: "GE(US3696043013) SPINOFF 0.25 SHARES OF GEV(US36828A1016) PER SHARE",
        Symbol: "GE",
        ISIN: "US3696043013",
        TradeDate: "2024-04-02",
      },
    ];
    const events = detectCorporateActions(rows);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SPIN_OFF");
    expect(events[0].targetSymbol).toBe("GEV");
  });

  it("should detect a merger", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "ACQU",
        Description: "XYZ(US1234567890) MERGED(Acquisition) FOR USD 45.00 PER SHARE",
        Symbol: "XYZ",
        TradeDate: "2024-06-01",
      },
    ];
    const events = detectCorporateActions(rows);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("MERGER");
    expect(events[0].cashInLieu).toBe(45);
  });

  it("should detect a split by description even with unknown activity code", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "UNKNOWN_CODE",
        Description: "NVDA(US67066G1040) SPLIT 10 FOR 1",
        Symbol: "NVDA",
        TradeDate: "2024-06-10",
      },
    ];
    const events = detectCorporateActions(rows);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SPLIT");
    expect(events[0].ratio).toBe(10);
  });

  it("should return empty array for rows without corporate actions", () => {
    const rows: CsvRowData[] = [
      { ActivityCode: "DIV", Description: "AAPL CASH DIVIDEND", Symbol: "AAPL" },
      { ActivityCode: "FOREX", Description: "FX trade", Symbol: "GBP.USD" },
    ];
    const events = detectCorporateActions(rows);
    expect(events).toHaveLength(0);
  });

  it("should handle empty rows", () => {
    expect(detectCorporateActions([])).toHaveLength(0);
  });

  it("should fallback to activity code when description is not parseable", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "CA",
        Description: "Some generic corporate action for TICKER",
        Symbol: "TICKER",
        TradeDate: "2024-03-01",
      },
    ];
    const events = detectCorporateActions(rows);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SYMBOL_CHANGE");
    expect(events[0].sourceSymbol).toBe("TICKER");
  });
});

// ── Adjustment Computation Tests ────────────────────────────────────────────

describe("computePositionAdjustments", () => {
  it("should create adjustments for splits", () => {
    const events = detectCorporateActions([
      {
        ActivityCode: "STKD",
        Description: "AAPL(US0378331005) SPLIT 4 FOR 1",
        Symbol: "AAPL",
        TradeDate: "2020-08-31",
      },
    ]);
    const adjustments = computePositionAdjustments(events);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].affectedSymbol).toBe("AAPL");
    expect(adjustments[0].quantityMultiplier).toBe(4);
    expect(adjustments[0].priceMultiplier).toBe(0.25);
  });

  it("should not create adjustments for mergers", () => {
    const events = detectCorporateActions([
      {
        ActivityCode: "ACQU",
        Description: "XYZ(US1234567890) MERGED(Acquisition) FOR USD 45.00 PER SHARE",
        Symbol: "XYZ",
        TradeDate: "2024-06-01",
      },
    ]);
    const adjustments = computePositionAdjustments(events);
    expect(adjustments).toHaveLength(0);
  });

  it("should not create adjustments for spin-offs with ratio=1", () => {
    const events = detectCorporateActions([
      {
        ActivityCode: "SOFF",
        Description: "Unknown spinoff format",
        Symbol: "ABC",
        TradeDate: "2024-01-01",
      },
    ]);
    const adjustments = computePositionAdjustments(events);
    expect(adjustments).toHaveLength(0);
  });
});

// ── Apply Adjustments Tests ─────────────────────────────────────────────────

describe("applyAdjustmentsToActivities", () => {
  const makeActivity = (
    symbol: string,
    date: string,
    type: string,
    qty: number,
    price: number
  ): ActivityImport => ({
    symbol,
    date,
    activityType: type as ActivityImport["activityType"],
    quantity: qty,
    unitPrice: price,
    currency: "USD",
    fee: 0,
    isDraft: false,
  });

  it("should adjust BUY activities before the split date", () => {
    const activities = [
      makeActivity("AAPL", "2020-01-15", "BUY", 10, 300),
      makeActivity("AAPL", "2020-06-20", "BUY", 5, 350),
      makeActivity("AAPL", "2020-09-01", "BUY", 20, 130), // after split
    ];
    const adjustments = [
      {
        affectedSymbol: "AAPL",
        quantityMultiplier: 4,
        priceMultiplier: 0.25,
        effectiveDate: "2020-08-31",
      },
    ];

    const result = applyAdjustmentsToActivities(activities, adjustments);
    expect(result[0].quantity).toBe(40);
    expect(result[0].unitPrice).toBe(75);
    expect(result[1].quantity).toBe(20);
    expect(result[1].unitPrice).toBe(87.5);
    // After split date — no adjustment
    expect(result[2].quantity).toBe(20);
    expect(result[2].unitPrice).toBe(130);
  });

  it("should not adjust non-trade activities", () => {
    const activities = [
      makeActivity("AAPL", "2020-01-15", "DIVIDEND", 100, 1),
      makeActivity("AAPL", "2020-01-15", "FEE", 5, 1),
    ];
    const adjustments = [
      {
        affectedSymbol: "AAPL",
        quantityMultiplier: 4,
        priceMultiplier: 0.25,
        effectiveDate: "2020-08-31",
      },
    ];

    const result = applyAdjustmentsToActivities(activities, adjustments);
    expect(result[0].quantity).toBe(100);
    expect(result[1].quantity).toBe(5);
  });

  it("should not adjust activities for different symbols", () => {
    const activities = [
      makeActivity("MSFT", "2020-01-15", "BUY", 10, 200),
    ];
    const adjustments = [
      {
        affectedSymbol: "AAPL",
        quantityMultiplier: 4,
        priceMultiplier: 0.25,
        effectiveDate: "2020-08-31",
      },
    ];

    const result = applyAdjustmentsToActivities(activities, adjustments);
    expect(result[0].quantity).toBe(10);
    expect(result[0].unitPrice).toBe(200);
  });

  it("should handle multiple adjustments (stacked splits)", () => {
    const activities = [
      makeActivity("TSLA", "2019-06-01", "BUY", 10, 1000),
    ];
    const adjustments = [
      {
        affectedSymbol: "TSLA",
        quantityMultiplier: 5,
        priceMultiplier: 0.2,
        effectiveDate: "2020-08-11",
      },
      {
        affectedSymbol: "TSLA",
        quantityMultiplier: 3,
        priceMultiplier: 1 / 3,
        effectiveDate: "2022-08-25",
      },
    ];

    const result = applyAdjustmentsToActivities(activities, adjustments);
    // 10 * 5 * 3 = 150
    expect(result[0].quantity).toBeCloseTo(150, 5);
    // 1000 * 0.2 * (1/3) = 66.666...
    expect(result[0].unitPrice).toBeCloseTo(66.66666667, 5);
  });

  it("should return original activities when no adjustments", () => {
    const activities = [makeActivity("AAPL", "2020-01-15", "BUY", 10, 300)];
    const result = applyAdjustmentsToActivities(activities, []);
    expect(result).toEqual(activities);
  });

  it("should handle SELL activities", () => {
    const activities = [
      makeActivity("AAPL", "2020-01-15", "SELL", 5, 300),
    ];
    const adjustments = [
      {
        affectedSymbol: "AAPL",
        quantityMultiplier: 4,
        priceMultiplier: 0.25,
        effectiveDate: "2020-08-31",
      },
    ];

    const result = applyAdjustmentsToActivities(activities, adjustments);
    expect(result[0].quantity).toBe(20);
    expect(result[0].unitPrice).toBe(75);
  });

  it("should be case-insensitive on symbol matching", () => {
    const activities = [
      makeActivity("aapl", "2020-01-15", "BUY", 10, 300),
    ];
    const adjustments = [
      {
        affectedSymbol: "AAPL",
        quantityMultiplier: 4,
        priceMultiplier: 0.25,
        effectiveDate: "2020-08-31",
      },
    ];

    const result = applyAdjustmentsToActivities(activities, adjustments);
    expect(result[0].quantity).toBe(40);
  });
});

// ── Integration with preprocessor ───────────────────────────────────────────

describe("Integration: preprocessor classifies corporate actions", () => {
  it("should classify STKD rows as CORPORATE_ACTION", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "STKD",
        Description: "AAPL(US0378331005) SPLIT 4 FOR 1",
        Symbol: "AAPL",
        LevelOfDetail: "DETAIL",
        TradeDate: "2020-08-31",
      },
    ];
    const { processedData, classifications } = preprocessIBKRData(rows);
    // Should be filtered out (not imported)
    expect(processedData).toHaveLength(0);
    expect(classifications.get("CORPORATE_ACTION")).toBe(1);
  });

  it("should classify SOFF rows as CORPORATE_ACTION", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "SOFF",
        Description: "GE SPINOFF",
        Symbol: "GE",
        LevelOfDetail: "DETAIL",
        TradeDate: "2024-04-02",
      },
    ];
    const { classifications } = preprocessIBKRData(rows);
    expect(classifications.get("CORPORATE_ACTION")).toBe(1);
  });

  it("should classify ACQU rows as CORPORATE_ACTION", () => {
    const rows: CsvRowData[] = [
      {
        ActivityCode: "ACQU",
        Description: "XYZ MERGED",
        Symbol: "XYZ",
        LevelOfDetail: "DETAIL",
        TradeDate: "2024-06-01",
      },
    ];
    const { classifications } = preprocessIBKRData(rows);
    expect(classifications.get("CORPORATE_ACTION")).toBe(1);
  });
});
