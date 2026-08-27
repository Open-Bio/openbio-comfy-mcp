# Domain Docs

How engineering skills should consume this repository's domain documentation.

## Before exploring

Read these when they exist:

- `CONTEXT.md` at the repository root
- `CONTEXT-MAP.md` if the repository later becomes multi-context
- Relevant ADRs under `docs/adr/`

If they do not exist, proceed silently. Domain-modeling flows create them lazily when terminology or decisions are actually resolved.

## Layout

This is a single-context repository:

```
/
├── CONTEXT.md
└── docs/
    └── adr/
```

## Vocabulary

Use terminology defined in `CONTEXT.md`. Avoid synonyms that the glossary explicitly rejects.

If a required concept is absent, reconsider whether new terminology is necessary or record the gap for domain modeling.

## ADR conflicts

If proposed work contradicts an existing ADR, identify the conflicting ADR explicitly instead of silently overriding it.
