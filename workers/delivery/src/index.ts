import {
  type DeliveryEnvironment,
  resolvePublicShare,
} from '../../../packages/core/public-share';

export default {
  fetch: resolvePublicShare,
} satisfies ExportedHandler<DeliveryEnvironment>;
