import {
  type SchemaOptions,
  type Static,
  type TLiteral,
  type TSchema,
  Type,
} from "@sinclair/typebox";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * A schema for a result type the command declares in its `result.ts`: it compiles only while
 * the two agree, so the published schema cannot drift from what the command prints.
 */
export function matching<T>() {
  return <S extends TSchema>(schema: S & (Equal<Static<S>, T> extends true ? unknown : never)) =>
    schema;
}

export function outputDocument(command: string, results: Record<string, TSchema>): object {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `output/${command}.json`,
    title: `aireg ${command} --json`,
    description: `The \`data\` each \`aireg ${command}\` action prints under --json, by action.`,
    $defs: results,
  };
}

/** A field a record types `| undefined`, which JSON leaves out: optional in the schema. */
export function absent<T extends TSchema>(schema: T) {
  return Type.Unsafe<Static<T> | undefined>(Type.Optional(schema));
}

/** JSON has no `readonly`; the schema still reads as the domain type it describes. */
export function readonlyArray<T extends TSchema>(item: T) {
  return Type.Unsafe<readonly Static<T>[]>(Type.Array(item));
}

export function readonlyRecord<T extends TSchema>(value: T) {
  return Type.Unsafe<Readonly<Record<string, Static<T>>>>(Type.Record(Type.String(), value));
}

export function oneOf<T extends string>(values: readonly T[], options?: SchemaOptions) {
  return Type.Union(
    values.map((value): TLiteral<T> => Type.Literal(value)),
    options,
  );
}
