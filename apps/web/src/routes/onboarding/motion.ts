import { motion } from '@hearth/core/motion';
import { cubicIn, cubicOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';
import type { TransitionConfig } from 'svelte/transition';

export function stepMotion(node: HTMLElement) {
  node.dataset.motion = '';
  return transition;
}

function transition({
  direction = 'in',
}: { direction?: 'in' | 'out' } = {}): TransitionConfig {
  return {
    duration: prefersReducedMotion.current ? 0 : motion.navigation[direction],
    easing: direction === 'in' ? cubicOut : cubicIn,
    css: (t, u) =>
      `opacity:${t};transform:translateY(${u * (direction === 'in' ? 12 : -6)}px)`,
  };
}

// onNavigate runs after route data and code are ready, keeping setup visible while loading.
export async function dashboardMotion(
  node: HTMLElement,
  complete: Promise<void>,
) {
  if (prefersReducedMotion.current) return;
  if (!document.startViewTransition) {
    node.dataset.motion = '';
    const exit = node.animate(
      [
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: 'translateY(-8px)' },
      ],
      {
        duration: motion.navigation.out,
        easing: 'cubic-bezier(0.333333, 0, 0.666667, 0)',
        fill: 'forwards',
      },
    );
    try {
      await exit.finished;
    } finally {
      exit.cancel();
    }
    return () => {
      if (prefersReducedMotion.current) return;
      const entrance = document.body.animate(
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        {
          duration: motion.navigation.in,
          easing: 'cubic-bezier(0.333333, 1, 0.666667, 1)',
        },
      );
      const cleanup = () => entrance.cancel();
      void entrance.finished.then(cleanup).catch(cleanup);
    };
  }

  // The stylesheet lives only for this handoff; dashboard routes never import it.
  const style = document.createElement('style');
  style.dataset.onboardingTransition = '';
  style.textContent = `
    ::view-transition-group(root) { animation-duration: ${motion.navigation.in}ms; }
    ::view-transition-old(root) {
      animation: hearth-setup-exit ${motion.navigation.out}ms var(--motion-exit) both;
    }
    ::view-transition-new(root) {
      animation: hearth-dashboard-enter ${motion.navigation.in}ms var(--motion-enter) both;
    }
    @keyframes hearth-setup-exit { to { opacity: 0; transform: translateY(-8px); } }
    @keyframes hearth-dashboard-enter { from { opacity: 0; transform: translateY(8px); } }
    @media (prefers-reduced-motion: reduce) {
      ::view-transition-group(root), ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
    }
  `;
  // eslint-disable-next-line unicorn/prefer-dom-node-append -- Workers and DOM Element.append declarations conflict.
  document.head.appendChild(style);
  const { promise, resolve } = Promise.withResolvers<void>();
  const handoff = document.startViewTransition(async () => {
    resolve();
    await complete;
  });
  const cleanup = () => {
    style.remove();
    resolve();
  };
  void handoff.finished.then(cleanup).catch(cleanup);
  await promise;
}
