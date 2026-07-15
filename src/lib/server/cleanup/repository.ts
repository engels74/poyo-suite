import type { Database } from 'bun:sqlite';
import type { CleanupConsequence, LocalCleanupPolicy } from '../../features/cleanup/contracts';
import { DatabaseRepository } from '../platform/repository';
import { cleanupHash } from './policy';

export const LOCAL_CLEANUP_POLICY_ID = 'local-default';

export interface CleanupOutputRecord {
  outputId: string;
  jobId: string;
  mediaKind: 'image' | 'video';
  localPath: string;
  bytes: number;
  favorite: boolean;
  pinned: boolean;
  createdAt: string;
  tags: string[];
}

export interface CleanupActionSnapshot extends CleanupOutputRecord {
  reasons: Array<'age' | 'storage-limit' | 'free-space'>;
  policyHash: string;
}

export interface CleanupClaim {
  actionId: string;
  outputId: string;
  actionKind: 'local_file' | 'local_metadata' | 'local_both';
  snapshot: CleanupActionSnapshot;
  owner: string;
  token: string;
  attempt: number;
}

type OutputRow = {
  id: string;
  job_id: string;
  media_kind: 'image' | 'video';
  local_path: string;
  byte_size: number | null;
  favorite: number;
  pinned: number;
  created_at: string;
  tags_json: string;
};

type ActionRow = {
  id: string;
  target_id: string;
  action_kind: CleanupClaim['actionKind'];
  safe_result_json: string;
};

function actionKind(consequence: CleanupConsequence): CleanupClaim['actionKind'] {
  return consequence === 'file'
    ? 'local_file'
    : consequence === 'metadata'
      ? 'local_metadata'
      : 'local_both';
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export class CleanupRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly now: () => Date = () => new Date()
  ) {
    super(database);
  }

  getPolicy(): LocalCleanupPolicy | null {
    const row = this.database
      .query<{ policy_json: string }, [string]>(
        'SELECT policy_json FROM cleanup_policies WHERE id=?'
      )
      .get(LOCAL_CLEANUP_POLICY_ID);
    return row ? (JSON.parse(row.policy_json) as LocalCleanupPolicy) : null;
  }

  savePolicy(policy: LocalCleanupPolicy): LocalCleanupPolicy {
    const now = this.now().toISOString();
    this.database
      .query(
        `INSERT INTO cleanup_policies(id,policy_version,enabled,policy_json,created_at,updated_at)
         VALUES (?,1,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET policy_version=policy_version+1,enabled=excluded.enabled,
           policy_json=excluded.policy_json,updated_at=excluded.updated_at`
      )
      .run(
        LOCAL_CLEANUP_POLICY_ID,
        policy.mode === 'never' ? 0 : 1,
        JSON.stringify(policy),
        now,
        now
      );
    return policy;
  }

  listOutputs(): CleanupOutputRecord[] {
    return this.database
      .query<OutputRow, []>(
        `SELECT o.id,o.job_id,o.media_kind,o.local_path,o.byte_size,o.favorite,o.pinned,o.created_at,
          COALESCE((SELECT json_group_array(t.normalized_name) FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=o.job_id),'[]') tags_json
         FROM job_outputs o
         WHERE o.download_state='verified' AND o.local_path IS NOT NULL
         ORDER BY o.created_at ASC,o.id ASC`
      )
      .all()
      .map((row) => ({
        outputId: row.id,
        jobId: row.job_id,
        mediaKind: row.media_kind,
        localPath: row.local_path,
        bytes: row.byte_size ?? 0,
        favorite: row.favorite === 1,
        pinned: row.pinned === 1,
        createdAt: row.created_at,
        tags: parseTags(row.tags_json)
      }));
  }

  persistPreview(
    token: string,
    policyHash: string,
    consequence: CleanupConsequence,
    snapshots: CleanupActionSnapshot[]
  ): void {
    const now = this.now().toISOString();
    const candidateHash = cleanupHash(
      snapshots.map(({ outputId, localPath, bytes, reasons }) => ({
        outputId,
        localPath,
        bytes,
        reasons
      }))
    );
    this.transaction(() => {
      this.database
        .query(
          `INSERT INTO cleanup_previews(token,policy_id,action_kind,policy_hash,candidate_hash,candidate_count,total_bytes,created_at)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(token) DO NOTHING`
        )
        .run(
          token,
          LOCAL_CLEANUP_POLICY_ID,
          actionKind(consequence),
          policyHash,
          candidateHash,
          snapshots.length,
          snapshots.reduce((total, entry) => total + entry.bytes, 0),
          now
        );
      for (const snapshot of snapshots) {
        const id = `cleanup_${cleanupHash([token, snapshot.outputId]).slice(0, 32)}`;
        this.database
          .query(
            `INSERT INTO cleanup_actions(id,policy_id,action_kind,target_id,preview_version,state,due_at,safe_result_json,created_at)
             VALUES (?,?,?,?,?,'previewed',NULL,?,?) ON CONFLICT(id) DO NOTHING`
          )
          .run(
            id,
            LOCAL_CLEANUP_POLICY_ID,
            actionKind(consequence),
            snapshot.outputId,
            token,
            JSON.stringify({ preview: snapshot }),
            now
          );
      }
    });
  }

  schedulePreview(token: string): number {
    return this.transaction(() => {
      const preview = this.database
        .query<
          { policy_hash: string; candidate_count: number; applied_at: string | null },
          [string]
        >('SELECT policy_hash,candidate_count,applied_at FROM cleanup_previews WHERE token=?')
        .get(token);
      if (!preview) throw new Error('Cleanup preview was not found.');
      const policy = this.getPolicy();
      if (!policy || cleanupHash(policy) !== preview.policy_hash) {
        throw new Error('Cleanup preview is stale because the policy changed.');
      }
      const actions = this.database
        .query<ActionRow, [string]>(
          'SELECT id,target_id,action_kind,safe_result_json FROM cleanup_actions WHERE preview_version=? ORDER BY id'
        )
        .all(token);
      if (actions.length !== preview.candidate_count)
        throw new Error('Cleanup preview is incomplete.');
      for (const action of actions) {
        const stored = JSON.parse(action.safe_result_json) as { preview: CleanupActionSnapshot };
        const current = this.listOutputs().find((output) => output.outputId === action.target_id);
        if (!current) throw new Error('A cleanup candidate is no longer available.');
        if (
          current.localPath !== stored.preview.localPath ||
          current.bytes !== stored.preview.bytes ||
          (policy.exclusions.favorites && current.favorite) ||
          (policy.exclusions.pinned && current.pinned) ||
          current.tags.some((tag) => policy.exclusions.tags.includes(tag))
        ) {
          throw new Error('A cleanup candidate changed after preview.');
        }
      }
      if (preview.applied_at) return actions.length;
      const now = this.now().toISOString();
      this.database
        .query(
          `UPDATE cleanup_actions SET state='scheduled',due_at=?
           WHERE preview_version=? AND state='previewed'`
        )
        .run(now, token);
      this.database.query('UPDATE cleanup_previews SET applied_at=? WHERE token=?').run(now, token);
      return actions.length;
    });
  }

  reconcileExpiredClaims(): number {
    const now = this.now().toISOString();
    return this.database
      .query(
        `UPDATE cleanup_actions SET state='scheduled'
         WHERE state='executing' AND NOT EXISTS (
           SELECT 1 FROM work_claims c WHERE c.work_type='cleanup' AND c.work_id=cleanup_actions.id AND c.expires_at>?
         )`
      )
      .run(now).changes;
  }

  claimNext(owner: string, leaseMs: number): CleanupClaim | null {
    return this.transaction(() => {
      const now = this.now().toISOString();
      const action = this.database
        .query<ActionRow, [string]>(
          `SELECT id,target_id,action_kind,safe_result_json FROM cleanup_actions
           WHERE state='scheduled' AND due_at IS NOT NULL AND due_at<=?
           ORDER BY due_at,id LIMIT 1`
        )
        .get(now);
      if (!action) return null;
      const existing = this.database
        .query<{ expires_at: string; attempt: number }, [string]>(
          "SELECT expires_at,attempt FROM work_claims WHERE work_type='cleanup' AND work_id=?"
        )
        .get(action.id);
      if (existing && existing.expires_at > now) return null;
      const token = crypto.randomUUID();
      const attempt = (existing?.attempt ?? 0) + 1;
      const expires = new Date(this.now().getTime() + leaseMs).toISOString();
      if (existing)
        this.database
          .query(
            `UPDATE work_claims SET owner=?,token=?,acquired_at=?,expires_at=?,attempt=?
             WHERE work_type='cleanup' AND work_id=? AND expires_at<=?`
          )
          .run(owner, token, now, expires, attempt, action.id, now);
      else
        this.database
          .query(
            `INSERT INTO work_claims(work_type,work_id,owner,token,acquired_at,expires_at,attempt)
             VALUES ('cleanup',?,?,?,?,?,?)`
          )
          .run(action.id, owner, token, now, expires, attempt);
      const claimed = this.database
        .query<{ token: string }, [string, string]>(
          "SELECT token FROM work_claims WHERE work_type='cleanup' AND work_id=? AND owner=?"
        )
        .get(action.id, owner);
      if (claimed?.token !== token) return null;
      if (
        this.database
          .query("UPDATE cleanup_actions SET state='executing' WHERE id=? AND state='scheduled'")
          .run(action.id).changes !== 1
      ) {
        this.database
          .query("DELETE FROM work_claims WHERE work_type='cleanup' AND work_id=? AND token=?")
          .run(action.id, token);
        return null;
      }
      this.database
        .query(
          `INSERT INTO cleanup_attempts(action_id,attempt,status,started_at)
           VALUES (?,?,'started',?)`
        )
        .run(action.id, attempt, now);
      const parsed = JSON.parse(action.safe_result_json) as { preview: CleanupActionSnapshot };
      return {
        actionId: action.id,
        outputId: action.target_id,
        actionKind: action.action_kind,
        snapshot: parsed.preview,
        owner,
        token,
        attempt
      };
    });
  }

  complete(claim: CleanupClaim, result: unknown): boolean {
    return this.finish(claim, 'complete', result);
  }

  fail(claim: CleanupClaim, result: unknown): boolean {
    return this.finish(claim, 'failed', result);
  }

  private finish(claim: CleanupClaim, state: 'complete' | 'failed', result: unknown): boolean {
    return this.transaction(() => {
      const held = this.database
        .query<{ token: string }, [string, string, string]>(
          "SELECT token FROM work_claims WHERE work_type='cleanup' AND work_id=? AND owner=? AND token=?"
        )
        .get(claim.actionId, claim.owner, claim.token);
      if (!held) return false;
      const now = this.now().toISOString();
      this.database
        .query(
          'UPDATE cleanup_attempts SET status=?,safe_result_json=?,completed_at=? WHERE action_id=? AND attempt=?'
        )
        .run(state, JSON.stringify(result), now, claim.actionId, claim.attempt);
      this.database
        .query('UPDATE cleanup_actions SET state=?,safe_result_json=?,executed_at=? WHERE id=?')
        .run(
          state,
          JSON.stringify({ preview: claim.snapshot, execution: result }),
          state === 'complete' ? now : null,
          claim.actionId
        );
      this.database
        .query(
          "DELETE FROM work_claims WHERE work_type='cleanup' AND work_id=? AND owner=? AND token=?"
        )
        .run(claim.actionId, claim.owner, claim.token);
      return true;
    });
  }

  removeOutputMetadata(outputId: string): boolean {
    return this.database.query('DELETE FROM job_outputs WHERE id=?').run(outputId).changes === 1;
  }

  markOutputFileRemoved(outputId: string): boolean {
    const now = this.now().toISOString();
    return (
      this.database
        .query(
          "UPDATE job_outputs SET local_path=NULL,download_state='deleted',verified_at=NULL,deleted_at=? WHERE id=?"
        )
        .run(now, outputId).changes === 1
    );
  }

  actionCounts(): Record<string, number> {
    return Object.fromEntries(
      this.database
        .query<{ state: string; count: number }, []>(
          'SELECT state,COUNT(*) count FROM cleanup_actions GROUP BY state ORDER BY state'
        )
        .all()
        .map((row) => [row.state, row.count])
    );
  }
}
