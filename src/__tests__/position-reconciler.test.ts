/**
 * Position Reconciler Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reconcilePositions,
  parseIBKRPositionsCSV,
  type IBKRPosition,
  type WealthfolioPosition,
} from "../lib/position-reconciler";

// ── reconcilePositions Tests ────────────────────────────────────────────────

describe("reconcilePositions", () => {
  const makeIBKR = (symbol: string, qty: number, costBasis: number, currency = "USD"): IBKRPosition => ({
    symbol,
    quantity: qty,
    costBasis,
    costPrice: costBasis / qty,
    markPrice: 0,
    unrealizedPnL: 0,
    currency,
  });

  const makeWF = (symbol: string, qty: number, costBasis: number, currency = "USD"): WealthfolioPosition => ({
    symbol,
    quantity: qty,
    costBasis,
    costPrice: costBasis / qty,
    currency,
    accountId: "acc1",
    accountName: "Test",
  });

  it("should report match for identical positions", () => {
    const result = reconcilePositions(
      [makeIBKR("AAPL", 100, 15000)],
      [makeWF("AAPL", 100, 15000)]
    );
    expect(result.summary.matched).toBe(1);
    expect(result.summary.mismatched).toBe(0);
    expect(result.rows[0].status).toBe("match");
  });

  it("should report quantity_mismatch", () => {
    const result = reconcilePositions(
      [makeIBKR("AAPL", 150, 15000)],
      [makeWF("AAPL", 100, 15000)]
    );
    expect(result.summary.mismatched).toBe(1);
    expect(result.rows[0].status).toBe("quantity_mismatch");
    expect(result.rows[0].quantityDiff).toBe(50);
  });

  it("should report cost_mismatch", () => {
    const result = reconcilePositions(
      [makeIBKR("AAPL", 100, 15000)],
      [makeWF("AAPL", 100, 14000)]
    );
    expect(result.summary.mismatched).toBe(1);
    expect(result.rows[0].status).toBe("cost_mismatch");
    expect(result.rows[0].costBasisDiff).toBe(1000);
  });

  it("should report both_mismatch", () => {
    const result = reconcilePositions(
      [makeIBKR("AAPL", 150, 20000)],
      [makeWF("AAPL", 100, 14000)]
    );
    expect(result.rows[0].status).toBe("both_mismatch");
  });

  it("should report ibkr_only", () => {
    const result = reconcilePositions(
      [makeIBKR("TSLA", 50, 10000)],
      []
    );
    expect(result.summary.ibkrOnly).toBe(1);
    expect(result.rows[0].status).toBe("ibkr_only");
    expect(result.rows[0].wealthfolio).toBeNull();
  });

  it("should report wealthfolio_only", () => {
    const result = reconcilePositions(
      [],
      [makeWF("MSFT", 30, 9000)]
    );
    expect(result.summary.wealthfolioOnly).toBe(1);
    expect(result.rows[0].status).toBe("wealthfolio_only");
    expect(result.rows[0].ibkr).toBeNull();
  });

  it("should match symbols case-insensitively", () => {
    const result = reconcilePositions(
      [makeIBKR("aapl", 100, 15000)],
      [makeWF("AAPL", 100, 15000)]
    );
    expect(result.summary.matched).toBe(1);
  });

  it("should respect quantity tolerance", () => {
    const result = reconcilePositions(
      [makeIBKR("AAPL", 100.0005, 15000)],
      [makeWF("AAPL", 100, 15000)],
      { quantity: 0.001, costBasis: 0.01 }
    );
    expect(result.rows[0].status).toBe("match");
  });

  it("should respect cost basis tolerance", () => {
    const result = reconcilePositions(
      [makeIBKR("AAPL", 100, 15000.005)],
      [makeWF("AAPL", 100, 15000)],
      { quantity: 0.001, costBasis: 0.01 }
    );
    expect(result.rows[0].status).toBe("match");
  });

  it("should merge multiple IBKR rows for same symbol", () => {
    const result = reconcilePositions(
      [
        makeIBKR("AAPL", 50, 7500),
        makeIBKR("AAPL", 50, 7500),
      ],
      [makeWF("AAPL", 100, 15000)]
    );
    expect(result.summary.matched).toBe(1);
  });

  it("should handle multiple symbols correctly", () => {
    const result = reconcilePositions(
      [
        makeIBKR("AAPL", 100, 15000),
        makeIBKR("MSFT", 50, 20000),
        makeIBKR("TSLA", 30, 9000),
      ],
      [
        makeWF("AAPL", 100, 15000),
        makeWF("MSFT", 50, 20000),
        makeWF("GOOG", 20, 6000),
      ]
    );
    expect(result.summary.matched).toBe(2); // AAPL, MSFT
    expect(result.summary.ibkrOnly).toBe(1); // TSLA
    expect(result.summary.wealthfolioOnly).toBe(1); // GOOG
    expect(result.summary.total).toBe(4);
  });

  it("should handle empty inputs", () => {
    const result = reconcilePositions([], []);
    expect(result.rows).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it("should sort results: mismatches first, then ibkr_only, then wf_only, then matched", () => {
    const result = reconcilePositions(
      [
        makeIBKR("AAPL", 100, 15000),  // match
        makeIBKR("TSLA", 50, 10000),   // ibkr_only
        makeIBKR("NVDA", 200, 40000),  // qty mismatch
      ],
      [
        makeWF("AAPL", 100, 15000),    // match
        makeWF("MSFT", 30, 9000),      // wf_only
        makeWF("NVDA", 150, 40000),    // qty mismatch
      ]
    );
    expect(result.rows[0].status).toBe("quantity_mismatch"); // NVDA
    expect(result.rows[1].status).toBe("ibkr_only");         // TSLA
    expect(result.rows[2].status).toBe("wealthfolio_only");  // MSFT
    expect(result.rows[3].status).toBe("match");             // AAPL
  });
});

// ── parseIBKRPositionsCSV Tests ─────────────────────────────────────────────

describe("parseIBKRPositionsCSV", () => {
  it("should parse a simple positions CSV", () => {
    const csv = [
      "Symbol,ISIN,Quantity,CostBasisMoney,CostBasisPrice,MarkPrice,FifoPnlUnrealized,CurrencyPrimary,ListingExchange,LevelOfDetail",
      "AAPL,US0378331005,100,15000,150,175,2500,USD,NASDAQ,DETAIL",
      "MSFT,US5949181045,50,20000,400,420,1000,USD,NASDAQ,DETAIL",
    ].join("\n");

    const positions = parseIBKRPositionsCSV(csv);
    expect(positions).toHaveLength(2);
    expect(positions[0].symbol).toBe("AAPL");
    expect(positions[0].quantity).toBe(100);
    expect(positions[0].costBasis).toBe(15000);
    expect(positions[0].currency).toBe("USD");
    expect(positions[1].symbol).toBe("MSFT");
  });

  it("should skip summary rows", () => {
    const csv = [
      "Symbol,ISIN,Quantity,CostBasisMoney,CostBasisPrice,MarkPrice,FifoPnlUnrealized,CurrencyPrimary,ListingExchange,LevelOfDetail",
      "AAPL,US0378331005,100,15000,150,175,2500,USD,NASDAQ,DETAIL",
      "Total,,200,35000,,,3500,USD,,SUMMARY",
      ",,,,,,,USD,,Currency",
    ].join("\n");

    const positions = parseIBKRPositionsCSV(csv);
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("AAPL");
  });

  it("should skip zero-quantity positions", () => {
    const csv = [
      "Symbol,ISIN,Quantity,CostBasisMoney,CostBasisPrice,MarkPrice,FifoPnlUnrealized,CurrencyPrimary,ListingExchange,LevelOfDetail",
      "AAPL,US0378331005,0,0,0,175,0,USD,NASDAQ,DETAIL",
    ].join("\n");

    const positions = parseIBKRPositionsCSV(csv);
    expect(positions).toHaveLength(0);
  });

  it("should handle alternative column names", () => {
    const csv = [
      "Symbol,ISIN,Position,CostBasis,CostPrice,ClosePrice,UnrealizedPnL,Currency,ListingExchange,LevelOfDetail",
      "AAPL,US0378331005,100,15000,150,175,2500,USD,NASDAQ,DETAIL",
    ].join("\n");

    const positions = parseIBKRPositionsCSV(csv);
    expect(positions).toHaveLength(1);
    expect(positions[0].quantity).toBe(100);
    expect(positions[0].costBasis).toBe(15000);
  });

  it("should handle empty CSV", () => {
    const positions = parseIBKRPositionsCSV("");
    expect(positions).toHaveLength(0);
  });
});
