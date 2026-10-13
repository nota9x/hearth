<script lang="ts">
  /* eslint-disable prefer-const -- Bindable props share one Svelte declaration. */
  let {
    checked = $bindable(false),
    id,
    disabled = false,
  }: { checked: boolean; id: string; disabled?: boolean } = $props();
  /* eslint-enable prefer-const */
</script>

<span class="settings-toggle">
  <input {id} type="checkbox" role="switch" bind:checked {disabled} />
  <span class="switch-track" aria-hidden="true"><span></span></span>
</span>

<style>
  .settings-toggle {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 48px;
    height: 44px;
    flex-shrink: 0;
  }
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    z-index: 1;
    cursor: pointer;
  }
  .switch-track {
    width: 44px;
    height: 26px;
    padding: 3px;
    border-radius: 20px;
    background: #50463c;
    transition: background-color var(--motion-state) var(--motion-enter);
  }
  .switch-track span {
    display: block;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #e8ddd0;
    transition:
      transform var(--motion-state) var(--motion-enter),
      background-color var(--motion-state) var(--motion-enter);
  }
  input:checked + .switch-track {
    background: var(--accent);
  }
  input:checked + .switch-track span {
    transform: translateX(18px);
    background: #160e09;
  }
  input:focus-visible + .switch-track {
    outline: 2px solid #e6a479;
    outline-offset: 4px;
  }
  input:hover:not(:disabled) + .switch-track {
    box-shadow: 0 0 0 4px #e8ddd00a;
  }
  input:active:not(:disabled) + .switch-track span {
    scale: 0.92;
  }
  input:disabled {
    cursor: not-allowed;
  }
  input:disabled + .switch-track {
    opacity: 0.45;
  }
  @media (prefers-reduced-motion: reduce) {
    .switch-track,
    .switch-track span {
      transition: none;
    }
  }
</style>
