import { motion } from '@hearth/core/motion';
import { cubicIn, cubicOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';
import { crossfade, type TransitionConfig } from 'svelte/transition';

type Direction = 'in' | 'out';

export function fadeMotion(
  node: HTMLElement,
  {
    kind = 'feedback',
    enabled = true,
  }: {
    kind?: 'feedback' | 'content' | 'backdrop';
    enabled?: boolean;
  } = {},
) {
  node.dataset.motion = '';
  const opacity = Number(getComputedStyle(node).opacity);
  return ({
    direction = 'in',
  }: { direction?: Direction } = {}): TransitionConfig => ({
    duration:
      !enabled || prefersReducedMotion.current ? 0 : motion[kind][direction],
    easing: direction === 'in' ? cubicOut : cubicIn,
    css: (t) => `opacity: ${t * opacity}`,
  });
}

export function surfaceMotion(
  node: HTMLElement,
  { kind = 'surface', y = 6 }: { kind?: 'surface' | 'dialog'; y?: number } = {},
) {
  node.dataset.motion = '';
  const style = getComputedStyle(node);
  const transform = style.transform === 'none' ? '' : style.transform;
  const opacity = Number(style.opacity);
  return ({
    direction = 'in',
  }: { direction?: Direction } = {}): TransitionConfig => ({
    duration: prefersReducedMotion.current ? 0 : motion[kind][direction],
    easing: direction === 'in' ? cubicOut : cubicIn,
    css: (t, u) =>
      `opacity: ${t * opacity}; transform: ${transform} translateY(${u * y}px) scale(${1 - u * 0.01})`,
  });
}

export function indicatorMotion() {
  return crossfade({
    duration: () => (prefersReducedMotion.current ? 0 : motion.surface.in),
    easing: cubicOut,
  });
}
