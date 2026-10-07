// Verbatim copy of the TransformContext interface from opencode-claude-auth @ 6292741
// src/domain/ports/outbound/index.ts lines 78-85 (the only symbol RequestTransformService.ts imports from it).
export interface TransformContext {
  readonly accessToken: string
  readonly accountUuid: string
  readonly deviceId: string
  readonly sessionId: string
  readonly previousMessageId: string | null
}
