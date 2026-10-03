import { DockerSandboxRuntime } from './docker.js';
import { DaytonaSandboxRuntime } from './daytona.js';
import type { SandboxRuntime } from './types.js';

export type SandboxProvider = 'docker' | 'daytona';

const instances = new Map<SandboxProvider, SandboxRuntime>();

export function configuredProvider(): SandboxProvider {
  const value = (process.env.KILN_SANDBOX_PROVIDER ?? 'docker').toLowerCase();
  if (value !== 'docker' && value !== 'daytona') throw new Error(`KILN_SANDBOX_PROVIDER must be "docker" or "daytona", got "${value}"`);
  return value;
}

/** One shared runtime per provider (Daytona keeps a client and sandbox cache). */
export function runtimeFor(provider: string): SandboxRuntime {
  if (provider !== 'docker' && provider !== 'daytona') throw new Error(`unsupported sandbox provider: ${provider}`);
  let runtime = instances.get(provider);
  if (!runtime) {
    runtime = provider === 'daytona' ? new DaytonaSandboxRuntime() : new DockerSandboxRuntime();
    instances.set(provider, runtime);
  }
  return runtime;
}

export function createSandboxRuntime(): SandboxRuntime {
  return runtimeFor(configuredProvider());
}
