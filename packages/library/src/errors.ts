export class LibraryError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict' | 'invalid_request',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends LibraryError {
  constructor(what: string, id: string, details?: unknown) {
    super(`${what} not found: ${id}`, 'not_found', details);
  }
}

export class ConflictError extends LibraryError {
  constructor(message: string, details?: unknown) {
    super(message, 'conflict', details);
  }
}

export class ValidationError extends LibraryError {
  constructor(message: string, details?: unknown) {
    super(message, 'invalid_request', details);
  }
}
