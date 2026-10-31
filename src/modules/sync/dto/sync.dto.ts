import { SyncStatus } from '../entities/sync-log.entity';

export interface FindSyncLogsQuery {
  status?: SyncStatus;
  source?: string;
  external_id?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}
