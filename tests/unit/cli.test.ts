import { access, readFile } from 'node:fs/promises';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import { toolArguments } from '../../cli/development/command';
import { nativeOptions, prepareSession } from '../../cli/development/config';
import { validateOptions } from '../../cli/options';

const empty = () => ({ web: [], delivery: [], maintenance: [] });

describe('CLI arguments', () => {
  it('forwards exact tokens and splits explicitly targeted groups', () => {
    expect(toolArguments(['delivery'], ['src/index.ts']).delivery).toEqual([
      'src/index.ts',
    ]);
    expect(
      toolArguments(['web'], ['--define', 'NAME=a b', '--help']).web,
    ).toEqual(['--define', 'NAME=a b', '--help']);
    expect(
      toolArguments(
        ['web', 'delivery'],
        ['web', '--debug', 'hmr', '--', 'delivery', '--inspector-port', '9230'],
      ),
    ).toEqual({
      web: ['--debug', 'hmr'],
      delivery: ['--inspector-port', '9230'],
      maintenance: [],
    });
    expect(() => toolArguments(['web', 'delivery'], ['--debug'])).toThrow(
      'Target tool arguments',
    );
    expect(() => toolArguments(['web'], ['delivery', '--debug'])).toThrow(
      'not a selected service',
    );
    expect(() => toolArguments(['web'], ['web', '--debug', '--'])).toThrow(
      'trailing',
    );
  });

  it('validates declared options and retains repeated values', () => {
    const definitions = { delivery: { type: 'string' as const } };
    expect(
      validateOptions(
        ['--delivery=a.example', '--delivery', 'b.example'],
        definitions,
      ).delivery,
    ).toEqual(['a.example', 'b.example']);
    expect(() => validateOptions(['--unknown'], definitions)).toThrow(
      'Unknown option',
    );
    expect(() => validateOptions(['--delivery'], definitions)).toThrow();
  });

  it.each([
    '--remote',
    '-cx',
    '--persist-to=x',
    '--localProtocol=https',
    '--var=APP_ORIGIN:http://evil.example',
  ])('rejects a conflicting native override: %s', (argument) => {
    expect(() =>
      nativeOptions('delivery', 'development', [argument]),
    ).toThrow();
  });

  it('reconciles native addresses while leaving ordinary and future flags untouched', () => {
    expect(
      nativeOptions('delivery', 'development', [
        '--show-interactive-dev-session',
        'false',
      ]).interactive,
    ).toBe(false);
    expect(
      nativeOptions('delivery', 'development', [
        '--local',
        '--remote=false',
        '--local-protocol',
        'http',
      ]).tokens,
    ).toEqual([]);
    expect(
      nativeOptions('web', 'development', [
        '--port=4321',
        '--host',
        '--experimentalBundle',
        '--debug',
        'hmr',
      ]),
    ).toMatchObject({
      port: 4321,
      host: '0.0.0.0',
      tokens: ['--experimentalBundle', '--debug', 'hmr'],
    });
    expect(() =>
      nativeOptions('delivery', 'preview', ['--ip', '192.0.2.1']),
    ).toThrow('local domain validation');
    expect(() => nativeOptions('web', 'development', ['--port=0'])).toThrow(
      'Invalid port',
    );
    expect(() =>
      nativeOptions('delivery', 'preview', [
        '--var',
        'SAFE:x',
        'APP_ORIGIN:http://evil.example',
      ]),
    ).toThrow('reserved');
  });

  it.each(['development', 'preview'] as const)(
    'propagates %s addresses and assigns inspector ports in temporary configs',
    async (mode) => {
      const session = await prepareSession(
        mode,
        ['web', 'delivery'],
        { 'web-port': '4321', 'delivery-port': '9321', host: '0.0.0.0' },
        { ...empty(), web: ['--port', '4322'] },
      );
      try {
        const web = JSON.parse(await readFile(session.files.web, 'utf8')) as {
          vars: Record<string, string>;
          dev: { port: number; inspector_port: number };
        };
        const delivery = JSON.parse(
          await readFile(session.files.delivery, 'utf8'),
        ) as { vars: Record<string, string>; dev: { inspector_port: number } };
        expect(web.dev.port).toBe(4322);
        expect(web.vars.APP_ORIGIN).toBe('http://127.0.0.1:4322');
        expect(delivery.vars.APP_ORIGIN).toBe(web.vars.APP_ORIGIN);
        expect(web.vars.LOCAL_DELIVERY_PORT).toBe('9321');
        expect(web.dev.inspector_port).toBe(0);
        expect(delivery.dev.inspector_port).toBe(0);
        const maintenance = JSON.parse(
          await readFile(session.files.maintenance, 'utf8'),
        ) as { dev: { inspector_port: number } };
        expect(maintenance.dev.inspector_port).toBe(0);
      } finally {
        await session.cleanup();
      }
      await expect(access(session.files.web)).rejects.toThrow();
    },
  );

  it('rejects ambiguous ports, unsupported controls, and incompatible origins', async () => {
    await expect(
      prepareSession('preview', ['web', 'delivery'], { port: '4321' }, empty()),
    ).rejects.toThrow('--port requires');
    await expect(
      prepareSession('preview', ['web'], { force: true }, empty()),
    ).rejects.toThrow('web development');
    await expect(
      prepareSession(
        'development',
        ['web'],
        { 'app-origin': 'https://127.0.0.1:5173' },
        empty(),
      ),
    ).rejects.toThrow('canonical HTTP');
    await expect(
      prepareSession(
        'development',
        ['web', 'delivery'],
        { 'web-port': '8788' },
        empty(),
      ),
    ).rejects.toThrow('distinct');
  });

  it.each([
    '--help',
    'setup --help',
    'configure --help',
    'bootstrap --help',
    'storage initialize --help',
    'dev web -- --version',
    'preview delivery -- --help',
  ])('supports the public entry point: %s', async (arguments_) => {
    const result = await execa(
      process.execPath,
      ['scripts/cli.mjs', ...arguments_.split(' ')],
      { reject: false },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
