export function selectionState(
  selected: readonly string[],
  visible: readonly string[],
) {
  const ids = new Set(selected);
  const count = visible.filter((id) => ids.has(id)).length;
  return {
    checked: visible.length > 0 && count === visible.length,
    indeterminate: count > 0 && count < visible.length,
  };
}

export function selectVisible(
  selected: readonly string[],
  visible: readonly string[],
  checked: boolean,
) {
  const ids = new Set(visible);
  return checked
    ? [...new Set([...selected, ...visible])]
    : selected.filter((id) => !ids.has(id));
}

export function reconcileSelection(
  selected: readonly string[],
  visible: readonly string[],
) {
  const ids = new Set(visible);
  return selected.filter((id) => ids.has(id));
}
