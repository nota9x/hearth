import { expect, it } from 'vitest';

import { presentAudit } from '../../packages/core/audit-presentation';

it('presents historical audit fields and actions using expiry terminology', () => {
  const log = presentAudit({
    action: 'image.retention',
    actorId: null,
    targetId: null,
    metadata: JSON.stringify({
      changes: [{ field: 'defaultRetention', before: 'never', after: '7d' }],
    }),
  });
  expect(log.details).toContain('Expiry changed from "Never" to "7 days"');
});
