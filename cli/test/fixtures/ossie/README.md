# Ossie sample models

Test fixtures for the `semantic_model` kind. Copied unchanged from apache/ossie `main` at `7a8de20` (30 Oct 2026). Apache-2.0; license headers kept.

| File | Source | Against `ossie-schema.json` | Use |
|---|---|---|---|
| `tpcds_semantic_model.yaml` | `examples/` | valid: 5 datasets, 8 metrics, `description` and `ai_context` | main fixture |
| `flights.semantic_model.yaml` | `examples/` | valid: 6 datasets, no metrics, no `description` | fixture for the optional `description` |
| `invalid-flights-ontology.yaml` | `examples/flights.yaml` | fails: no `datasets` (it's an ontology document) | negative fixture for publish validation |
| `tpcds_semantic_model.v0.1.1.yaml` | `examples/` at tag `osi-0.1.1-rc1` | the 0.1.1 shape: one model inside a `semantic_model` list | fixture for the released version |
| `ossie-schema.json` | `core-spec/` | the schema itself | validator input |

The files from `main` declare `version: 0.2.0.dev0`, which is unreleased. 0.1.1 is the only release, and each version's examples fail the other's schema.
