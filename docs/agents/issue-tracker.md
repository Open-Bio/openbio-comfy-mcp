# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- Ticket numbers start at `01`
- Comments and conversation history append under a `## Comments` heading

## Publishing to the issue tracker

Create a new file under `.scratch/<feature-slug>/`, creating the directory when needed.

## Fetching a ticket

Read the referenced file directly. The user normally provides its path or issue number.

## Wayfinding operations

- Map: `.scratch/<effort>/map.md`
- Child ticket: `.scratch/<effort>/issues/<NN>-<slug>.md`
- Ticket type: `Type: research|prototype|grilling|task`
- Ticket state: `Status: claimed|resolved`
- Dependencies: `Blocked by: <NN>, <NN>`
- Claim by setting `Status: claimed` before starting
- Resolve by adding an `## Answer`, setting `Status: resolved`, and recording the result in `map.md`
