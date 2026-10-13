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

// A single user-controlled panel is the intentional exception to opacity/transform motion.
export function revealMotion(node: HTMLElement, { open }: { open: boolean }) {
  node.dataset.motion = '';
  const details = node.parentElement as HTMLDetailsElement;
  const content = node.firstElementChild as HTMLElement;
  let expanded = open;
  let animation: Animation | undefined;
  let naturalHeight: number | undefined;
  node.style.height = expanded ? 'auto' : '0px';
  node.style.opacity = expanded ? '1' : '0';

  function settle() {
    node.style.height = expanded ? 'auto' : '0px';
    node.style.opacity = expanded ? '1' : '0';
    animation?.cancel();
    animation = undefined;
    delete details.dataset.collapsing;
  }

  function change(
    from = node.getBoundingClientRect().height,
    to = expanded ? content.getBoundingClientRect().height : 0,
  ) {
    const style = getComputedStyle(node);
    const opacity = Number(style.opacity);
    const easing = style.getPropertyValue(
      expanded ? '--motion-enter' : '--motion-exit',
    );
    animation?.cancel();
    if (prefersReducedMotion.current || Math.abs(from - to) < 0.5) {
      settle();
      return;
    }
    node.style.height = `${to}px`;
    node.style.opacity = expanded ? '1' : '0';
    const current = node.animate(
      [
        { height: `${from}px`, opacity },
        { height: `${to}px`, opacity: expanded ? 1 : 0 },
      ],
      {
        duration: motion.disclosure[expanded ? 'in' : 'out'],
        easing,
        fill: 'both',
      },
    );
    animation = current;
    current.onfinish = () => {
      if (animation === current) settle();
    };
  }

  const observer = new ResizeObserver(([entry]) => {
    const next = entry.borderBoxSize[0].blockSize;
    if (
      expanded &&
      naturalHeight !== undefined &&
      Math.abs(next - naturalHeight) > 0.5
    )
      change(animation ? undefined : naturalHeight, next);
    naturalHeight = next;
  });
  observer.observe(content);
  return {
    update({ open }: { open: boolean }) {
      if (open === expanded) return;
      expanded = open;
      if (expanded) delete details.dataset.collapsing;
      else details.dataset.collapsing = '';
      change();
    },
    destroy() {
      observer.disconnect();
      animation?.cancel();
      delete details.dataset.collapsing;
    },
  };
}
