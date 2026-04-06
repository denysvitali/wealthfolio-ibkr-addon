# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Wealthfolio addon that imports Interactive Brokers (IBKR) transactions via CSV files or Flex Query API. It handles multi-currency account creation, ISIN-to-Yahoo-ticker resolution, FX conversion splitting, and smart deduplication.

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build with Vite (outputs dist/addon.js)
pnpm dev              # Build in watch mode
pnpm dev:full         # Build + watch + dev server (for testing in Wealthfolio)
pnpm lint             # Type-check (alias: pnpm type-check)
pnpm test             # Run all tests (vitest)
pnpm test:watch       # Run tests in watch mode
pnpm bundle           # Clean + build + create distribution ZIP
```

Run a single test file: `pnpm vitest run src/__tests__/some-file.test.ts`

## Architecture

**Entry point**: `src/addon.tsx` — registers routes, sidebar items, and auto-fetch event listeners with the Wealthfolio SDK.

**Two main flows:**
1. **Manual CSV Import**: Files → `ibkr-csv-splitter` (extract Section 1 from IBKR's multi-section format) → `ibkr-preprocessor` (classify transactions) → `ticker-resolution-service` (ISIN → Yahoo ticker) → `activity-converter` → `activity-deduplicator` → import via SDK
2. **Auto-Fetch (Flex Query)**: Portfolio update event → debounce (5s) → `AsyncLock` → `flex-query-fetcher` (HTTP polling with exponential backoff) → `flex-csv-parser` → same pipeline as above → import

**`src/lib/`** — All business logic, independently testable:
- `import-orchestrator.ts` — Orchestrates the full import pipeline (preprocess → resolve → convert → deduplicate)
- `ibkr-preprocessor.ts` — Classifies raw IBKR rows by transaction type (BUY, SELL, DIVIDEND, FEES, etc.)
- `ticker-resolution-service.ts` — Resolves IBKR symbols/ISINs to Yahoo Finance tickers
- `activity-converter.ts` — Converts processed rows to Wealthfolio `ActivityImport` objects
- `fx-transaction-splitter.ts` — Splits FX conversions (e.g., GBP.USD) into withdrawal/deposit pairs
- `activity-deduplicator.ts` — Fingerprint-based deduplication with normalized comparison
- `currency-detector.ts` — Detects currencies from IBKR CSV's "LevelOfDetail=Currency" rows
- `flex-config-storage.ts` — CRUD for Flex Query configs with `AsyncLock` for TOCTOU safety; secrets stored in system keyring
- `flex-query-fetcher.ts` — IBKR Flex Query Web Service client with polling (2s→30s backoff, 2m timeout)
- `auto-fetch-processor.ts` — End-to-end auto-fetch: fetch CSV → parse → detect currencies → create accounts → import
- `async-lock.ts` — Mutex preventing concurrent async operations
- `constants.ts` — Centralized timing/limits (cooldown: 6h, debounce: 5s, max file: 50MB)

**`src/pages/`** — Two pages:
- `ibkr-multi-import-page.tsx` — 4-step import wizard (source selection → currency preview → transaction preview → results)
- `ibkr-flex-settings-page.tsx` — Flex Query config management (token, CRUD, auto-fetch toggles)

**`src/components/`** — Step components for the wizard, config management UI, file dropzone, and UI primitives.

**`src/hooks/`** — `use-multi-csv-parser.ts` (CSV parsing with timeout/size protection), `use-flex-configs.ts` (React Query hooks for config CRUD).

**`src/types/`** — `ProcessedIBKRRow`, `IBKRTransactionRow`, `AccountPreview`, `TransactionGroup`, `ImportResult`, `ActivityFingerprint`.

## Key Patterns

- **AsyncLock** is used in both auto-fetch and config storage to prevent race conditions
- **IBKR CSV has 3 concatenated sections** with different schemas; `ibkr-csv-splitter` extracts Section 1
- **Test files** are in `src/__tests__/` and excluded from the main `tsconfig.json` (separate `tsconfig.test.json`)
- React and ReactDOM are **externalized** in the Vite build — the host app provides them
- The addon uses `@wealthfolio/addon-sdk` for all host interactions (accounts, activities, secrets, events, UI)
- Debug logging is controlled by `localStorage.IBKR_DEBUG`

## Build Output

Single ES module at `dist/addon.js` with inline dynamic imports (no code splitting). The `manifest.json` declares addon metadata, permissions, and SDK version.
