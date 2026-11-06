/**
 * Explicit tunnel state machine with validated transitions.
 *
 * States:
 *   STOPPED -> STARTING -> CONNECTING -> ONLINE -> STOPPING -> STOPPED
 *   ONLINE -> RECONNECTING -> CONNECTING | ONLINE | ERROR | STOPPING
 *   Any active state -> ERROR -> STARTING | STOPPED
 */
import type { TunnelState } from '@localshare/shared-types';
import { LocalShareError } from './errors';

const ALLOWED_TRANSITIONS: Readonly<Record<TunnelState, readonly TunnelState[]>> = {
  STOPPED: ['STARTING'],
  STARTING: ['CONNECTING', 'ONLINE', 'STOPPING', 'STOPPED', 'ERROR'],
  CONNECTING: ['ONLINE', 'RECONNECTING', 'STOPPING', 'STOPPED', 'ERROR'],
  ONLINE: ['RECONNECTING', 'STOPPING', 'STOPPED', 'ERROR'],
  RECONNECTING: ['CONNECTING', 'ONLINE', 'STOPPING', 'STOPPED', 'ERROR'],
  STOPPING: ['STOPPED', 'ERROR'],
  ERROR: ['STARTING', 'STOPPING', 'STOPPED'],
};

export function canTransition(from: TunnelState, to: TunnelState): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TunnelState, to: TunnelState): TunnelState {
  if (!canTransition(from, to)) {
    throw new LocalShareError(
      'INVALID_STATE_TRANSITION',
      `Invalid tunnel state transition from ${from} to ${to}.`,
    );
  }
  return to;
}

export function isRunningState(state: TunnelState): boolean {
  return state === 'STARTING' || state === 'CONNECTING' || state === 'ONLINE' || state === 'RECONNECTING';
}

export class TunnelStateMachine {
  private current: TunnelState;
  private readonly listeners = new Set<(next: TunnelState, prev: TunnelState) => void>();

  constructor(initial: TunnelState = 'STOPPED') {
    this.current = initial;
  }

  get state(): TunnelState {
    return this.current;
  }

  transition(next: TunnelState): TunnelState {
    const prev = this.current;
    if (prev === next) return prev;
    assertTransition(prev, next);
    this.current = next;
    for (const listener of this.listeners) {
      listener(next, prev);
    }
    return next;
  }

  onChange(listener: (next: TunnelState, prev: TunnelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

