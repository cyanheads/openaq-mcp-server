/**
 * @fileoverview The production stdio entry point exposes canvas deletion only when opted in.
 * @module tests/tools/dataframe-drop-registration.test
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';

/** Bun prepends a node→bun shim while running scripts; use a native Node binary. */
const nativeNode = process.env.PATH?.split(delimiter)
  .map((directory) => join(directory, 'node'))
  .find((candidate) => {
    try {
      return basename(realpathSync(candidate)) !== 'bun';
    } catch {
      return false;
    }
  });

describe('canvas drop registration', () => {
  it.each([
    { enabled: undefined, runtime: 'bun', dotEnv: false },
    { enabled: 'false', runtime: 'bun', dotEnv: false },
    { enabled: 'true', runtime: 'bun', dotEnv: false },
    { enabled: undefined, runtime: 'node', dotEnv: true },
    { enabled: 'false', runtime: 'node', dotEnv: true },
  ])(
    'honors flag $enabled with $runtime and .env=$dotEnv',
    async ({ enabled, runtime, dotEnv }) => {
      const scratch = await mkdtemp(join(tmpdir(), 'openaq-registration-'));
      const env = {
        ...process.env,
        OPENAQ_API_KEY: 'test-key',
        MCP_TRANSPORT_TYPE: 'stdio',
        MCP_LOG_LEVEL: 'error',
        OTEL_ENABLED: 'false',
        CANVAS_PROVIDER_TYPE: 'none',
        OPENAQ_ENABLE_CANVAS_DROP: enabled ?? '',
      };
      if (dotEnv) {
        Reflect.deleteProperty(env, 'OPENAQ_API_KEY');
        if (enabled === undefined) Reflect.deleteProperty(env, 'OPENAQ_ENABLE_CANVAS_DROP');
        await writeFile(
          join(scratch, '.env'),
          'OPENAQ_API_KEY=test-dotenv-key\nOPENAQ_ENABLE_CANVAS_DROP=true\n',
        );
      }
      const entry = new URL('../../dist/index.js', import.meta.url).href;
      const args =
        runtime === 'node'
          ? [
              '--input-type=module',
              '-e',
              `if (process.versions.bun) throw new Error('Native Node required'); await import(${JSON.stringify(entry)});`,
            ]
          : ['src/index.ts'];
      if (runtime === 'node' && !nativeNode)
        throw new Error('Node.js is required for startup regression tests.');
      const child = spawn(runtime === 'node' ? nativeNode! : runtime, args, {
        env,
        ...(dotEnv ? { cwd: scratch } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = createInterface({ input: child.stdout });
      const pending = new Map<number, (value: Record<string, unknown>) => void>();
      let nextId = 0;
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      lines.on('line', (line) => {
        const response = JSON.parse(line);
        pending.get(response.id)?.(response);
        pending.delete(response.id);
      });
      const request = (method: string, params: object) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const id = ++nextId;
          pending.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const timeout = setTimeout(() => child.kill('SIGTERM'), 8000);
      try {
        const init = await Promise.race([
          request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'registration-test', version: '1' },
          }),
          exited.then(() => {
            throw new Error(`Server exited before initialization: ${stderr}`);
          }),
        ]);
        expect(init.error).toBeUndefined();
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        );
        const listing = await request('tools/list', {});
        const names = (listing.result as { tools: { name: string }[] }).tools.map(
          (tool) => tool.name,
        );
        const shouldEnable = enabled === 'true' || (dotEnv && enabled === undefined);
        expect(names.includes('openaq_dataframe_drop')).toBe(shouldEnable);
        const call = await request('tools/call', {
          name: 'openaq_dataframe_drop',
          arguments: { canvas_id: 'abc1234567' },
        });
        if (shouldEnable) {
          expect(call.result).toMatchObject({
            isError: true,
            structuredContent: { error: { data: { reason: 'canvas_unavailable' } } },
          });
        } else {
          expect(call.error).toBeDefined();
        }
      } finally {
        clearTimeout(timeout);
        child.kill('SIGTERM');
        await exited;
        lines.close();
        await rm(scratch, { recursive: true, force: true });
      }
    },
    10000,
  );
});
