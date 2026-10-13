/**
Shared by the application and the standalone HTML error documents.
*/
export const motion = {
  press: 120,
  state: 180,
  feedback: { in: 180, out: 140 },
  content: { in: 220, out: 180 },
  surface: { in: 220, out: 180 },
  dialog: { in: 260, out: 200 },
  backdrop: { in: 220, out: 200 },
  navigation: { in: 280, out: 220 },
  disclosure: { in: 240, out: 200 },
} as const;

export const motionStyles = `:root {
  --motion-press: ${motion.press}ms;
  --motion-state: ${motion.state}ms;
  --motion-feedback-in: ${motion.feedback.in}ms;
  --motion-feedback-out: ${motion.feedback.out}ms;
  --motion-content-in: ${motion.content.in}ms;
  --motion-content-out: ${motion.content.out}ms;
  --motion-surface-in: ${motion.surface.in}ms;
  --motion-surface-out: ${motion.surface.out}ms;
  --motion-dialog-in: ${motion.dialog.in}ms;
  --motion-dialog-out: ${motion.dialog.out}ms;
  --motion-backdrop-in: ${motion.backdrop.in}ms;
  --motion-backdrop-out: ${motion.backdrop.out}ms;
  --motion-navigation-in: ${motion.navigation.in}ms;
  --motion-navigation-out: ${motion.navigation.out}ms;
  --motion-disclosure-in: ${motion.disclosure.in}ms;
  --motion-disclosure-out: ${motion.disclosure.out}ms;
  --motion-enter: cubic-bezier(0.333333, 1, 0.666667, 1);
  --motion-exit: cubic-bezier(0.333333, 0, 0.666667, 0);
}`;
