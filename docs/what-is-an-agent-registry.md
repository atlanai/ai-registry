# What is an agent registry?

Skills and agent definitions hold your team's know-how, such as how you review code, which data to trust, and how you ship. However, they change often, so every user ends up with their own copy, every one of their coding agents has a different version, and every agent follows a slightly different workflow. It's also difficult to discover and share new versions, and retire artifacts that aren't used or valid anymore.

An agent registry stores your organization's AI artifacts and manages their lifecycle. It's the source of truth for the skills and agents your teams share, so everyone works from the same verified version of each skill and agent, no matter what team they're on or coding agent they use.

With an agent registry, you:

- Store your skills and agents in one place, and keep every version of each.
- Install the same verified version into every coding agent, on every machine.
- Sync everyone's coding agents to ensure they have the latest changes to any artifacts you update.
- Retire artifacts you don't need anymore, to keep artifact sprawl in check.

## Why an open specification?

Registries today are often tied to one ecosystem or one vendor's storage, so only that vendor's tools can read your artifacts, and moving them means a migration.

ai-registry is an open standard for anyone to build an agent registry to manage the lifecycle of all their AI artifacts, using infrastructure they already have, and ensure everyone's coding agents use the same verified artifacts.

An open standard changes two things:

- **Open format:** Today each registry, and each coding agent's own store, has its own format for versions, ownership and approvals, so every client needs a connector per registry. With an open specification, a client integrates once, reads any registry that implements it, and installs into any downstream target.
- **Open storage:** Today a registry is tied to its own storage, so its records can only be read through that registry's software. With an open specification, a registry is just a set of files in a defined layout, so you can build one on infrastructure you already have, such as a git repository or an object storage bucket. The aireg CLI reads registries in folders and git repositories today.

!!! note "If you work with data"
    This specification does for agent registries what open table formats did for analytics. Tables used to live inside proprietary data warehouses, readable only through the vendor's engine. With an open table format such as Iceberg, you store data once in a data lakehouse, and any engine that supports the format can read it.

## Where to go next

<div class="grid cards" markdown>

-   **Teams and organisations**

    ---

    One registry for a whole company.

    [:octicons-arrow-right-24: Teams and organisations](use-cases/teams.md)

-   **Individuals**

    ---

    One person, several coding agents and machines.

    [:octicons-arrow-right-24: Individuals](use-cases/individuals.md)

-   **Quickstart**

    ---

    Build your own registry, from install to background sync.

    [:octicons-arrow-right-24: Quickstart](quickstart.md)

</div>
