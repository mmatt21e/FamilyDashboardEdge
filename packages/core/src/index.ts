/**
 * Public entry point for @family-dashboard/core.
 *
 * Phase 0 ships the export worker. Client SDK helpers land alongside the
 * Phase 1 client, once the mobile framework is chosen (docs/phase-plan.md).
 */
export {
  exportFamily,
  toCsv,
  type ExportJob,
  type ExportResult,
  type Queryable,
  type StorageReader,
} from './export.ts';
