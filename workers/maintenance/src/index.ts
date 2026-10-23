import type { Env } from '../../../packages/core/env';
import type { Environment } from './maintenance';

export { MaintenanceJob } from './job';

export default {
  scheduled(
    _event: ScheduledController,
    environment: Environment & Pick<Env, 'MAINTENANCE'>,
    context: ExecutionContext,
  ) {
    context.waitUntil(environment.MAINTENANCE.getByName('instance').wake());
  },
} satisfies ExportedHandler<Environment & Pick<Env, 'MAINTENANCE'>>;
