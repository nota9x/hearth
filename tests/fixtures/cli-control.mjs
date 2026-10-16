process.on('message', () => process.emit('SIGTERM'));
process.channel?.unref();
