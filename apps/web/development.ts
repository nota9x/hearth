import { createServer } from 'vite';

export async function startWeb(port: number) {
  const server = await createServer({ server: { port } });
  await server.listen();
  return server;
}
