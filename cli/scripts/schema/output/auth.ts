import { Type } from "@sinclair/typebox";
import type {
  AuthAccountId,
  AuthList,
  AuthLogin,
  ListedAccount,
} from "#cli/commands/auth/result.ts";
import type { Account } from "#core/config/model.ts";
import { matching, outputDocument } from "./match.ts";

const AccountFields = {
  id: Type.String(),
  registry: Type.String({ description: "The registry's name in your manifests." }),
  defaultNamespace: Type.Optional(Type.String()),
};

const AccountObject = matching<Account>()(
  Type.Object(AccountFields, { additionalProperties: false }),
);

const Listed = matching<ListedAccount>()(
  Type.Object(
    {
      ...AccountFields,
      signedIn: Type.Boolean(),
      needsSignIn: Type.Boolean({
        description: "False for a registry aireg does not sign in to, such as a folder or git.",
      }),
    },
    { additionalProperties: false },
  ),
);

const List = matching<AuthList>()(
  Type.Object({ accounts: Type.Array(Listed) }, { additionalProperties: false }),
);

const Login = matching<AuthLogin>()(
  Type.Object(
    {
      account: AccountObject,
      identity: Type.Optional(
        Type.Object(
          { name: Type.String(), account: Type.Optional(Type.String()) },
          {
            additionalProperties: false,
            description: "Who the registry says signed in, when it says.",
          },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

const AccountId = matching<AuthAccountId>()(
  Type.Object({ accountId: Type.String() }, { additionalProperties: false }),
);

export const OUTPUT = outputDocument("auth", {
  list: List,
  login: Login,
  logout: AccountId,
  remove: AccountId,
});
