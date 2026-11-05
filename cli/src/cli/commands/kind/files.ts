import { isDeviceName } from "#adapter/filespec/names.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

/** `aireg registry validate` refuses this, so the person must fill it in. */
export const PLACEHOLDER = "TODO";

/** Copies that never write over anything, so a file already there is a conflict, not lost. */
export const FRESH = { recursive: true, errorOnExist: true, force: false } as const;

/** Accepted by the grammar, but no Windows checkout could hold it. */
export function refuseDevice(name: string): void {
  if (!isDeviceName(name)) return;
  throw new AiregError(`${quoted(name)} is a device name on Windows.`, {
    code: ErrorCode.Usage,
    hint: "Choose another name; con, prn, aux, nul, com1 to com9 and lpt1 to lpt9 cannot be folder names on Windows.",
  });
}
