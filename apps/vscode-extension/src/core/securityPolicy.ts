/**
 * Security policy evaluation for local targets before starting a tunnel.
 */
import {
  detectNonHttpBanner,
  getSensitiveProcess,
  getSensitiveService,
  validateLocalTarget,
  type LocalTarget,
} from '@localshare/validation';
import { LocalShareError } from './errors';

export interface SecurityCheckInput {
  host: string;
  port: number;
  processName?: string;
  banner?: Uint8Array | string;
  allowLanTargets?: boolean;
  allowedSensitivePorts?: readonly number[];
}

export interface SecurityCheckOutcome {
  target: LocalTarget;
  warnings: string[];
  overriddenSensitiveService?: string;
}

/**
 * Evaluate whether a local target is safe to expose.
 * Throws LocalShareError('SENSITIVE_SERVICE_BLOCKED' | 'INVALID_HOST' | 'INVALID_PORT') when blocked.
 */
export function evaluateTargetSecurity(input: SecurityCheckInput): SecurityCheckOutcome {
  const validated = validateLocalTarget(input.host, input.port, {
    allowLanTargets: input.allowLanTargets,
  });
  if (!validated.ok) {
    const code = validated.error.toLowerCase().includes('port') ? 'INVALID_PORT' : 'INVALID_HOST';
    throw new LocalShareError(code, validated.error);
  }

  const target = validated.value;
  const warnings: string[] = [];
  const allowedPorts = new Set(input.allowedSensitivePorts ?? []);

  const sensitiveByPort = getSensitiveService(target.port);
  const sensitiveByProcess = getSensitiveProcess(input.processName);
  const sensitiveByBanner = input.banner ? detectNonHttpBanner(input.banner) : undefined;

  const detectedService = sensitiveByBanner ?? sensitiveByProcess ?? sensitiveByPort?.service;

  if (detectedService) {
    if (!allowedPorts.has(target.port)) {
      throw new LocalShareError(
        'SENSITIVE_SERVICE_BLOCKED',
        `Port ${target.port} appears to run ${detectedService}, which LocalShare blocks from public exposure by default.`,
        `Never expose databases, caches, SSH or container daemons to the public internet. If this port is actually a web app, add ${target.port} to "localshare.security.allowedSensitivePorts".`,
      );
    }
    warnings.push(
      `Port ${target.port} matches sensitive service "${detectedService}" (explicitly overridden in settings).`,
    );
  }

  if (target.scope === 'lan') {
    warnings.push(
      `Target ${target.host}:${target.port} is on your local network (LAN), not this machine.`,
    );
  }

  return {
    target,
    warnings,
    ...(detectedService ? { overriddenSensitiveService: detectedService } : {}),
  };
}

