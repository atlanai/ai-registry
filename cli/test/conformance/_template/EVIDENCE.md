# <Target> evidence

Every path, variable, detection signal, file format and command in `src/targets/<id>.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the target's official documentation: the exact sentence, its URL and the date it was read;
2. the target's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the target: the command run, the target version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/targets/<id>.json` and `<id>.test.ts` match this file exactly.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The target's own commands that list what aireg placed, and what each printed.

## Left out

Each mapping the definition does not make, and why.
