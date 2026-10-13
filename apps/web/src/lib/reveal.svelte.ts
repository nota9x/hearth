import { motion } from '@hearth/core/motion';
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import { prefersReducedMotion } from 'svelte/motion';

// A single user-controlled panel is the intentional exception to opacity/transform motion.
export function revealMotion(getOpen: () => boolean): Attachment<HTMLElement> {
  return (node) => {
    node.dataset.motion = '';
    const details = node.parentElement as HTMLDetailsElement;
    const content = node.firstElementChild as HTMLElement;
    let expanded = untrack(getOpen);
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
    $effect(() => {
      const open = getOpen();
      if (open === expanded) return;
      expanded = open;
      if (expanded) delete details.dataset.collapsing;
      else details.dataset.collapsing = '';
      change();
    });
    return () => {
      observer.disconnect();
      animation?.cancel();
      delete details.dataset.collapsing;
    };
  };
}
