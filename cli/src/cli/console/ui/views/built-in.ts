import type { BuiltInScreen } from "#cli/console/ui/screen.ts";
import type { BuiltInView } from "#core/console/model.ts";
import { ACCOUNTS_VIEW } from "./accounts.ts";
import { ARTIFACTS_VIEW } from "./artifacts.ts";
import { JOBS_VIEW } from "./jobs.ts";
import { OVERVIEW_VIEW } from "./overview.ts";
import { SETTINGS_VIEW } from "./settings.ts";

export const BUILT_IN_SCREENS: Readonly<Record<BuiltInView, BuiltInScreen>> = {
  overview: OVERVIEW_VIEW,
  artifacts: ARTIFACTS_VIEW,
  jobs: JOBS_VIEW,
  accounts: ACCOUNTS_VIEW,
  settings: SETTINGS_VIEW,
};
