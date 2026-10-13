<script lang="ts">
  import { selectionState, selectVisible } from './selection';

  const {
    selected,
    onchange,
    visible,
    label = 'Select all',
    disabled = false,
  }: {
    selected: string[];
    onchange: (selected: string[]) => void;
    visible: string[];
    label?: string;
    disabled?: boolean;
  } = $props();
  const state = $derived(selectionState(selected, visible));
</script>

<label class="checkbox-label">
  <input
    type="checkbox"
    checked={state.checked}
    indeterminate={state.indeterminate}
    disabled={disabled || visible.length === 0}
    onchange={(event) =>
      onchange(selectVisible(selected, visible, event.currentTarget.checked))}
  />
  {label}
</label>
