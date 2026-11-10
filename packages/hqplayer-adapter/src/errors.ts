import type { EngineCapabilityKey } from '@hqps/contracts';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'engine_unavailable'
      | 'engine_timeout'
      | 'engine_error'
      | 'capability_unavailable'
      | 'protocol_error',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The engine is not connected (HQPlayer closed, socket dropped, wrong port…). */
export class EngineUnavailableError extends EngineError {
  constructor(message = 'HQPlayer is not connected') {
    super(message, 'engine_unavailable');
  }
}

/**
 * A command did not receive an acknowledgement in time. Callers must NOT blindly retry write
 * commands: the engine may have executed it (e.g. a track might have been queued twice).
 */
export class EngineTimeoutError extends EngineError {
  constructor(
    readonly command: string,
    timeoutMs: number,
  ) {
    super(`HQPlayer did not answer "${command}" within ${timeoutMs} ms`, 'engine_timeout');
  }
}

/** The engine answered with result="Error" (or equivalent). */
export class EngineCommandError extends EngineError {
  constructor(
    readonly command: string,
    detail: string,
  ) {
    super(`HQPlayer rejected "${command}"${detail ? `: ${detail}` : ''}`, 'engine_error');
  }
}

/** The capability has not been verified on the target engine (or is unsupported). */
export class CapabilityUnavailableError extends EngineError {
  constructor(
    readonly capability: EngineCapabilityKey,
    reason: string,
  ) {
    super(`Capability "${capability}" is not available: ${reason}`, 'capability_unavailable');
  }
}

export class ProtocolError extends EngineError {
  constructor(message: string) {
    super(message, 'protocol_error');
  }
}
