import {
  deriveStageLabel,
  formatStageAppName,
  formatStageVersionTag,
} from "@t3tools/shared/versionStage";

export const APP_BASE_NAME = "T3 Code";
export const APP_RELEASE_VERSION = "0.0.7";
export const IOS_SHELL_VERSION = "0.0.013";

export const APP_STAGE_LABEL = import.meta.env.DEV ? "Dev" : deriveStageLabel(APP_RELEASE_VERSION);
export const APP_DISPLAY_NAME = import.meta.env.DEV
  ? `${APP_BASE_NAME} (Dev)`
  : formatStageAppName(APP_BASE_NAME, APP_RELEASE_VERSION);

export { deriveStageLabel, formatStageVersionTag };
