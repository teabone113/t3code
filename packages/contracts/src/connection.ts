import { Option, Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const BACKEND_PROFILE_ID_MAX_LENGTH = 64;
export const BACKEND_PROFILE_NAME_MAX_LENGTH = 64;
export const BACKEND_PROFILE_HOST_MAX_LENGTH = 255;
export const MAX_REMOTE_BACKEND_PROFILES = 16;

export const BackendMode = Schema.Literals(["local", "remote"]);
export type BackendMode = typeof BackendMode.Type;

export const BackendProtocol = Schema.Literals(["ws", "wss"]);
export type BackendProtocol = typeof BackendProtocol.Type;

export const DesktopStartupRole = Schema.Literals(["frontend-only", "backend-only", "both"]);
export type DesktopStartupRole = typeof DesktopStartupRole.Type;

export const BackendProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BACKEND_PROFILE_ID_MAX_LENGTH),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/i),
);
export type BackendProfileId = typeof BackendProfileId.Type;

export const RemoteBackendProfile = Schema.Struct({
  id: BackendProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(BACKEND_PROFILE_NAME_MAX_LENGTH)),
  host: TrimmedNonEmptyString.check(
    Schema.isMaxLength(BACKEND_PROFILE_HOST_MAX_LENGTH),
    Schema.isPattern(/^[a-z0-9.-]+$/i),
  ),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  protocol: BackendProtocol.pipe(Schema.withDecodingDefault(() => "ws")),
});
export type RemoteBackendProfile = typeof RemoteBackendProfile.Type;

export const BackendSelection = Schema.Struct({
  mode: BackendMode.pipe(Schema.withConstructorDefault(() => Option.some("local"))),
  profileId: Schema.NullOr(BackendProfileId).pipe(
    Schema.withConstructorDefault(() => Option.some(null)),
  ),
});
export type BackendSelection = typeof BackendSelection.Type;

export const DesktopShellBackendConnection = Schema.Struct({
  mode: BackendMode.pipe(Schema.withConstructorDefault(() => Option.some("local"))),
  remoteWsUrl: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withConstructorDefault(() => Option.some(null)),
  ),
});
export type DesktopShellBackendConnection = typeof DesktopShellBackendConnection.Type;
