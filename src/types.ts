export type TagValue = string | string[];
export type BagInfo = Record<string, TagValue>;
export type BagInfoInput = Record<string, string | number | boolean | readonly (string | number | boolean)[]>;
export type Checksums = Record<string, string>;
export type Entries = Record<string, Checksums>;

export interface MakeBagOptions {
  bagInfo?: BagInfoInput;
  checksums?: readonly string[];
  /** Tag files written by this library use UTF-8. */
  encoding?: 'utf-8' | 'UTF-8';
  signal?: AbortSignal;
  /** Maximum simultaneous file reads. */
  concurrency?: number;
}

export interface ValidationOptions {
  fast?: boolean;
  completenessOnly?: boolean;
  /** Alias for Python callers. */
  completeness_only?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface SaveOptions {
  manifests?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
}

export type FetchEntry = [url: string, size: string, filename: string];
