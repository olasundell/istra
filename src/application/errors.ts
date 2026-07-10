export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} ${id} was not found`, 404)
  }
}

export class ConflictError extends AppError {
  constructor(entity: string, id: string) {
    super('VERSION_CONFLICT', `${entity} ${id} has changed; refresh and try again`, 409)
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details)
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(key: string) {
    super('IDEMPOTENCY_CONFLICT', `Idempotency key ${key} was already used with different input`, 409)
  }
}
