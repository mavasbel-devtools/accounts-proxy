// Lifecycle abstractions the CLI's `serve` command drives (implemented by the socket server and the process).

export type Listening = { readonly host: string; readonly port: number };

export abstract class Server {
  /** Binds and starts accepting connections; a busy port is fatal (PortInUseError). */
  abstract start(): Promise<Listening>;
  /** Stops accepting, lets in-flight responses finish for up to `graceMs`, then closes what is left. */
  abstract stop(graceMs: number): Promise<void>;
}

export abstract class ShutdownSignal {
  /** Resolves with the signal name (SIGINT, SIGTERM) when the process is asked to stop. */
  abstract wait(): Promise<string>;
}
