import { cursorHide } from "@inquirer/ansi";
import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  useKeypress,
  usePagination,
  usePrefix,
  useState,
} from "@inquirer/core";
import Table from "cli-table3";
import stringWidth from "string-width";

export interface AgentProfileColumn {
  key: string;
  header: string;
  align: "left" | "center" | "right";
}

export const agentProfileTableColumns: readonly AgentProfileColumn[] = [
  { key: "marker", header: "", align: "center" },
  { key: "number", header: "#", align: "right" },
  { key: "name", header: "name", align: "left" },
  { key: "expectedEmail", header: "expected-email", align: "left" },
  { key: "actualEmail", header: "actual-email", align: "left" },
  { key: "status", header: "status", align: "left" },
  { key: "quotaReset", header: "quota-reset", align: "left" },
  { key: "lastRequest", header: "last-request", align: "left" },
  { key: "activated", header: "activated", align: "left" },
  { key: "verified", header: "verified", align: "left" },
  { key: "switches", header: "switches", align: "right" },
] as const;

export const agentProfileTableHeaders = agentProfileTableColumns.map(({ header }) => header);

export interface AgentProfilePresentationRow {
  id: string;
  active: boolean;
  selectable: boolean;
  muted?: boolean;
  disabledReason?: string;
  cells: Readonly<Record<string, string>>;
}

export type ProfilePickerMode = "list" | "use";

export type ProfilePickerAction =
  | { type: "select"; name: string; requiresConfirmation: boolean; disabledReason?: string }
  | { type: "delete"; name: string }
  | { type: "rename"; name: string }
  | { type: "exit" };

export interface ProfilePickerCapabilities {
  delete?: boolean;
  rename?: boolean;
}

const ansi = {
  reset: "\u001b[0m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  gray: "\u001b[90m",
  inverse: "\u001b[7m",
} as const;

function colorEnabled(): boolean {
  return process.env.NO_COLOR === undefined
    && process.env.TERM !== "dumb"
    && Boolean(process.stdout.isTTY);
}

function styled(code: string, value: string): string {
  return colorEnabled() ? `${code}${value}${ansi.reset}` : value;
}

function rowCells(
  row: AgentProfilePresentationRow,
  columns: readonly AgentProfileColumn[],
): string[] {
  return columns.map(({ key }) => row.cells[key] ?? "");
}

function padCell(value: string, width: number, align: AgentProfileColumn["align"]): string {
  const missing = Math.max(0, width - stringWidth(value));
  if (align === "right") return `${" ".repeat(missing)}${value}`;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(missing - left)}`;
  }
  return `${value}${" ".repeat(missing)}`;
}

export function agentProfileColumnWidths(
  rows: readonly AgentProfilePresentationRow[],
  columns: readonly AgentProfileColumn[] = agentProfileTableColumns,
): number[] {
  return columns.map((column) => Math.max(
    stringWidth(column.header),
    ...rows.map((row) => stringWidth(row.cells[column.key] ?? "")),
  ));
}

export function agentProfileHeaderLine(
  widths: readonly number[],
  columns: readonly AgentProfileColumn[] = agentProfileTableColumns,
): string {
  return columns.map((column, index) =>
    padCell(column.header, widths[index] ?? stringWidth(column.header), column.align)
  ).join("  ");
}

export function agentProfileRowLine(
  row: AgentProfilePresentationRow,
  widths: readonly number[],
  columns: readonly AgentProfileColumn[] = agentProfileTableColumns,
): string {
  const line = rowCells(row, columns).map((value, index) =>
    padCell(value || " ", widths[index] ?? stringWidth(value), columns[index]?.align ?? "left")
  ).join("  ");
  if (row.active) return styled(ansi.inverse, line);
  return row.muted ? styled(ansi.gray, line) : line;
}

export function renderAgentProfileTable(
  rows: readonly AgentProfilePresentationRow[],
  columns: readonly AgentProfileColumn[] = agentProfileTableColumns,
): string {
  if (!rows.length) return "No saved profiles.";
  const table = new Table({
    head: columns.map(({ header }) => header),
    colAligns: columns.map(({ align }) => align),
    style: { head: [], border: [] },
    wordWrap: false,
  });
  for (const row of rows) {
    const cells = rowCells(row, columns);
    table.push(row.active
      ? cells.map((cell) => styled(ansi.inverse, cell))
      : row.muted
      ? cells.map((cell) => styled(ansi.gray, cell))
      : cells);
  }
  return table.toString();
}

interface ProfileChoice {
  value: string;
  name: string;
  description?: string;
  requiresConfirmation: boolean;
  disabledReason?: string;
  active: boolean;
}

const profilePicker = createPrompt<ProfilePickerAction, {
  message: string;
  mode: ProfilePickerMode;
  header: string;
  choices: ProfileChoice[];
  notice?: string;
  default?: string;
  pageSize?: number;
  capabilities: ProfilePickerCapabilities;
}>((config, done) => {
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [activeNoticeValue, setActiveNoticeValue] = useState<string | undefined>(undefined);
  const [finalAction, setFinalAction] = useState<ProfilePickerAction["type"] | undefined>(undefined);
  const initial = config.default
    ? config.choices.findIndex((choice) => choice.value === config.default)
    : -1;
  const [active, setActive] = useState(initial >= 0 ? initial : 0);
  const prefix = usePrefix({ status });
  const choice = config.choices[active]!;

  useKeypress((key) => {
    const keyName = key.name?.toLowerCase();
    if (keyName === "q" || keyName === "escape") {
      setFinalAction("exit");
      setStatus("done");
      done({ type: "exit" });
      return;
    }
    if (config.capabilities.delete && (keyName === "d" || keyName === "delete")) {
      setFinalAction("delete");
      setStatus("done");
      done({ type: "delete", name: choice.value });
      return;
    }
    if (config.capabilities.rename && keyName === "r") {
      setFinalAction("rename");
      setStatus("done");
      done({ type: "rename", name: choice.value });
      return;
    }
    if (isEnterKey(key)) {
      if (config.mode === "list") {
        setFinalAction("exit");
        setStatus("done");
        done({ type: "exit" });
      } else if (choice.active) {
        setActiveNoticeValue(choice.value);
      } else {
        setFinalAction("select");
        setStatus("done");
        done({
          type: "select",
          name: choice.value,
          requiresConfirmation: choice.requiresConfirmation,
          disabledReason: choice.disabledReason,
        });
      }
      return;
    }
    if (isUpKey(key) || isDownKey(key)) {
      const offset = isUpKey(key) ? -1 : 1;
      setActive((active + offset + config.choices.length) % config.choices.length);
      setActiveNoticeValue(undefined);
    }
  });

  const page = usePagination({
    items: config.choices,
    active,
    loop: true,
    pageSize: config.pageSize ?? 7,
    renderItem: ({ item, isActive }) => `${isActive ? "❯" : " "} ${item.name}`,
  });
  if (status === "done") {
    if (finalAction && finalAction !== "select") return "";
    return config.mode === "list" ? config.message : [prefix, config.message].filter(Boolean).join(" ");
  }
  const description = activeNoticeValue === choice.value
    ? `'${choice.value}' is already active.`
    : config.notice ?? choice.description;
  const actions = ["↑↓ navigate"];
  if (config.mode === "use") actions.push("⏎ select");
  if (config.capabilities.rename) actions.push("r rename");
  if (config.capabilities.delete) actions.push("d delete");
  actions.push("q quit");
  const title = config.mode === "list"
    ? config.message
    : [prefix, config.message].filter(Boolean).join(" ");
  return [
    title,
    `  ${config.header}`,
    page,
    description ?? " ",
    styled(ansi.gray, actions.join(" • ")),
  ].filter(Boolean).join("\n").trimEnd() + cursorHide;
});

export async function pickAgentProfileAction(options: {
  rows: readonly AgentProfilePresentationRow[];
  mode: ProfilePickerMode;
  notice?: string;
  default?: string;
  columns?: readonly AgentProfileColumn[];
  capabilities?: ProfilePickerCapabilities;
  pageSize?: number;
}): Promise<ProfilePickerAction> {
  if (!options.rows.length) throw new Error("No saved profiles.");
  const columns = options.columns ?? agentProfileTableColumns;
  const widths = agentProfileColumnWidths(options.rows, columns);
  return await profilePicker({
    mode: options.mode,
    message: options.mode === "use" ? "Select profile" : "Saved profiles",
    header: agentProfileHeaderLine(widths, columns),
    notice: options.notice,
    default: options.default,
    pageSize: options.pageSize,
    capabilities: options.capabilities ?? { delete: true, rename: true },
    choices: options.rows.map((row) => {
      const disabledReason = row.active
        ? "already active"
        : row.selectable
        ? undefined
        : row.disabledReason ?? "not selectable";
      return {
        value: row.id,
        name: agentProfileRowLine(row, widths, columns),
        requiresConfirmation: !row.active && !row.selectable,
        disabledReason: row.disabledReason,
        active: row.active,
        description: disabledReason
          ? styled(
            ansi.yellow,
            row.active ? disabledReason : `confirmation required: ${disabledReason}`,
          )
          : undefined,
      };
    }),
  });
}
