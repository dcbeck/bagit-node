export class BagError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
  override toString(): string { return this.message; }
}

export class ManifestErrorDetail extends BagError {
  constructor(public readonly path: string, message = path) { super(message); }
}

export class ChecksumMismatch extends ManifestErrorDetail {
  constructor(path: string, public readonly algorithm: string, public readonly expected: string, public readonly found: string) {
    super(path, `${path} ${algorithm} validation failed: expected="${expected}" found="${found}"`);
  }
}

export class FileMissing extends ManifestErrorDetail {
  constructor(path: string) { super(path, `${path} exists in manifest but was not found on filesystem`); }
}

export class UnexpectedFile extends ManifestErrorDetail {
  constructor(path: string) { super(path, `${path} exists on filesystem but is not in the manifest`); }
}

export class BagValidationError extends BagError {
  constructor(message: string, public readonly details: ManifestErrorDetail[] = [], options?: ErrorOptions) {
    super(details.length ? `${message}: ${details.join('; ')}` : message, options);
  }
}

export class FileNormalizationConflict extends BagError {
  constructor(public readonly fileA: string, public readonly fileB: string) {
    super(`Unicode normalization conflict for file "${fileA}" and "${fileB}"`);
  }
  get file_a(): string { return this.fileA; }
  get file_b(): string { return this.fileB; }
}
