import { getCancelSignal } from 'execa';

const signal = await getCancelSignal();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  // Deliver cooperative shutdown on Windows, where OS signals force termination.
  // Early cancellation may precede the tool's signal handler registration.
  if (!process.emit('SIGTERM', 'SIGTERM')) process.exit(0);
}
signal.addEventListener('abort', stop, { once: true });
if (signal.aborted) stop();
