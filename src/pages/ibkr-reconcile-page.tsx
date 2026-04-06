import React, { useState, useCallback, useEffect } from "react";
import { Page, PageHeader, PageContent, Card, CardContent, CardHeader, CardTitle, Input, Button, EmptyPlaceholder } from "@wealthfolio/ui";
import { RefreshCw, AlertTriangle, CheckCircle, MinusCircle, HelpCircle } from "lucide-react";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import { fetchFlexQuery, setHttpClient, validateQueryId } from "../lib/flex-query-fetcher";
import { loadToken, loadConfigsSafe, type FlexQueryConfig } from "../lib/flex-config-storage";
import {
  parseIBKRPositionsCSV,
  reconcilePositions,
  type ReconciliationResult,
  type WealthfolioPosition,
} from "../lib/position-reconciler";
import { getErrorMessage } from "../lib/shared-utils";
import { debug } from "../lib/debug-logger";
import { ImportAlert } from "../components/import-alert";

interface IBKRReconcilePageProps {
  ctx?: AddonContext;
}

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; icon: React.ReactNode }
> = {
  match: { label: "Match", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200", icon: <CheckCircle className="h-3.5 w-3.5" /> },
  quantity_mismatch: { label: "Qty Mismatch", color: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200", icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  cost_mismatch: { label: "Cost Mismatch", color: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200", icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  both_mismatch: { label: "Both Mismatch", color: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200", icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  ibkr_only: { label: "IBKR Only", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200", icon: <MinusCircle className="h-3.5 w-3.5" /> },
  wealthfolio_only: { label: "WF Only", color: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-200", icon: <MinusCircle className="h-3.5 w-3.5" /> },
};

const IBKRReconcilePage: React.FC<IBKRReconcilePageProps> = ({ ctx }) => {
  const [positionsQueryId, setPositionsQueryId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [configs, setConfigs] = useState<FlexQueryConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string>("");

  // Initialize HTTP client
  useEffect(() => {
    if (ctx?.api?.http) {
      setHttpClient(ctx.api.http);
    }
  }, [ctx]);

  // Load existing configs
  useEffect(() => {
    const loadData = async () => {
      if (!ctx?.api?.secrets) return;
      const loadResult = await loadConfigsSafe(ctx.api.secrets);
      if (loadResult.success && loadResult.configs) {
        setConfigs(loadResult.configs);
        if (loadResult.configs.length > 0) {
          setSelectedConfigId(loadResult.configs[0].id);
        }
      }
    };
    loadData();
  }, [ctx]);

  const handleReconcile = useCallback(async () => {
    if (!ctx?.api) return;

    const queryId = positionsQueryId.trim();
    if (!queryId) {
      setError("Please enter a Positions Flex Query ID");
      return;
    }

    const queryValidation = validateQueryId(queryId);
    if (!queryValidation.valid) {
      setError(queryValidation.error || "Invalid Query ID");
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      // 1. Load token
      setLoadingMessage("Loading credentials...");
      const token = await loadToken(ctx.api.secrets);
      if (!token) {
        setError("No Flex token configured. Set it in IBKR Settings.");
        return;
      }

      // 2. Fetch IBKR positions via Flex Query
      setLoadingMessage("Fetching positions from IBKR...");
      const flexResult = await fetchFlexQuery(
        { token, queryId },
        {
          onProgress: (msg) => setLoadingMessage(msg),
        }
      );

      if (!flexResult.success || !flexResult.csv) {
        setError(`Failed to fetch IBKR positions: ${flexResult.error}`);
        return;
      }

      // 3. Parse IBKR positions
      setLoadingMessage("Parsing IBKR positions...");
      const ibkrPositions = parseIBKRPositionsCSV(flexResult.csv);
      if (ibkrPositions.length === 0) {
        setError("No positions found in the IBKR Flex Query response. Make sure you created an 'Open Positions' type Flex Query.");
        return;
      }

      // 4. Get Wealthfolio holdings
      setLoadingMessage("Loading Wealthfolio positions...");
      const selectedConfig = configs.find(c => c.id === selectedConfigId);
      const allAccounts = await ctx.api.accounts?.getAll() || [];

      // Filter accounts by the selected config's account group (if any)
      const relevantAccounts = selectedConfig
        ? allAccounts.filter(a => a.group === selectedConfig.accountGroup)
        : allAccounts;

      const wfPositions: WealthfolioPosition[] = [];
      for (const account of relevantAccounts) {
        try {
          const activities = await ctx.api.activities?.getAll(account.id);
          if (!Array.isArray(activities)) continue;

          // Build position from activities (sum BUY - SELL quantities)
          const positionMap = new Map<string, { qty: number; totalCost: number }>();
          for (const a of activities) {
            const symbol = a.assetSymbol;
            if (!symbol || symbol.startsWith("$CASH-")) continue;

            const current = positionMap.get(symbol) || { qty: 0, totalCost: 0 };
            if (a.activityType === "BUY") {
              current.qty += a.quantity;
              current.totalCost += a.quantity * a.unitPrice;
            } else if (a.activityType === "SELL") {
              // Simplified cost basis reduction (proportional)
              const costPerUnit = current.qty > 0 ? current.totalCost / current.qty : 0;
              current.qty -= a.quantity;
              current.totalCost -= a.quantity * costPerUnit;
            }
            positionMap.set(symbol, current);
          }

          for (const [symbol, pos] of positionMap) {
            if (Math.abs(pos.qty) < 0.001) continue; // Skip zero positions
            wfPositions.push({
              symbol,
              quantity: pos.qty,
              costBasis: pos.totalCost,
              costPrice: pos.qty > 0 ? pos.totalCost / pos.qty : 0,
              currency: account.currency,
              accountId: account.id,
              accountName: account.name,
            });
          }
        } catch (e) {
          debug.warn(`Failed to load activities for account ${account.name}: ${getErrorMessage(e)}`);
        }
      }

      // 5. Reconcile
      setLoadingMessage("Reconciling positions...");
      const reconcileResult = reconcilePositions(ibkrPositions, wfPositions);
      setResult(reconcileResult);
      debug.log(`[Reconcile] Complete: ${reconcileResult.summary.matched} matched, ${reconcileResult.summary.mismatched} mismatched`);
    } catch (e) {
      setError(`Reconciliation failed: ${getErrorMessage(e)}`);
    } finally {
      setIsLoading(false);
      setLoadingMessage("");
    }
  }, [ctx, positionsQueryId, configs, selectedConfigId]);

  const formatNumber = (n: number, decimals = 2) => {
    return n.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };

  return (
    <Page>
      <PageHeader heading="IBKR Position Reconciliation" />
      <PageContent withPadding={false}>
        <div className="px-2 pt-2 pb-6 sm:px-4 sm:pt-4 md:px-6 md:pt-6 space-y-6">
          {/* Configuration Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reconciliation Setup</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Compare your IBKR open positions against Wealthfolio to find discrepancies.
                You need a separate Flex Query configured for <strong>Open Positions</strong> (not Activity Statement).
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                {/* Account Group Selection */}
                {configs.length > 0 && (
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Account Group</label>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={selectedConfigId}
                      onChange={(e) => setSelectedConfigId(e.target.value)}
                    >
                      <option value="">All accounts</option>
                      {configs.map((config) => (
                        <option key={config.id} value={config.id}>
                          {config.name} ({config.accountGroup})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Positions Query ID */}
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Positions Query ID</label>
                  <Input
                    placeholder="Enter your Open Positions Flex Query ID"
                    value={positionsQueryId}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPositionsQueryId(e.target.value)}
                  />
                </div>
              </div>

              <Button
                onClick={handleReconcile}
                disabled={isLoading || !positionsQueryId.trim()}
                className="w-full sm:w-auto"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    {loadingMessage || "Loading..."}
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Reconcile Positions
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Error */}
          {error && (
            <ImportAlert variant="error" title="Reconciliation Error">
              {error}
            </ImportAlert>
          )}

          {/* Results */}
          {result && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Reconciliation Results</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Summary */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-lg border p-3 text-center">
                    <p className="text-2xl font-bold text-emerald-600">{result.summary.matched}</p>
                    <p className="text-xs text-muted-foreground">Matched</p>
                  </div>
                  <div className="rounded-lg border p-3 text-center">
                    <p className="text-2xl font-bold text-red-600">{result.summary.mismatched}</p>
                    <p className="text-xs text-muted-foreground">Mismatched</p>
                  </div>
                  <div className="rounded-lg border p-3 text-center">
                    <p className="text-2xl font-bold text-blue-600">{result.summary.ibkrOnly}</p>
                    <p className="text-xs text-muted-foreground">IBKR Only</p>
                  </div>
                  <div className="rounded-lg border p-3 text-center">
                    <p className="text-2xl font-bold text-purple-600">{result.summary.wealthfolioOnly}</p>
                    <p className="text-xs text-muted-foreground">WF Only</p>
                  </div>
                </div>

                {result.summary.mismatched === 0 && result.summary.ibkrOnly === 0 && result.summary.wealthfolioOnly === 0 && (
                  <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-4 text-center">
                    <CheckCircle className="h-8 w-8 mx-auto mb-2 text-emerald-600" />
                    <p className="font-medium text-emerald-800 dark:text-emerald-200">All positions match!</p>
                    <p className="text-sm text-emerald-600 dark:text-emerald-300 mt-1">
                      Your Wealthfolio data is in sync with IBKR.
                    </p>
                  </div>
                )}

                {/* Table */}
                {result.rows.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          <th className="px-3 py-2 text-left font-medium">Status</th>
                          <th className="px-3 py-2 text-left font-medium">Symbol</th>
                          <th className="px-3 py-2 text-left font-medium">Currency</th>
                          <th className="px-3 py-2 text-right font-medium">IBKR Qty</th>
                          <th className="px-3 py-2 text-right font-medium">WF Qty</th>
                          <th className="px-3 py-2 text-right font-medium">Qty Diff</th>
                          <th className="px-3 py-2 text-right font-medium">IBKR Cost</th>
                          <th className="px-3 py-2 text-right font-medium">WF Cost</th>
                          <th className="px-3 py-2 text-right font-medium">Cost Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row, i) => {
                          const statusCfg = STATUS_CONFIG[row.status] || STATUS_CONFIG.match;
                          return (
                            <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                              <td className="px-3 py-2">
                                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusCfg.color}`}>
                                  {statusCfg.icon}
                                  {statusCfg.label}
                                </span>
                              </td>
                              <td className="px-3 py-2 font-mono text-xs">{row.symbol}</td>
                              <td className="px-3 py-2 text-xs">{row.currency}</td>
                              <td className="px-3 py-2 text-right font-mono text-xs">
                                {row.ibkr ? formatNumber(row.ibkr.quantity, 4) : "-"}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-xs">
                                {row.wealthfolio ? formatNumber(row.wealthfolio.quantity, 4) : "-"}
                              </td>
                              <td className={`px-3 py-2 text-right font-mono text-xs ${row.quantityDiff !== 0 ? "text-red-600 dark:text-red-400 font-medium" : ""}`}>
                                {row.quantityDiff !== 0 ? (row.quantityDiff > 0 ? "+" : "") + formatNumber(row.quantityDiff, 4) : "-"}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-xs">
                                {row.ibkr ? formatNumber(row.ibkr.costBasis) : "-"}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-xs">
                                {row.wealthfolio ? formatNumber(row.wealthfolio.costBasis) : "-"}
                              </td>
                              <td className={`px-3 py-2 text-right font-mono text-xs ${row.costBasisDiff !== 0 ? "text-red-600 dark:text-red-400 font-medium" : ""}`}>
                                {Math.abs(row.costBasisDiff) > 0.01 ? (row.costBasisDiff > 0 ? "+" : "") + formatNumber(row.costBasisDiff) : "-"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Help text */}
                <div className="flex items-start gap-2 text-sm text-muted-foreground rounded-lg bg-muted/30 p-3">
                  <HelpCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-medium">How to fix discrepancies</p>
                    <ul className="mt-1 space-y-0.5 text-xs list-disc list-inside">
                      <li><strong>Qty Mismatch:</strong> Missing trades, corporate actions (splits), or unprocessed transfers.</li>
                      <li><strong>Cost Mismatch:</strong> Different cost basis methods, missing trade fees, or FX conversion differences.</li>
                      <li><strong>IBKR Only:</strong> Position exists in IBKR but has no matching imports in Wealthfolio.</li>
                      <li><strong>WF Only:</strong> Position exists in Wealthfolio but not in IBKR (may have been closed).</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Empty state */}
          {!result && !error && !isLoading && (
            <Card>
              <CardContent className="py-12">
                <EmptyPlaceholder>
                  <EmptyPlaceholder.Title>No reconciliation yet</EmptyPlaceholder.Title>
                  <EmptyPlaceholder.Description>
                    Enter your Open Positions Flex Query ID above and click "Reconcile Positions" to compare your IBKR holdings with Wealthfolio.
                  </EmptyPlaceholder.Description>
                </EmptyPlaceholder>
              </CardContent>
            </Card>
          )}
        </div>
      </PageContent>
    </Page>
  );
};

export default IBKRReconcilePage;
