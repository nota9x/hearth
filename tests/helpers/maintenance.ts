import { scanStorage } from '../../packages/core/storage-maintenance';
import {
  type Environment,
  routineStages,
  runMaintenance,
  withMaintenanceLease,
} from '../../workers/maintenance/src/maintenance';

// Direct stage harness for domain invariants; production only executes from the DO alarm.
export async function maintain(environment: Environment) {
  await withMaintenanceLease(environment, async () => {
    for (const stage of routineStages) await runMaintenance(environment, stage);
    const run = await environment.DB.prepare(
      "SELECT id FROM reconciliation_runs WHERE status='running'",
    ).first<{ id: string }>();
    if (!run) {
      return;
    }

    for (let index = 0; index < 100; index++) {
      await scanStorage(environment.DB, environment.BUCKET, run.id);
      if (
        !(await environment.DB.prepare(
          "SELECT id FROM reconciliation_runs WHERE id=? AND status='running'",
        )
          .bind(run.id)
          .first())
      )
        return;
    }
    throw new Error('Test scan did not finish');
  });
}
