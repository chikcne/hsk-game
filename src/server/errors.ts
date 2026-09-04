import { Data } from "effect";

export const normalizeError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** A Node.js filesystem operation failed while serving the save API. */
export class FsError extends Data.TaggedError("FsError")<{
  readonly operation: string;
  readonly path: string;
  readonly cause: Error;
}> {
  override get message(): string {
    return `fs.${this.operation} failed for ${this.path}: ${this.cause.message}`;
  }

  get errno(): string | undefined {
    return "code" in this.cause ? String(this.cause.code) : undefined;
  }
}

export const isEnoent = (error: FsError): boolean => error.errno === "ENOENT";

export class JsonParseError extends Data.TaggedError("JsonParseError")<{
  readonly cause: Error;
}> {
  override get message(): string {
    return "Request body is not valid JSON";
  }
}

export class DeckManifestError extends Data.TaggedError("DeckManifestError")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: Error;
}> {}

export class FastifyPluginError extends Data.TaggedError("FastifyPluginError")<{
  readonly plugin: string;
  readonly cause: Error;
}> {
  override get message(): string {
    return `Fastify plugin ${this.plugin} failed to register: ${this.cause.message}`;
  }
}
