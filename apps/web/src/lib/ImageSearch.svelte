<script lang="ts">
  import {
    imageFormats,
    sizeOptions,
    sortOptions,
  } from '@hearth/core/image-search';

  import SearchControls from '#lib/SearchControls.svelte';

  const {
    total,
    unfilteredTotal,
    deliveryDomains,
    admin = false,
  }: {
    total: number;
    unfilteredTotal: number;
    deliveryDomains: { id: string; hostname: string }[];
    admin?: boolean;
  } = $props();
  const filters = $derived([
    ...(admin
      ? [{ key: 'owner', label: 'Owner user ID', placeholder: 'User ID' }]
      : []),
    {
      key: 'type',
      label: 'Format',
      placeholder: 'All formats',
      options: imageFormats,
    },
    {
      key: 'orientation',
      label: 'Orientation',
      placeholder: 'All orientations',
      options: {
        landscape: 'Landscape',
        portrait: 'Portrait',
        square: 'Square',
      },
    },
    {
      key: 'size',
      label: 'File size',
      placeholder: 'Any size',
      options: sizeOptions,
    },
    ...(deliveryDomains.length > 0
      ? [
          {
            key: 'domain',
            label: 'Delivery domain',
            placeholder: 'All delivery domains',
            options: Object.fromEntries(
              deliveryDomains.map((domain) => [domain.id, domain.hostname]),
            ),
          },
        ]
      : []),
  ]);
</script>

<SearchControls
  {total}
  {unfilteredTotal}
  {filters}
  {sortOptions}
  noun="image"
  plural="images"
  dateLabel="Upload date"
  querySort="best"
/>
