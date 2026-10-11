/** How a driving adapter reports a failure it answered on its own (a defect, or a stream that broke mid-way). */
export abstract class ErrorReporterPort {
  abstract report(context: string, error: unknown): void;
}
