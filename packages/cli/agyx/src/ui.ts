import {
  AgentProfilePresentationRow,
  agentCliManifests,
  decideUseProfile,
  pickAgentProfileAction,
  ProfilePickerAction,
  ProfilePickerMode,
  renderAgentProfileTable,
  UseProfileDecision,
} from "@dong-/agentx-core";
import {
  createPrompt,
  useEffect,
  isDownKey,
  isEnterKey,
  isUpKey,
  useKeypress,
  usePrefix,
  useState,
} from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";
import { confirm } from "@inquirer/prompts";
import { color } from "./color.js";
import { AutoSwitchMode, State } from "./config.js";
import { buildProfileViews, ProfileView } from "./profile_view.js";
import { QuotaScope } from "./quota.js";
import { selectNextProfile } from "./selection.js";

function profileRows(
  state: Pick<State, "activeProfile" | "profiles" | "settings">,
  quotaScopes: QuotaScope[] = [],
): ProfileView[] {
  return buildProfileViews(state, new Date(), { quotaScopes });
}

function presentationRows(
  state: Pick<State, "activeProfile" | "profiles" | "settings">,
  quotaScopes: QuotaScope[] = [],
): AgentProfilePresentationRow[] {
  return profileRows(state, quotaScopes).map((row) => ({
    id: row.profile.name,
    active: row.marker === "*",
    selectable: row.selectable,
    muted: row.runtimeStatus !== "ready",
    disabledReason: row.disabledReason,
    cells: {
      marker: row.marker || " ",
      number: row.number,
      name: row.name,
      expectedEmail: row.expectedEmail,
      actualEmail: row.actualEmail,
      status: row.status,
      quotaReset: row.quotaReset,
      lastRequest: row.lastRequest,
      activated: row.activated,
      verified: row.verified,
      switches: row.switches,
    },
  }));
}

const textPrompt = createPrompt<string | undefined, {
  message: string;
  default?: string;
}>((config, done) => {
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [value, setValue] = useState(config.default ?? "");
  const prefix = usePrefix({ status });

  useEffect((readline) => {
    if (!config.default) return;
    readline.write(config.default);
    setValue(config.default);
  }, []);

  useKeypress((key, readline) => {
    if (status === "done") return;
    const keyName = key.name?.toLowerCase();
    if (keyName === "escape") {
      setStatus("done");
      done(undefined);
      return;
    }
    if (isEnterKey(key)) {
      setStatus("done");
      done(readline.line);
      return;
    }
    setValue(readline.line);
  });

  if (status === "done") return "";
  return [prefix, config.message, value].filter(Boolean).join(" ") + cursorHide;
});

export function printProfileTable(
  state: Pick<State, "activeProfile" | "profiles" | "settings">,
  quotaScopes: QuotaScope[] = [],
): void {
  console.log(renderAgentProfileTable(presentationRows(state, quotaScopes)));
}

export async function pickProfileAction(
  state: Pick<State, "activeProfile" | "profiles" | "settings">,
  mode: ProfilePickerMode,
  notice?: string,
  quotaScopes: QuotaScope[] = [],
): Promise<ProfilePickerAction> {
  if (!state.profiles.length) throw new Error("No saved profiles.");

  const suggested = (() => {
    try {
      return selectNextProfile({
        version: 1,
        activeProfile: state.activeProfile,
        settings: state.settings,
        profiles: state.profiles,
      }, new Date(), { quotaScopes }).name;
    } catch {
      return undefined;
    }
  })();

  return await pickAgentProfileAction({
    rows: presentationRows(state, quotaScopes),
    mode,
    notice,
    default: state.activeProfile ?? (mode === "use" ? suggested : undefined),
    capabilities: { delete: true, rename: true },
  });
}

export function decideProfileUse(
  state: Pick<State, "activeProfile" | "profiles" | "settings">,
  quotaScopes: QuotaScope[] = [],
): UseProfileDecision {
  const rows = profileRows(state, quotaScopes);
  return decideUseProfile(rows.map((row) => ({
    name: row.profile.name,
    active: row.marker === "*",
    selectable: row.selectable,
    disabledReason: row.disabledReason,
  })));
}

export async function confirmAction(
  message: string,
  defaultValue: boolean,
): Promise<boolean> {
  return await confirm({ message, default: defaultValue });
}

const autoSwitchModeDescriptions: Record<AutoSwitchMode, string> = {
  "all-scopes": "Switch only after every independently usable scope is exhausted.",
  "scope-first": "Switch as soon as the currently used scope is exhausted.",
  off: "Record quota events but do not switch automatically.",
};

const autoSwitchModes: Array<{
  value: AutoSwitchMode;
  label: string;
  description: string;
}> = agentCliManifests.agy.quotaFailover.supportedAutoSwitchModes.map((value) => ({
  value,
  label: value,
  description: autoSwitchModeDescriptions[value],
}));

const autoSwitchPicker = createPrompt<AutoSwitchMode | undefined, {
  message: string;
  default: AutoSwitchMode;
}>((config, done) => {
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const initial = autoSwitchModes.findIndex((mode) => mode.value === config.default);
  const [active, setActive] = useState(initial >= 0 ? initial : 0);
  const prefix = usePrefix({ status });

  useKeypress((key) => {
    const keyName = key.name?.toLowerCase();
    if (keyName === "q" || keyName === "escape") {
      setStatus("done");
      done(undefined);
      return;
    }
    if (isEnterKey(key)) {
      setStatus("done");
      done(autoSwitchModes[active]!.value);
      return;
    }
    if (isUpKey(key) || isDownKey(key)) {
      const offset = isUpKey(key) ? -1 : 1;
      setActive((active + offset + autoSwitchModes.length) % autoSwitchModes.length);
    }
  });

  if (status === "done") return "";
  const lines = autoSwitchModes.map((mode, index) => {
    const marker = index === active ? "❯" : " ";
    const selected = mode.value === config.default ? "*" : " ";
    const line = `${marker} ${selected} ${mode.label.padEnd(14)} ${mode.description}`;
    return index === active ? color.inverse(line) : line;
  });
  return [
    [prefix, config.message].filter(Boolean).join(" "),
    ...lines,
    color.gray("↑↓ navigate • ⏎ select • q quit"),
  ].join("\n") + cursorHide;
});

export async function pickAutoSwitchMode(
  currentMode: AutoSwitchMode,
): Promise<AutoSwitchMode | undefined> {
  try {
    return await autoSwitchPicker({
      message: "Select autoswitch mode",
      default: currentMode,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return undefined;
    }
    throw error;
  }
}

export async function promptText(
  message: string,
  defaultValue?: string,
): Promise<string | undefined> {
  try {
    return await textPrompt({ message, default: defaultValue });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return undefined;
    }
    throw error;
  }
}

export async function selectProfileName(
  state: Pick<State, "activeProfile" | "profiles">,
): Promise<string> {
  const action = await pickProfileAction(state, "use");
  if (action.type === "select") return action.name;
  throw new Error("No profile selected.");
}
