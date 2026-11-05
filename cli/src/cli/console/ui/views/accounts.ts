import type { ReactElement } from "react";
import { plural } from "#adapter/text.ts";
import { box, dim, faint, heading, plain, text } from "#cli/console/ui/elements.ts";
import { underHome } from "#cli/render/home.ts";
import type { AccountRow, ConsoleState } from "#core/console/model.ts";
import { pad } from "#core/term/format.ts";
import { COLOR, GLYPH } from "#core/term/theme.ts";

export function accountsView(props: {
  width: number;
  state: ConsoleState;
  cursor: number;
}): ReactElement {
  return box(
    { flexDirection: "column", width: props.width },
    heading("registries"),
    box(
      { marginTop: 1, flexDirection: "column" },
      ...props.state.accounts.map((account, index) =>
        box(
          { key: account.id },
          accountBlock(account, index === props.cursor, account.id === props.state.account?.id),
        ),
      ),
    ),
    props.state.accounts.length === 0
      ? box(null, faint("   No accounts. Run `aireg auth login <registry>` to add one."))
      : plain(""),
  );
}

function accountBlock(account: AccountRow, selected: boolean, active: boolean): ReactElement {
  return box(
    { flexDirection: "column", marginBottom: 1 },
    box(
      { ...(selected ? { backgroundColor: COLOR.selection } : {}) },
      text(
        { color: active ? COLOR.green : COLOR.faint },
        `   ${active ? GLYPH.bullet : GLYPH.hollow} `,
      ),
      text({ color: COLOR.white, bold: true }, pad(account.registry, 42)),
      account.signIn
        ? text(
            { color: account.signedIn ? COLOR.green : COLOR.red },
            pad(account.signedIn ? "signed in" : "signed out", 14),
          )
        : dim(pad("no sign-in", 14)),
    ),
    box(null, dim(`       ${pad("address", 13)}`), text({ color: COLOR.white }, account.address)),
    ...(account.signIn ? [credentialLine(account)] : []),
    box(
      null,
      dim(`       ${pad("publishes to", 13)}`),
      text({ color: COLOR.white }, pad(account.defaultNamespace ?? "nothing set", 30)),
      dim(
        account.artifactCount === 0
          ? "nothing installed yet"
          : `${plural(account.artifactCount, "artifact")} · ${plural(account.namespaceCount, "namespace")}`,
      ),
    ),
  );
}

/** Where the sign-in is kept, which `auth list` does not say. */
function credentialLine(account: AccountRow): ReactElement {
  return box(
    null,
    dim(`       ${pad("credential", 13)}`),
    account.credentialsFile === undefined
      ? text({ color: COLOR.red }, "signed out")
      : text({ color: COLOR.green }, underHome(account.credentialsFile)),
  );
}
