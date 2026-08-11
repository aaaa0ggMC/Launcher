// Logs ability domain types — the framework log pipeline contract.
//
// The pipeline lives in the framework (`src/main/process/logger.ts`), so the
// entry shapes are framework contracts defined in `src/shared/types.ts`. This
// file re-exports them so the ability stays self-contained (its commands and
// UI import from here).

export type { LogLevel, LogEntry, LogQueryResult } from '../../shared/types'
