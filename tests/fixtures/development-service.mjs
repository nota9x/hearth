const component = process.argv[2];
const scenario = process.env.HEARTH_DEV_TEST_SCENARIO;
const delay = { web: 150, delivery: 20, maintenance: 80 }[component];
console.log(`booting ${component}`);
console.error(`diagnostic ${component}`);
process.send('booted');
process.on('message', (message) => {
  if (message !== 'begin') {
    if (scenario === 'timeout' && component === 'web') process.send('ready');
    process.stderr.write(`final diagnostic ${component}`, () =>
      process.exit(0),
    );
    return;
  }
  if (scenario !== 'timeout' || component !== 'web')
    setTimeout(() => {
      if (scenario === 'failure' && component === 'delivery') {
        process.stderr.write('startup failure detail', () => process.exit(1));
        return;
      }
      process.send('ready');
      if (scenario === 'late-exit' && component === 'delivery')
        setTimeout(() => process.exit(1), 250);
    }, delay);
});
process.on('disconnect', () => process.exit(0));
